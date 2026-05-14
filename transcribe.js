// Принимает видеофайл (base64) и загружает в AssemblyAI
export const config = { api: { bodyParser: { sizeLimit: '100mb' } } }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const apiKey = process.env.ASSEMBLYAI_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY не задан в Vercel' })

  try {
    const { fileBase64, fileName } = req.body
    // Конвертируем base64 → Buffer
    const buf = Buffer.from(fileBase64, 'base64')

    // 1. Загружаем файл в AssemblyAI
    const upRes = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/octet-stream' },
      body: buf,
    })
    if (!upRes.ok) {
      const txt = await upRes.text()
      throw new Error(`Upload error ${upRes.status}: ${txt.slice(0, 200)}`)
    }
    const { upload_url } = await upRes.json()

    // 2. Запускаем транскрипцию
    const trRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: upload_url, language_detection: true }),
    })
    if (!trRes.ok) {
      const txt = await trRes.text()
      throw new Error(`Transcript start error ${trRes.status}: ${txt.slice(0, 200)}`)
    }
    const { id } = await trRes.json()
    res.json({ id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
