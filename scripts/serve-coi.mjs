/**
 * COI Test Server — serves the built app with COOP/COEP headers for local testing.
 *
 * Usage:
 *   pnpm build                         # build the app first
 *   node scripts/serve-coi.mjs         # serves at http://localhost:8787
 *
 * Test pages:
 *   /                  — main app (COI headers)
 *   /coi-test.html     — minimal page that only checks crossOriginIsolated
 *
 * The coi-test.html is served from scripts/ (not public/) so it never
 * gets deployed to production. It's only available via this dev server.
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = 8787
const DIST = 'apps/web/dist'
const SCRIPTS = 'scripts'

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath)
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  res.setHeader('Permissions-Policy', 'cross-origin-isolated=(self)')
  try {
    const data = fs.readFileSync(filePath)
    res.setHeader('Content-Type', mime[ext] || 'application/octet-stream')
    res.end(data)
  } catch {
    res.statusCode = 404
    res.end('Not found')
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`).pathname
  if (url === '/coi-test.html') {
    serveFile(res, path.join(SCRIPTS, 'coi-test.html'))
  } else {
    serveFile(res, path.join(DIST, url === '/' ? '/index.html' : url))
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`))
