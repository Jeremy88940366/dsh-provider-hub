import { postStreamed, CODE } from './src/http.js'
import { sessionForConversation, endpointFor, wireFor, applyFingerprint } from './src/upstream.js'
const ids = ['flint-40b-free', 'longcat-2.5-preview-free', 'jev-1.13-free', 'beam-free']
for (const id of ids) {
  const wire = wireFor(id)
  const body = { model: id, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], stream: true, max_tokens: 16 }
  applyFingerprint(body, wire === 'responses' ? true : wire === 'messages' ? 'claude' : false)
  try {
    await postStreamed({ path: endpointFor(id), body, session: sessionForConversation('diag:' + id),
      attributionUserAgent: 'probe', timeoutMs: 45000, onData: () => {} })
    console.log(id, '→ OK')
  } catch (e) {
    console.log(id, '→ code=', e?.code, '| status=', e?.status, '| unavailable=', e?.unavailable, '| msg=', String(e?.message ?? '').slice(0, 120))
  }
}
