export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()
  const apiKey = process.env.ASSEMBLYAI_API_KEY
  const { id } = req.query
  if (!id) return res.status(400).json({ error: 'id required' })

  try {
    const r = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: apiKey },
    })
    const data = await r.json()
    res.json({ status: data.status, text: data.text || '', error: data.error })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
