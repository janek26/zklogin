import { webkit, chromium } from 'playwright'

const URL = 'https://feat-coop-coep-cross-browser.zklogin-poc.pages.dev'

async function test(browserType, name) {
  const browser = await browserType.launch({ headless: true })
  const page = await browser.newPage()
  const issues = []
  page.on('requestfailed', req => issues.push(`FAILED: ${req.url()}`))
  page.on('pageerror', err => issues.push(`ERR: ${err.message}`))

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 })
  await page.waitForSelector('.google-signin-btn', { timeout: 5000 }).catch(() => {})

  const result = await page.evaluate(() => {
    const btn = document.querySelector('.google-signin-btn')
    return {
      crossOriginIsolated: window.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      hasButton: !!btn,
      btnBg: btn ? getComputedStyle(btn).backgroundColor : null,
      btnText: btn?.textContent?.trim(),
    }
  })
  await browser.close()
  console.log(`${name}: COI=${result.crossOriginIsolated} SAB=${result.sharedArrayBuffer} btn=${result.hasButton}(${result.btnText}) bg=${result.btnBg} issues=${issues.length}`)
}

await test(webkit, 'WebKit')
await test(chromium, 'Chromium')

// Also test coi-test page on latest deploy
async function testMinimal(browserType, name) {
  const browser = await browserType.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(URL + '/coi-test.html', { waitUntil: 'networkidle', timeout: 10000 })
  const text = await page.evaluate(() => document.getElementById('out')?.textContent || 'nope')
  await browser.close()
  console.log(`${name} coi-test: ${text}`)
}
await testMinimal(webkit, 'WebKit')
await testMinimal(chromium, 'Chromium')
