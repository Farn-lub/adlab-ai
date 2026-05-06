export const config = { api: { bodyParser: { sizeLimit: '20mb' } } }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel env' })
  const { messages, system, max_tokens = 4000 } = req.body
  try {
    const body = { model: 'claude-sonnet-4-20250514', max_tokens, messages }
    if (system) body.system = system
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error?.message || 'Claude error ' + r.status)
    res.json({ text: data.content?.map(x => x.text || '').join('').trim() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
