import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { keccak256, toBytes } from 'viem'

function loadEnvLocal() {
  const path = resolve(import.meta.dirname, '..', 'apps/web/.env.local')
  const content = readFileSync(path, 'utf8')
  return Object.fromEntries(
    content.split('\n')
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        const eq = line.indexOf('=')
        return [line.slice(0, eq), line.slice(eq + 1)]
      })
  )
}

const clientId = process.env.GOOGLE_CLIENT_ID || loadEnvLocal().VITE_GOOGLE_CLIENT_ID
if (!clientId || clientId === 'replace.apps.googleusercontent.com') {
  throw new Error('GOOGLE_CLIENT_ID is required. Set it via env or apps/web/.env.local')
}
console.log(keccak256(toBytes(`zklogin-native-wallet-v1|${clientId}|kernel-index=0`)))
