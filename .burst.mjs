import { postStreamed } from './src/http.js'
import { sessionForConversation, endpointFor, wireFor, applyFingerprint } from './src/upstream.js'
const id = 'deepseek-v4.1-flash-free'
async function one() {
  const wire = wireFor(id)
  const body = { model: id, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], stream: true, max_tokens: 16 }
  applyFingerprint(body, wire === 'responses' ? true : wire === 'messages' ? 'claude' : false)
  try { await postStreamed({ path: endpointFor(id), body, session: sessionForConversation('b:'+Math.random()),
    attributionUserAgent: 'probe', timeoutMs: 60000, onData: () => {} }); return 'OK' }
  catch (e) { return String(e?.code ?? 'ERR') }
}
const out = []
for (let i = 0; i < 12; i++) out.push(await one())
console.log('连续 12 次探测:', out.join(' '))
console.log('限流次数:', out.filter(x => x !== 'OK').length)
