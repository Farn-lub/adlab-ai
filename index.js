import { useState, useRef, useCallback } from 'react'

// ─── API helpers ──────────────────────────────────────────────────────────────
async function apiClaude(messages, system = '', max_tokens = 4000) {
  const r = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, system, max_tokens }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'Claude error')
  return d.text
}

function tryJSON(txt) {
  const s = txt.replace(/```(?:json)?\n?/g, '').trim()
  try { return JSON.parse(s) } catch {}
  const m = s.match(/[\[{][\s\S]*[\]}]/)
  if (m) try { return JSON.parse(m[0]) } catch {}
  return null
}

async function toB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result.split(',')[1])
    r.onerror = rej
    r.readAsDataURL(file)
  })
}

function extractFrames(file, count = 6) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'auto'; video.muted = true; video.playsInline = true
    let resolved = false
    const done = frames => { if (resolved) return; resolved = true; URL.revokeObjectURL(url); resolve(frames) }
    const frames = []; let idx = 0
    const positions = [0.01, 0.15, 0.3, 0.5, 0.75, 0.96]
    const labels = ['Начало', 'Разгон', 'Проблема', 'Середина', 'Кульминация', 'CTA']
    const grab = () => {
      try {
        const c = document.createElement('canvas')
        const sc = Math.min(1, 640 / (video.videoWidth || 640))
        c.width = Math.round((video.videoWidth || 640) * sc)
        c.height = Math.round((video.videoHeight || 360) * sc)
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height)
        return c.toDataURL('image/jpeg', 0.75).split(',')[1]
      } catch { return null }
    }
    const seekNext = () => {
      if (idx >= positions.length) { done(frames); return }
      video.currentTime = Math.max(0, positions[idx] * (video.duration || 1))
    }
    video.onseeked = () => { const b = grab(); if (b) frames.push({ t: video.currentTime, b64: b, label: labels[idx] }); idx++; seekNext() }
    video.onloadeddata = seekNext
    setTimeout(() => { if (!resolved) { const b = grab(); if (b && !frames.length) frames.push({ t: 0, b64: b, label: 'Кадр' }); done(frames) } }, 12000)
    video.onerror = () => done([])
    video.src = url; video.load()
  })
}

// ─── DropZone ─────────────────────────────────────────────────────────────────
function DropZone({ onFiles, accept, label, hint }) {
  const [over, setOver] = useState(false)
  const ref = useRef()
  const handle = useCallback(e => {
    e.preventDefault(); setOver(false)
    const files = Array.from(e.dataTransfer?.files || e.target?.files || [])
    if (files.length) { onFiles(files); if (ref.current) ref.current.value = '' }
  }, [onFiles])
  return (
    <div className={`dz${over ? ' over' : ''}`}
      onDragOver={e => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={handle}
      onClick={() => ref.current?.click()}>
      <input ref={ref} type="file" accept={accept} multiple onChange={handle} />
      <span className="dz-ico">🎬</span>
      <div className="dz-ttl">{label}</div>
      <div className="dz-sub">{hint}</div>
    </div>
  )
}

// ─── VIDEO LAB ────────────────────────────────────────────────────────────────
function VideoLab({ onVideoReady }) {
  const [file, setFile] = useState(null)
  const [info, setInfo] = useState(null)
  const [frames, setFrames] = useState([])
  const [transcript, setTranscript] = useState('')
  const [translation, setTranslation] = useState('')
  const [analysis, setAnalysis] = useState('')
  const [mode, setMode] = useState('assemblyai')
  const [loading, setLoading] = useState(false)
  const [loadMsg, setLoadMsg] = useState('')
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState('')

  const copy = (txt, k) => { navigator.clipboard.writeText(txt); setCopied(k); setTimeout(() => setCopied(''), 2000) }

  const loadVideo = async files => {
    const f = files[0]; if (!f) return
    setErr(''); setFrames([]); setTranscript(''); setTranslation(''); setAnalysis('')
    setFile(f)

    // Read metadata
    const url = URL.createObjectURL(f)
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => {
      setInfo({ name: f.name, size: (f.size / 1024 / 1024).toFixed(1), duration: Math.round(v.duration), width: v.videoWidth, height: v.videoHeight })
      URL.revokeObjectURL(url)
    }
    v.onerror = () => {
      setInfo({ name: f.name, size: (f.size / 1024 / 1024).toFixed(1), duration: '?', width: '?', height: '?' })
      URL.revokeObjectURL(url)
    }
    v.src = url

    // Extract frames
    setLoadMsg('Извлекаю кадры...')
    const frms = await extractFrames(f, 6)
    setFrames(frms)
    setLoadMsg('')
  }

  const runTranscribe = async () => {
    if (!file) return
    setLoading(true); setErr(''); setTranscript('')
    try {
      setLoadMsg('Конвертирую файл...')
      const fileBase64 = await toB64(file)

      setLoadMsg('Загружаю видео в AssemblyAI (может занять минуту)...')
      const startRes = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileBase64, fileName: file.name }),
      })
      const startData = await startRes.json()
      if (!startRes.ok) throw new Error(startData.error)
      const { id } = startData

      // Poll status
      for (let i = 0; i < 150; i++) {
        await new Promise(r => setTimeout(r, 4000))
        setLoadMsg(`Транскрибирую... (~${(i + 1) * 4}с)`)
        const pollRes = await fetch(`/api/transcribe-status?id=${id}`)
        const pollData = await pollRes.json()
        if (pollData.status === 'completed') {
          setTranscript(pollData.text || '')
          break
        }
        if (pollData.status === 'error') throw new Error('AssemblyAI: ' + pollData.error)
      }
    } catch (e) { setErr(e.message) }
    setLoading(false); setLoadMsg('')
  }

  const runTranslate = async () => {
    if (!transcript.trim()) return
    setLoading(true); setErr('')
    try {
      const txt = await apiClaude(
        [{ role: 'user', content: `Переведи этот рекламный текст на русский. Сохрани стиль, эмоции, агрессивные рекламные формулировки. Верни ТОЛЬКО перевод:\n\n${transcript}` }],
        'Профессиональный переводчик рекламных текстов. Сохраняй стиль и эмоциональность без купюр.'
      )
      setTranslation(txt)
    } catch (e) { setErr(e.message) }
    setLoading(false)
  }

  const runAnalysis = async () => {
    if (!frames.length && !transcript.trim()) return
    setLoading(true); setErr(''); setAnalysis('')
    setLoadMsg('Анализирую видео...')
    try {
      const content = []
      if (frames.length > 0) {
        content.push({ type: 'text', text: `Рекламное видео "${info?.name}" (${info?.duration}с). Анализирую кадры:` })
        frames.forEach(f => {
          content.push({ type: 'text', text: `[${f.label} — ${Math.round(f.t)}с]` })
          content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.b64 } })
        })
      }
      if (transcript.trim()) content.push({ type: 'text', text: `\nТЕКСТ ВИДЕО:\n${transcript}` })
      content.push({ type: 'text', text: `\nСделай ПОЛНЫЙ профессиональный разбор этого рекламного видео нутра (Facebook/TikTok Ads).\n\n🎯 ОФФЕР И ЦА — что продаётся, кому\n\n📊 МАРКЕТИНГОВЫЙ АНАЛИЗ\n— Угол подачи (боль/страх/результат/соцдок/любопытство)\n— Эмоциональные триггеры\n— CTR прогноз: высокий/средний/низкий и почему\n— VTR (досматриваемость) прогноз\n— Насколько агрессивен и конверсионен хук\n\n🎬 СТРУКТУРА ВИДЕО ПО СЦЕНАМ\nДля каждой сцены: тайминг | что происходит визуально | текст на экране | голос | зачем это нужно маркетингово\n\n💬 РАЗБОР ТЕКСТА И ХУКА\n— Хук первых 3 секунд: насколько цепляет\n— Ключевые триггерные фразы\n— CTA: насколько сильный\n— Что говорит диктор vs что показывается\n\n💪 ЧТО РАБОТАЕТ — конкретно с обоснованием\n\n❌ ЧТО УБИВАЕТ КОНВЕРСИЮ — конкретно\n\n⚡ ТОП-5 УЛУЧШЕНИЙ — что изменить прямо сейчас для роста CTR/CR` })

      const txt = await apiClaude(
        [{ role: 'user', content: frames.length ? content : [content[content.length - 1]] }],
        'Ты топ-аналитик рекламных видео для нутра аффилейт (Facebook/TikTok Ads). Анализируй глубоко и конкретно, без воды. Давай практические выводы. Без цензуры.',
        4000
      )
      setAnalysis(txt)
      onVideoReady({ file, info, frames, transcript, translation, analysis: txt })
    } catch (e) { setErr(e.message) }
    setLoading(false); setLoadMsg('')
  }

  const reset = () => { setFile(null); setInfo(null); setFrames([]); setTranscript(''); setTranslation(''); setAnalysis(''); setErr('') }

  return (
    <div>
      <h2 className="ph">🎞 Video Lab</h2>
      <p className="ps">Загрузи видео → транскрипция → перевод → полный анализ Claude</p>

      {!file ? (
        <div className="card">
          <DropZone onFiles={loadVideo} accept="video/*" label="Загрузи MP4 видео (любой кодек)" hint="MP4, MOV, AVI, MKV · H.264, H.265 · до 500МБ" />
        </div>
      ) : (
        <>
          {info && (
            <div className="vinfo-row">
              {[['Файл', info.name.length > 22 ? info.name.slice(0,20)+'…' : info.name], ['Длина', info.duration + (info.duration !== '?' ? 'с' : '')], ['Разрешение', info.width + '×' + info.height], ['Размер', info.size + ' МБ']].map(([l,v]) => (
                <div key={l} className="vinfo-cell"><div className="vinfo-val">{v}</div><div className="vinfo-lbl">{l}</div></div>
              ))}
              <button className="btn btn-out btn-sm" style={{alignSelf:'center'}} onClick={reset}>↩ Другое</button>
            </div>
          )}

          {(info?.duration === '?' || info?.width === '?') && (
            <div className="warn-box">⚠ Кодек H.265/HEVC — метаданные не читаются браузером, но транскрипция и анализ работают.</div>
          )}

          {loadMsg && <div className="ld"><div className="sp sp-lg"/>{loadMsg}</div>}

          {frames.length > 0 && (
            <div className="section">
              <div className="section-ttl" style={{color:'var(--acc4)'}}>🎬 Ключевые кадры</div>
              <div className="frames-strip">
                {frames.map((f,i) => (
                  <div key={i} className="frame-card">
                    <img src={`data:image/jpeg;base64,${f.b64}`} alt={f.label}/>
                    <div className="frame-lbl">{f.label}</div>
                    <div className="frame-lbl">{Math.round(f.t)}с</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Transcription */}
          <div className="section">
            <div className="section-ttl">💬 Транскрипция</div>
            <div style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap'}}>
              {[['assemblyai','🤖 AssemblyAI (авто)'],['manual','✍️ Вручную']].map(([m,l]) => (
                <button key={m} className={`btn btn-sm ${mode===m?'btn-purp':'btn-out'}`} onClick={()=>setMode(m)}>{l}</button>
              ))}
            </div>

            {mode === 'assemblyai' && (
              <div className="card" style={{borderColor:'rgba(71,255,232,.2)'}}>
                <div style={{fontSize:13,color:'var(--t2)',lineHeight:1.6,marginBottom:12}}>
                  AssemblyAI работает с сервера — никаких ограничений браузера. Поддерживает H.265, H.264, любой кодек. Бесплатно 5 часов/месяц.<br/>
                  <span style={{color:'var(--acc2)'}}>Ключ задаётся один раз в Vercel — пользователям вводить ничего не нужно.</span>
                </div>
                <button className="btn btn-cyan" onClick={runTranscribe} disabled={loading}>
                  {loading ? `⟳ ${loadMsg || 'Транскрибирую...'}` : '🎤 Транскрибировать автоматически'}
                </button>
              </div>
            )}

            {mode === 'manual' && (
              <div className="card">
                <label className="lbl">Вставь текст из видео</label>
                <textarea className="ta" rows={7}
                  placeholder={'Вставь речь диктора и/или текст с экрана...\n\nГде взять:\n→ CapCut: Текст → Автосубтитры\n→ YouTube: загрузи приватно → Транскрипция\n→ VK: загрузи приватно → Субтитры'}
                  value={transcript} onChange={e=>setTranscript(e.target.value)}/>
              </div>
            )}

            {transcript.trim() && (
              <div style={{marginTop:12}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                  <span className="lbl" style={{margin:0}}>Оригинальный текст</span>
                  <div style={{display:'flex',gap:6}}>
                    <button className="btn btn-sm btn-out" onClick={()=>copy(transcript,'orig')}>{copied==='orig'?'✓':'⊕ Копировать'}</button>
                    <button className="btn btn-cyan btn-sm" onClick={runTranslate} disabled={loading}>
                      {loading?'⟳ Перевожу...':'🇷🇺 Перевести'}
                    </button>
                  </div>
                </div>
                <div className="transcript-box">{transcript}</div>
              </div>
            )}

            {translation && (
              <div style={{marginTop:12}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                  <span className="lbl" style={{margin:0,color:'var(--acc2)'}}>🇷🇺 Перевод</span>
                  <button className="btn btn-sm btn-out" onClick={()=>copy(translation,'tr')}>{copied==='tr'?'✓':'⊕ Копировать'}</button>
                </div>
                <div className="transcript-box">{translation}</div>
              </div>
            )}
          </div>

          {/* Analysis */}
          <div className="section">
            <div className="section-ttl">◎ Полный анализ</div>
            <div className="section-sub">Claude анализирует кадры{transcript?' и текст':''} — структура, хук, триггеры, что работает</div>
            <button className="btn btn-acc" onClick={runAnalysis} disabled={loading||(!frames.length&&!transcript.trim())}>
              {loading&&loadMsg.includes('Анализ') ? '⟳ Анализирую...' : '◎ Запустить полный анализ'}
            </button>
          </div>

          {analysis && (
            <div className="rcard">
              <div className="rcard-head">
                <span className="rcard-ttl">◎ Полный разбор видео</span>
                <button className="btn btn-sm btn-out" onClick={()=>copy(analysis,'an')}>{copied==='an'?'✓':'⊕ Копировать'}</button>
              </div>
              <div className="rcard-body">{analysis}</div>
            </div>
          )}

          {err && <div className="err">⚠ {err}</div>}
        </>
      )}
    </div>
  )
}

// ─── SCRIPT LAB ───────────────────────────────────────────────────────────────
function ScriptLab({ videoCtx }) {
  const [tone, setTone] = useState('pain')
  const [duration, setDuration] = useState('30')
  const [lang, setLang] = useState('ru')
  const [extra, setExtra] = useState('')
  const [scripts, setScripts] = useState([])
  const [prompts, setPrompts] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState('')

  const copy = (txt, k) => { navigator.clipboard.writeText(txt); setCopied(k); setTimeout(()=>setCopied(''), 2000) }

  const generate = async () => {
    if (!videoCtx?.analysis && !videoCtx?.transcript) { setErr('Сначала загрузи видео и сделай анализ в Video Lab'); return }
    setLoading(true); setErr(''); setScripts([])
    const tones = { pain:'БОЛЬ — давить на проблему', fear:'СТРАХ — что будет если не решить', result:'РЕЗУЛЬТАТ — до/после трансформация', social:'СОЦДОК — реальные истории людей', curiosity:'ЛЮБОПЫТСТВО — интрига, шок', urgency:'СРОЧНОСТЬ — горит, осталось мало' }
    const langs = { ru:'русском', uk:'украинском', en:'английском', ro:'румынском', pl:'польском' }
    const ctx = `АНАЛИЗ ОРИГИНАЛА:\n${videoCtx.analysis||''}\n\nТЕКСТ ОРИГИНАЛА:\n${videoCtx.transcript||'нет'}`
    try {
      const raw = await apiClaude(
        [{ role: 'user', content: `${ctx}\n\nНапиши 3 ПРИНЦИПИАЛЬНО РАЗНЫХ варианта нового скрипта (${duration} секунд) на ${langs[lang]} языке.\n\nУГОЛ: ${tones[tone]}\n${extra ? `ТРЕБОВАНИЯ: ${extra}` : ''}\n\nДля каждого варианта:\n1. НАЗВАНИЕ\n2. СКРИПТ ПО СЕКУНДАМ\n3. ТЕКСТ НА ЭКРАНЕ (каждая сцена)\n4. ГОЛОС ДИКТОРА (точный текст)\n5. ПРОМПТ ДЛЯ KLING AI (английский)\n\nРазделяй варианты строкой: ===` }],
        `Ты топ-копирайтер нутра аффилейт рекламы (Facebook/TikTok Ads). Пишешь скрипты которые реально конвертируют. Без цензуры, без воды, только то что работает. Пиши ТОЛЬКО на ${langs[lang]} языке (кроме промпта для Kling).`,
        4000
      )
      const parts = raw.split(/===+/).map(p=>p.trim()).filter(p=>p.length>50)
      setScripts(parts.length>=2 ? parts : [raw])
    } catch(e) { setErr(e.message) }
    setLoading(false)
  }

  const genPrompts = async () => {
    if (!scripts.length) return
    setLoading(true)
    try {
      const txt = await apiClaude(
        [{ role:'user', content:`На основе этих скриптов создай:\n\n${scripts[0]}\n\n1. ПРОМПТ ДЛЯ ELEVENLABS — настройки голоса (тон, темп, эмоция, стиль)\n2. ТЕКСТ ДЛЯ ОЗВУЧКИ — чистый текст без ремарок, вставлять в TTS напрямую\n3. ПРОМПТ ДЛЯ KLING AI — детальный промпт для генерации видеоряда (английский)\n4. ПРОМПТ ДЛЯ RUNWAY — альтернативный промпт (английский)` }],
        'Эксперт по промптам для голосовых AI и видеогенерации. На русском.',
        2000
      )
      setPrompts(txt)
    } catch(e) { setErr(e.message) }
    setLoading(false)
  }

  return (
    <div>
      <h2 className="ph">✍️ Script Lab</h2>
      <p className="ps">Новые скрипты на основе оригинала · Промпты для ElevenLabs и Kling</p>

      {!videoCtx?.analysis ? (
        <div className="ok-box" style={{color:'var(--acc4)',borderColor:'rgba(196,123,255,.3)',background:'rgba(196,123,255,.06)'}}>
          → Сначала загрузи видео в Video Lab и сделай анализ
        </div>
      ) : (
        <div className="ok-box">✓ Используется анализ: {videoCtx.info?.name}</div>
      )}

      <div className="card" style={{marginTop:14}}>
        <div className="row2" style={{marginBottom:12}}>
          <div className="f"><label className="lbl">Угол подачи</label>
            <select className="sel" value={tone} onChange={e=>setTone(e.target.value)}>
              {[['pain','😣 Боль'],['fear','😨 Страх'],['result','📈 Результат/До-После'],['social','👥 Соцдок'],['curiosity','🤔 Любопытство'],['urgency','⏰ Срочность']].map(([v,l])=><option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="f"><label className="lbl">Длина</label>
            <select className="sel" value={duration} onChange={e=>setDuration(e.target.value)}>
              {[['15','15с — TikTok/Reels'],['30','30с — Facebook стандарт'],['60','60с — длинный формат']].map(([v,l])=><option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
        <div className="row2" style={{marginBottom:12}}>
          <div className="f"><label className="lbl">Язык скрипта</label>
            <select className="sel" value={lang} onChange={e=>setLang(e.target.value)}>
              {[['ru','🇷🇺 Русский'],['uk','🇺🇦 Українська'],['en','🇬🇧 English'],['ro','🇷🇴 Română'],['pl','🇵🇱 Polski']].map(([v,l])=><option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="f"><label className="lbl">Доп. требования</label>
            <input className="inp" placeholder="Добавь скидку 50%, упомяни врача..." value={extra} onChange={e=>setExtra(e.target.value)}/>
          </div>
        </div>
        <button className="btn btn-acc" onClick={generate} disabled={loading}>
          {loading?'⟳ Генерирую...':'✍️ Написать 3 варианта скрипта'}
        </button>
      </div>

      {loading && <div className="ld"><div className="sp sp-lg"/>Пишу скрипты без ограничений...</div>}
      {err && <div className="err">⚠ {err}</div>}

      {scripts.map((s,i) => (
        <div key={i} className="script-block">
          <div className="script-head">
            <span className="script-head-ttl">Вариант {i+1}</span>
            <button className="btn btn-sm btn-out" onClick={()=>copy(s,'s'+i)}>{copied==='s'+i?'✓':'⊕ Копировать'}</button>
          </div>
          <div className="script-body">{s}</div>
        </div>
      ))}

      {scripts.length > 0 && (
        <>
          <div className="divider"/>
          <button className="btn btn-purp" onClick={genPrompts} disabled={loading}>
            {loading?'⟳ Генерирую...':'🎙 Промпты для ElevenLabs + Kling'}
          </button>
          {prompts && (
            <div className="rcard" style={{borderColor:'rgba(196,123,255,.25)'}}>
              <div className="rcard-head" style={{background:'rgba(196,123,255,.05)',borderColor:'rgba(196,123,255,.1)'}}>
                <span className="rcard-ttl" style={{color:'var(--acc4)'}}>🎙 Промпты для генерации</span>
                <button className="btn btn-sm btn-out" onClick={()=>copy(prompts,'pr')}>{copied==='pr'?'✓':'⊕ Копировать'}</button>
              </div>
              <div className="rcard-body">{prompts}</div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── LIBRARY ──────────────────────────────────────────────────────────────────
let uid = 1
function Library() {
  const [items, setItems] = useState([])
  const [sel, setSel] = useState([])
  const [result, setResult] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState('')

  const copy = (txt,k) => { navigator.clipboard.writeText(txt); setCopied(k); setTimeout(()=>setCopied(''),2000) }

  const addFiles = async files => {
    for (const f of files.filter(f=>f.type.startsWith('image/'))) {
      const id = uid++
      const url = URL.createObjectURL(f)
      setItems(p=>[...p,{id,name:f.name,url,ctr:'',roi:'',analysis:null,loading:true}])
      const b64 = await toB64(f)
      apiClaude(
        [{role:'user',content:[{type:'image',source:{type:'base64',media_type:f.type,data:b64}},{type:'text',text:'Рекламный крео нутра Facebook. ТОЛЬКО JSON:\n{"hook":"хук 1 предложение","angle":"боль/страх/результат/соцдок/любопытство","emotion":"эмоция","ctr_forecast":"высокий/средний/низкий","strengths":["плюс1","плюс2"],"weaknesses":["минус1"],"recommendation":"1 изменение для роста CTR","ab_variants":"2 A/B теста"}'}]}],
        'Эксперт нутра-рекламы. Кратко и конкретно. ТОЛЬКО JSON.',700
      ).then(raw=>{
        const a = tryJSON(raw)
        setItems(p=>p.map(x=>x.id===id?{...x,analysis:a,loading:false}:x))
      }).catch(()=>{
        setItems(p=>p.map(x=>x.id===id?{...x,loading:false}:x))
      })
    }
  }

  const del = id => { setItems(p=>p.filter(x=>x.id!==id)); setSel(p=>p.filter(x=>x!==id)) }
  const toggle = id => setSel(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id])
  const setMeta = (id,k,v) => setItems(p=>p.map(x=>x.id===id?{...x,[k]:v}:x))

  const selItems = items.filter(x=>sel.includes(x.id))
  const targets = selItems.length>=2 ? selItems : items.filter(x=>x.analysis)
  const winners = items.filter(x=>parseFloat(x.roi)>30||x.analysis?.ctr_forecast==='высокий')

  const analyze = async () => {
    if (targets.length<2) return
    setLoading(true); setResult(''); setErr('')
    const rows = targets.map((x,i)=>{const a=x.analysis||{};return `${i+1}. "${x.name}" хук="${a.hook}" угол=${a.angle} CTR=${a.ctr_forecast} real_CTR=${x.ctr||'?'}% ROI=${x.roi||'?'}% плюсы:${(a.strengths||[]).join(';')} минусы:${(a.weaknesses||[]).join(';')}`}).join('\n\n')
    try {
      const txt = await apiClaude(
        [{role:'user',content:`Паттерны нутра-крео:\n\n${rows}\n\n🏆 ТОП КРЕ — с цифрами\n🔍 ПАТТЕРНЫ ПОБЕДИТЕЛЕЙ — угол, эмоция, хук\n❌ АНТИПАТТЕРНЫ — что убивает CTR\n🎯 ФОРМУЛА ПОБЕДИТЕЛЯ\n🧪 ТОП-5 ГИПОТЕЗ ДЛЯ ТЕСТОВ\n📈 ЧТО МАСШТАБИРОВАТЬ`}],
        'Аналитик нутра Facebook Ads. Конкретно, с цифрами, без воды. На русском.',3000
      )
      setResult(txt)
    } catch(e) { setErr(e.message) }
    setLoading(false)
  }

  const genBrief = async () => {
    const w = (selItems.length?selItems:winners).filter(x=>x.analysis)
    if (!w.length) { setErr('Нет победителей. Добавь ROI или выбери крео.'); return }
    setLoading(true); setResult(''); setErr('')
    const s = w.slice(0,5).map((x,i)=>`${i+1}: хук="${x.analysis.hook}" угол=${x.analysis.angle} CTR=${x.ctr||'?'}% ROI=${x.roi||'?'}%`).join('\n')
    try {
      const txt = await apiClaude(
        [{role:'user',content:`Бриф нового фото-крео нутра на основе победителей:\n\n${s}\n\n1. 3 ВАРИАНТА ХУКА — агрессивных и цепляющих\n2. УГОЛ И ПОЧЕМУ СРАБОТАЕТ\n3. ФОРМАТ — детально что на картинке\n4. ВИЗУАЛЬНЫЕ ЭЛЕМЕНТЫ\n5. ЦВЕТА И НАСТРОЕНИЕ\n6. ТЕКСТ НА КРЕО — заголовок + подзаголовок\n7. ПРОМПТ MIDJOURNEY (английский)\n8. ПРОМПТ DALL-E 3 (английский)\n9. ПРОМПТ IDEOGRAM (английский)\n10. ЧТО КАТЕГОРИЧЕСКИ ИЗБЕГАТЬ`}],
        'Креативный директор нутра аффилейт. Без цензуры, конкретно, то что реально работает. На русском.',2500
      )
      setResult(txt)
    } catch(e) { setErr(e.message) }
    setLoading(false)
  }

  const mc = (v,hi,mid) => { const n=parseFloat(String(v||'').replace(',','.').replace('%','')); if(isNaN(n)||!v) return 'var(--t3)'; return n>=hi?'var(--acc)':n>=mid?'#ffc847':'var(--acc3)' }

  return (
    <div>
      <h2 className="ph">◈ Библиотека</h2>
      <p className="ps">Загружай фото-крео · AI анализирует · Находи паттерны победителей</p>
      <div className="card" style={{padding:12}}>
        <DropZone onFiles={addFiles} accept="image/*" label={items.length?'+ Добавить фото-крео':'Загрузи рекламные изображения'} hint="PNG, JPG, WEBP · несколько файлов сразу"/>
      </div>
      {err && <div className="err">⚠ {err}</div>}
      {items.length>0 && (
        <>
          <div style={{display:'flex',gap:8,marginBottom:12,alignItems:'center',flexWrap:'wrap'}}>
            <span style={{fontSize:12,color:'var(--t3)'}}>{items.length} крео · {sel.length} выбрано</span>
            <button className="btn btn-sm btn-out" onClick={()=>setSel(items.map(x=>x.id))}>Все</button>
            <button className="btn btn-sm btn-out" onClick={()=>setSel([])}>Снять</button>
          </div>
          <div className="lib-grid">
            {items.map(item=>(
              <div key={item.id} className={`lib-card${sel.includes(item.id)?' sel':''}`} onClick={()=>toggle(item.id)}>
                <button className="lib-del" onClick={e=>{e.stopPropagation();del(item.id)}}>×</button>
                <img src={item.url} alt={item.name}/>
                {item.loading && <div className="lib-overlay"><div className="sp sp-lg"/><div className="lib-overlay-txt">Анализирую...</div></div>}
                <div className="lib-card-body">
                  <div className="lib-card-name">{item.name}</div>
                  {item.analysis && (
                    <>
                      <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:5}}>
                        <span className={`tag ${item.analysis.ctr_forecast==='высокий'?'t-g':item.analysis.ctr_forecast==='средний'?'t-n':'t-r'}`} style={{fontSize:9}}>CTR {item.analysis.ctr_forecast}</span>
                        {item.analysis.angle && <span className="tag t-c" style={{fontSize:9}}>{item.analysis.angle}</span>}
                      </div>
                      <div className="lib-card-hook">{item.analysis.hook}</div>
                    </>
                  )}
                  <div className="lib-card-inputs" onClick={e=>e.stopPropagation()}>
                    {[['ctr','CTR %'],['roi','ROI %']].map(([k,p])=>(
                      <input key={k} className="lib-inp" placeholder={p} value={item[k]||''} onChange={e=>setMeta(item.id,k,e.target.value)}/>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{display:'flex',gap:9,marginTop:14,flexWrap:'wrap'}}>
            <button className="btn btn-acc" onClick={analyze} disabled={loading||targets.length<2}>{loading?'⟳ Анализ...':'◎ Паттерны'}</button>
            <button className="btn btn-cyan" onClick={genBrief} disabled={loading}>{loading?'⟳ Генерация...':'✦ Бриф нового крео'}</button>
          </div>
          {loading && <div className="ld"><div className="sp sp-lg"/>Анализирую...</div>}
          {result && (
            <div className="rcard">
              <div className="rcard-head">
                <span className="rcard-ttl">◎ Результат</span>
                <button className="btn btn-sm btn-out" onClick={()=>copy(result,'res')}>{copied==='res'?'✓':'⊕ Копировать'}</button>
              </div>
              <div className="rcard-body">{result}</div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── TEXTS ────────────────────────────────────────────────────────────────────
function Texts() {
  const [f, setF] = useState({offer:'',audience:'',angle:'pain',format:'video_script',lang:'ru'})
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState([])
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState('')
  const upd = (k,v) => setF(p=>({...p,[k]:v}))
  const copy = (txt,k) => { navigator.clipboard.writeText(txt); setCopied(k); setTimeout(()=>setCopied(''),2000) }

  const run = async () => {
    if (!f.offer.trim()) return
    setLoading(true); setErr(''); setResults([])
    const langs = {ru:'русском',uk:'украинском',en:'английском',ro:'румынском',pl:'польском'}
    const angles = {pain:'БОЛЬ — максимально давить на проблему',fear:'СТРАХ — что будет если не решить',curiosity:'ЛЮБОПЫТСТВО — интрига шок неожиданность',social_proof:'СОЦДОК — реальные истории результаты',result:'РЕЗУЛЬТАТ — до/после конкретные цифры трансформация',urgency:'СРОЧНОСТЬ — горит осталось мало успей'}
    const fmts = {
      video_script:'скрипта видео ('+f.lang==='ru'?'':'')+'по секундам: 0-3с хук-крючок, 3-10с боль/проблема, 10-20с решение+продукт, 20-27с доказательство/соцдок, 27-30с агрессивный CTA',
      ad_post:'рекламного поста Facebook/Instagram (150-250 слов, убойный хук первые 2 строки, боль, решение, CTA, эмодзи для привлечения внимания)',
      headline:'заголовков лендинга — H1 (до 8 слов, цепляющий), H2 подзаголовок (до 20 слов), подзаголовок выгоды',
      offer:'коротких офферов-тизеров (2-4 предложения, максимально конверсионно, для баннеров и pre-lander)',
      full_landing:'полного текста лендинга: Убойный хук → Боль → Агитация → Решение → Продукт → Результаты с цифрами → Соцдок → Ответы на возражения → Гарантия → CTA'
    }
    try {
      const raw = await apiClaude(
        [{role:'user',content:`Напиши 3 ПРИНЦИПИАЛЬНО РАЗНЫХ варианта ${fmts[f.format]}.\n\nОФФЕР: ${f.offer}\nЦА: ${f.audience||'Целевая аудитория с данной проблемой'}\nУГОЛ: ${angles[f.angle]}\n\nТребования: агрессивный маркетинг без цензуры, только то что реально конвертирует. Каждый вариант сильно отличается подходом.\n\nJSON: [{"title":"Вариант 1","content":"..."},{"title":"Вариант 2","content":"..."},{"title":"Вариант 3","content":"..."}]`}],
        `Ты топ-копирайтер нутра аффилейт маркетинга (Facebook/TikTok Ads). Пишешь тексты которые реально конвертируют. Без цензуры, без воды, без дисклеймеров. ТОЛЬКО на ${langs[f.lang]} языке. ТОЛЬКО JSON.`,
        4000
      )
      const p = tryJSON(raw)
      if (p && Array.isArray(p)) setResults(p)
      else setErr('Ошибка разбора. Попробуй снова.')
    } catch(e) { setErr(e.message) }
    setLoading(false)
  }

  return (
    <div>
      <h2 className="ph">✦ Тексты</h2>
      <p className="ps">Скрипты видео · Посты · Лендинги · Офферы · Без цензуры</p>
      <div className="card">
        <div className="f"><label className="lbl">Оффер — что продаём</label>
          <textarea className="ta" rows={3} placeholder="Капсулы BioSlim для похудения. Минус 10кг за месяц. Натуральный состав, цена 1990₽, доставка Россия/СНГ" value={f.offer} onChange={e=>upd('offer',e.target.value)}/>
        </div>
        <div className="f"><label className="lbl">Целевая аудитория</label>
          <input className="inp" placeholder="Женщины 35-55 лет, лишний вес, хотят похудеть быстро без диет" value={f.audience} onChange={e=>upd('audience',e.target.value)}/>
        </div>
        <div className="row2">
          <div className="f"><label className="lbl">Угол подачи</label>
            <select className="sel" value={f.angle} onChange={e=>upd('angle',e.target.value)}>
              {[['pain','😣 Боль'],['fear','😨 Страх'],['curiosity','🤔 Любопытство/Шок'],['social_proof','👥 Соцдок'],['result','📈 Результат/До-После'],['urgency','⏰ Срочность']].map(([v,l])=><option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="f"><label className="lbl">Формат</label>
            <select className="sel" value={f.format} onChange={e=>upd('format',e.target.value)}>
              {[['video_script','Скрипт видео (по секундам)'],['ad_post','Рекламный пост (FB/IG)'],['headline','Заголовок лендинга'],['offer','Короткий оффер/тизер'],['full_landing','Полный текст лендинга']].map(([v,l])=><option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
        <div style={{maxWidth:180}} className="f"><label className="lbl">Язык</label>
          <select className="sel" value={f.lang} onChange={e=>upd('lang',e.target.value)}>
            {[['ru','🇷🇺 Русский'],['uk','🇺🇦 Українська'],['en','🇬🇧 English'],['ro','🇷🇴 Română'],['pl','🇵🇱 Polski']].map(([v,l])=><option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <button className="btn btn-acc" onClick={run} disabled={loading||!f.offer.trim()}>{loading?'⟳ Генерирую...':'✦ Написать 3 варианта'}</button>
      </div>
      {loading && <div className="ld"><div className="sp sp-lg"/>Пишу тексты без ограничений...</div>}
      {err && <div className="err">⚠ {err}</div>}
      {results.map((r,i)=>(
        <div key={i} style={{background:'var(--s1)',border:'1px solid var(--bdr)',borderRadius:10,overflow:'hidden',marginBottom:12}}>
          <div style={{padding:'9px 14px',background:'var(--s2)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span style={{fontFamily:'var(--head)',fontSize:10,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'var(--t3)'}}>{r.title}</span>
            <button className="btn btn-sm btn-out" onClick={()=>copy(r.content,'t'+i)}>{copied==='t'+i?'✓':'⊕ Копировать'}</button>
          </div>
          <div style={{padding:14,fontSize:13,lineHeight:1.8,whiteSpace:'pre-wrap'}}>{r.content}</div>
        </div>
      ))}
    </div>
  )
}

// ─── GENERATE ─────────────────────────────────────────────────────────────────
function Generate({ videoCtx }) {
  const SERVICES = [
    {ico:'🎙',name:'ElevenLabs',desc:'Озвучь скрипт AI-голосом. Вставь текст → выбери голос → скачай MP3. Потом накладываешь на видеоряд.',feats:['Текст → Голос','Клонирование голоса','100+ языков','Бесплатный тариф'],url:'https://elevenlabs.io'},
    {ico:'🎬',name:'Kling AI',desc:'Генерация видеоряда по промпту. 66 бесплатных кредитов в день. Поддерживает Video-to-Video.',feats:['Текст → Видео','Video-to-Video','66 кред/день бесплатно'],url:'https://klingai.com'},
    {ico:'🚀',name:'Runway Gen-3',desc:'Профессиональная генерация видео. Редактирование существующего видео с новым контентом.',feats:['Высокое качество','Edit Video','Пробный период'],url:'https://runwayml.com'},
    {ico:'✨',name:'Luma Dream Machine',desc:'30 видео в месяц бесплатно. Хорошо для lifestyle и product видео.',feats:['30 видео/мес бесплатно','Фото → Видео'],url:'https://lumalabs.ai/dream-machine'},
    {ico:'✂️',name:'CapCut Desktop',desc:'Финальный монтаж: склеиваешь видеоряд из Kling + голос из ElevenLabs + музыку.',feats:['Монтаж','Субтитры','AI Enhance','Бесплатно'],url:'https://www.capcut.com'},
  ]

  return (
    <div>
      <h2 className="ph">🚀 Генерация видео</h2>
      <p className="ps">Пошаговый флоу создания нового видео на основе скрипта</p>

      <div className="card" style={{borderColor:'rgba(71,255,232,.2)',marginBottom:20}}>
        <div className="lbl" style={{color:'var(--acc2)',marginBottom:12}}>📋 Флоу создания нового видео</div>
        {[
          ['1','var(--acc)','Script Lab','Напиши новый скрипт → получи промпты для ElevenLabs и Kling'],
          ['2','var(--acc4)','ElevenLabs','Вставь текст диктора → скачай MP3 с голосом'],
          ['3','var(--acc4)','Kling AI','Вставь промпт → сгенерируй видеоряд без звука'],
          ['4','var(--acc2)','CapCut','Сведи: видеоряд + голос + музыка → финальный MP4'],
        ].map(([n,c,ttl,desc])=>(
          <div key={n} style={{display:'flex',gap:12,paddingBottom:n!=='4'?16:0,position:'relative'}}>
            {n!=='4'&&<div style={{position:'absolute',left:13,top:28,bottom:0,width:2,background:'linear-gradient(var(--bdr2),transparent)'}}/>}
            <div style={{width:26,height:26,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',background:c+'22',border:`1.5px solid ${c}44`,color:c,fontFamily:'var(--head)',fontSize:11,fontWeight:800,flexShrink:0}}>{n}</div>
            <div><div style={{fontFamily:'var(--head)',fontSize:13,fontWeight:700,marginBottom:2}}>{ttl}</div><div style={{fontSize:12,color:'var(--t2)'}}>{desc}</div></div>
          </div>
        ))}
      </div>

      {SERVICES.map(svc=>(
        <div key={svc.name} style={{display:'flex',alignItems:'flex-start',gap:14,padding:16,background:'var(--s1)',border:'1px solid var(--bdr2)',borderRadius:10,marginBottom:10,cursor:'pointer',transition:'border-color .2s'}}
          onClick={()=>window.open(svc.url,'_blank')}
          onMouseEnter={e=>e.currentTarget.style.borderColor='var(--acc4)'}
          onMouseLeave={e=>e.currentTarget.style.borderColor='rgba(255,255,255,.11)'}>
          <span style={{fontSize:28,flexShrink:0}}>{svc.ico}</span>
          <div style={{flex:1}}>
            <div style={{fontFamily:'var(--head)',fontSize:14,fontWeight:700,marginBottom:4}}>{svc.name}</div>
            <div style={{fontSize:12,color:'var(--t2)',lineHeight:1.5,marginBottom:8}}>{svc.desc}</div>
            <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
              {svc.feats.map(f=><span key={f} style={{fontFamily:'var(--mono)',fontSize:9,padding:'2px 7px',borderRadius:3,background:'var(--s2)',color:'var(--t3)'}}>{f}</span>)}
            </div>
          </div>
          <div className="btn btn-purp btn-sm" style={{flexShrink:0,alignSelf:'center'}}>Открыть →</div>
        </div>
      ))}
    </div>
  )
}

// ─── APP ──────────────────────────────────────────────────────────────────────
const TABS = [
  {id:'videolab',ico:'🎞',lbl:'Video Lab'},
  {id:'scriptlab',ico:'✍️',lbl:'Script Lab'},
  {id:'generate',ico:'🚀',lbl:'Генерация'},
  {id:'library',ico:'◈',lbl:'Библиотека'},
  {id:'texts',ico:'✦',lbl:'Тексты'},
]

export default function Home() {
  const [tab, setTab] = useState('videolab')
  const [videoCtx, setVideoCtx] = useState(null)

  return (
    <div className="app">
      <header className="hdr">
        <div className="logo">ADLAB</div>
        <div className="logo-dot">·</div>
        <div className="logo">AI</div>
        {videoCtx?.info && (
          <div className="hdr-pill" style={{borderColor:'rgba(196,123,255,.3)',color:'var(--acc4)'}}>
            🎞 {videoCtx.info.name?.slice(0,18)}
          </div>
        )}
      </header>
      <nav className="nav">
        {TABS.map(t=>(
          <button key={t.id} className={`ntab${tab===t.id?' active':''}`} onClick={()=>setTab(t.id)}>
            {t.ico} {t.lbl}
            {t.id==='scriptlab'&&videoCtx && <span style={{width:6,height:6,borderRadius:'50%',background:'var(--acc)',display:'inline-block'}}/>}
          </button>
        ))}
      </nav>
      <main className="pg">
        {tab==='videolab'  && <VideoLab onVideoReady={ctx=>setVideoCtx(ctx)}/>}
        {tab==='scriptlab' && <ScriptLab videoCtx={videoCtx}/>}
        {tab==='generate'  && <Generate videoCtx={videoCtx}/>}
        {tab==='library'   && <Library/>}
        {tab==='texts'     && <Texts/>}
      </main>
    </div>
  )
}
