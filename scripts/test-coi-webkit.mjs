import { webkit, chromium } from 'playwright'

const URL = process.argv[2] || 'https://f94795cd.zklogin-poc.pages.dev'

async function testCOI(browserType, name) {
  const browser = await browserType.launch({ headless: true })
  const page = await browser.newPage()
  const issues = []
  
  page.on('response', res => {
    const ct = res.headers()['content-type'] || ''
    const coep = res.headers()['cross-origin-embedder-policy']
    const coop = res.headers()['cross-origin-opener-policy']
    if (res.status() >= 400) issues.push(`HTTP ${res.status()}: ${res.url()}`)
    // Log subresources missing COEP/COOP
    const url = res.url()
    if (url !== URL && url !== URL + '/' && !coep && !coop && !url.includes('data:')) {
      issues.push(`MISSING COEP: ${url} (${ct.slice(0,50)})`)
    }
  })
  page.on('requestfailed', req => issues.push(`FAILED: ${req.url()} — ${req.failure()?.errorText}`))
  page.on('pageerror', err => issues.push(`ERR: ${err.message}`))

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 20000 })

  const result = await page.evaluate(() => {
    // Check all script/link/img elements
    const resources = []
    document.querySelectorAll('script[src], link[href]').forEach(el => {
      resources.push(el.tagName + ': ' + (el.src || el.href))
    })
    return {
      crossOriginIsolated: window.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      resources,
    }
  })

  await browser.close()
  return { name, ...result, issues }
}

const wk = await testCOI(webkit, 'WebKit')
console.log(JSON.stringify(wk, null, 2))

const chr = await testCOI(chromium, 'Chromium')
console.log(JSON.stringify(chr, null, 2))
