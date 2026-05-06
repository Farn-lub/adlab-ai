export const config = { api: { bodyParser: { sizeLimit: '100mb' } } }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const apiKey = process.env.ASSEMBLYAI_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not set in Vercel env' })
  try {
    const { fileBase64 } = req.body
    const buf = Buffer.from(fileBase64, 'base64')
    const upRes = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/octet-stream' },
      body: buf,
    })
    if (!upRes.ok) throw new Error('Upload error ' + upRes.status)
    const { upload_url } = await upRes.json()
    const trRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: upload_url, language_detection: true }),
    })
    if (!trRes.ok) throw new Error('Transcript error ' + trRes.status)
    const { id } = await trRes.json()
    res.json({ id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
