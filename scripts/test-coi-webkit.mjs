/**
 * COI Verification Script — tests crossOriginIsolated in WebKit + Chromium.
 *
 * Tests both the main app and the minimal coi-test.html page against
 * a Cloudflare Pages preview deployment.
 *
 * Prerequisites:
 *   pnpm install          # playwright is in devDependencies
 *   npx playwright install webkit chromium
 *
 * Usage:
 *   node scripts/test-coi-webkit.mjs [URL]
 *
 *   # Test the stable PR alias:
 *   node scripts/test-coi-webkit.mjs https://feat-coop-coep-cross-browser.zklogin-poc.pages.dev
 *
 *   # Test a specific deploy:
 *   node scripts/test-coi-webkit.mjs https://6906778c.zklogin-poc.pages.dev
 *
 * To test against a local build:
 *   node scripts/serve-coi.mjs &     # start local COI server
 *   node scripts/test-coi-webkit.mjs http://localhost:8787
 */

import { webkit, chromium } from 'playwright'

const URL = process.argv[2] || 'https://feat-coop-coep-cross-browser.zklogin-poc.pages.dev'

async function testCOI(browserType, name) {
  const browser = await browserType.launch({ headless: true })
  const page = await browser.newPage()
  const issues = []
  page.on('requestfailed', req => issues.push(`FAILED: ${req.url()} — ${req.failure()?.errorText}`))
  page.on('pageerror', err => issues.push(`ERR: ${err.message}`))

  // Test main app
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 20000 })
  await page.waitForSelector('.google-signin-btn', { timeout: 5000 }).catch(() => {})
  const main = await page.evaluate(() => {
    const btn = document.querySelector('.google-signin-btn')
    return {
      crossOriginIsolated: window.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      hasButton: !!btn,
      btnBg: btn ? getComputedStyle(btn).backgroundColor : null,
    }
  })

  // Test minimal diagnostic page
  await page.goto(URL + '/coi-test.html', { waitUntil: 'networkidle', timeout: 10000 })
  const min = await page.evaluate(() => {
    const el = document.getElementById('out')
    return el ? JSON.parse(el.textContent || '{}') : { error: 'no #out element' }
  })

  await browser.close()
  console.log(`${name}:
  main: COI=${main.crossOriginIsolated} SAB=${main.sharedArrayBuffer} btn=${main.hasButton}(${main.btnBg})
  coi-test: COI=${min.crossOriginIsolated} SAB=${min.sharedArrayBuffer} UA=${min.userAgent?.slice(0,60)}
  issues: ${issues.length > 0 ? issues.join('; ') : 'none'}`)
}

console.log(`Testing: ${URL}\n`)
await testCOI(webkit, 'WebKit')
await testCOI(chromium, 'Chromium')
