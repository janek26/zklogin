import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const required = ['apps/web/.env.local', 'apps/web/src/generated/jwk-snapshot.json', 'apps/web/src/generated/deployment-sepolia.json']
console.log(`Node ${process.version}`)
console.log(`pnpm ${execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()}`)
function forgeAvailable() {
  try { execFileSync('forge', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}
console.log(`Foundry ${forgeAvailable() ? 'available' : 'not found (optional for Node-based contract tests)'}`)
for (const file of required) console.log(`${existsSync(resolve(root, file)) ? 'OK' : 'MISSING'} ${file}`)
console.log('Run pnpm verify for local checks. Complete the guided setup before attempting live deployment.')
