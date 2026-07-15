import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = 8787
const DIR = 'apps/web/dist'

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

http.createServer((req, res) => {
  const filePath = path.join(DIR, req.url === '/' ? '/index.html' : req.url)
  const ext = path.extname(filePath)
  
  // All responses get COOP/COEP
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
}).listen(PORT, () => console.log(`http://localhost:${PORT}`))
