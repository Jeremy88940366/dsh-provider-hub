import { buildCatalog } from './src/catalog.js'
import fs from 'node:fs'
const stored = JSON.parse(fs.readFileSync('C:/Users/Administrator/.dsh/provider-hub/catalog.json', 'utf8'))
const entries = buildCatalog(stored.entries ?? [])
console.log('defaultMaxTokens(设置) =', JSON.parse(fs.readFileSync('C:/Users/Administrator/.dsh/provider-hub/settings.json','utf8')).defaultMaxTokens)
console.log()
for (const e of entries) {
  console.log(e.id.padEnd(32), 'ctx=', String(e.contextWindow).padStart(8), 'out=', String(e.maxOutput).padStart(7), 'vision=', e.vision)
}
