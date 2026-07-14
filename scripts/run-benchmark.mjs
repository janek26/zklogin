#!/usr/bin/env node
/**
 * Benchmark runner — launches a real browser via Puppeteer, navigates to the
 * benchmark page, triggers proof generation, and collects timing marks.
 *
 * Usage:
 *   node scripts/run-benchmark.mjs                  # single run, headless
 *   node scripts/run-benchmark.mjs --runs=10        # 10 runs, report stats
 *   node scripts/run-benchmark.mjs --headed          # visible browser
 *   node scripts/run-benchmark.mjs --coi             # emulate cross-origin isolation
 *   node scripts/run-benchmark.mjs --out=results.json # write results to file
 *
 * The --coi flag launches the browser with --enable-features=SharedArrayBuffer
 * to simulate the COOP/COEP headers that enable multithreaded WASM.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(__dirname, '..', 'package.json'))

// Parse args
const args = process.argv.slice(2)
const runsArg = args.find(a => a.startsWith('--runs='))
const headedArg = args.includes('--headed')
const coiArg = args.includes('--coi')
const outArg = args.find(a => a.startsWith('--out='))

const numRuns = runsArg ? parseInt(runsArg.split('=')[1], 10) : 1
const outputPath = outArg ? outArg.split('=')[1] : null

// Find Chrome binary
const fs = await import('node:fs/promises')
const puppeteer = require('puppeteer-core')

async function findChrome() {
  const cacheDir = join(process.env.HOME ?? '~', '.cache/puppeteer/chrome')
  try {
    const versions = await fs.readdir(cacheDir)
    const sorted = versions.sort().reverse()
    for (const v of sorted) {
      const base = join(cacheDir, v)
      // macOS structure: chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
      const macArm = join(base, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
      const macIntel = join(base, 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
      const linux = join(base, 'chrome-linux64/chrome')
      for (const p of [macArm, macIntel, linux]) {
        try { await fs.access(p); return p } catch { /* try next */ }
      }
    }
  } catch { /* cache dir not found */ }
  throw new Error('No Chrome binary found in puppeteer cache. Run `npx puppeteer browsers install chrome` first.')
}

async function startDevServer() {
  const { spawn } = await import('node:child_process')
  const viteBin = join(__dirname, '..', 'apps/web/node_modules/.bin/vite')
  return new Promise((resolve, reject) => {
    const proc = spawn(viteBin, ['dev', '--config', join(__dirname, '..', 'apps/web/vite.config.ts')], {
      cwd: join(__dirname, '..', 'apps/web'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BENCH_COI: coiArg ? '1' : undefined },
    })
    let resolved = false
    proc.stdout.on('data', (data) => {
      const text = data.toString()
      if (!resolved && text.includes('Local:')) {
        const match = text.match(/https?:\/\/localhost:\d+/)
        if (match) {
          resolved = true
          resolve({ url: match[0], proc })
        }
      }
    })
    proc.stderr.on('data', (data) => {
      if (!resolved) {
        const text = data.toString()
        const match = text.match(/https?:\/\/localhost:\d+/)
        if (match) {
          resolved = true
          resolve({ url: match[0], proc })
        }
      }
    })
    setTimeout(() => {
      if (!resolved) reject(new Error('Dev server did not start within 30s'))
    }, 30000)
  })
}

async function runBenchmarkOnce(page) {
  // Click the run button
  await page.waitForSelector('#run-btn')
  await page.click('#run-btn')

  // Poll the DOM for completion — uses short evaluate calls to avoid CDP timeout.
  // Each poll is a quick property read; the proof runs in the worker between polls.
  const deadline = Date.now() + 360000 // 6 minutes
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000))
    const status = await page.evaluate(() => {
      const el = document.getElementById('status')
      return { cls: el?.className ?? '', text: el?.textContent ?? '' }
    })
    if (status.cls === 'success' || status.cls === 'error') {
      // Extract the full result from the raw-output element
      const rawJson = await page.evaluate(() => document.getElementById('raw-output')?.textContent ?? '{}')
      const envInfo = await page.evaluate(() => document.getElementById('env-info')?.textContent ?? '')
      try {
        return { ...JSON.parse(rawJson), envInfo }
      } catch {
        return { ok: false, error: 'Failed to parse result JSON', marks: [], envInfo }
      }
    }
  }
  throw new Error('BENCHMARK_TIMEOUT')
}

async function main() {
  const chromePath = await findChrome()
  console.log(`Chrome: ${chromePath}`)

  // Start dev server
  console.log('Starting Vite dev server…')
  const { url: devUrl, proc: serverProc } = await startDevServer()
  console.log(`Dev server: ${devUrl}`)

  const browserArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
  ]

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: !headedArg,
    args: browserArgs,
    protocolTimeout: 360000,
  })

  const allResults = []

  try {
    for (let i = 0; i < numRuns; i++) {
      const page = await browser.newPage()
      await page.setViewport({ width: 1280, height: 900 })

      const benchUrl = `${devUrl}/benchmark.html`
      console.log(`\n--- Run ${i + 1}/${numRuns} ---`)
      await page.goto(benchUrl, { waitUntil: 'networkidle2', timeout: 120000 })

      const result = await runBenchmarkOnce(page)
      allResults.push(result)

      if (result.ok) {
        const total = result.marks.reduce((s, m) => s + m.ms, 0)
        console.log(`  Total: ${total.toFixed(1)} ms | Threads: ${result.actualThreads} | Proof: ${result.proofLength} bytes`)
        for (const m of result.marks) {
          console.log(`    ${m.stage.padEnd(25)} ${m.ms.toFixed(1)} ms`)
        }
        console.log(`  Env: ${result.envInfo}`)
      } else {
        console.error(`  FAILED: ${result.error}`)
      }

      await page.close()
    }
  } finally {
    await browser.close()
    serverProc.kill('SIGTERM')
  }

  // Compute stats if multiple runs
  if (numRuns > 1 && allResults.every(r => r.ok)) {
    const totals = allResults.map(r => r.marks.reduce((s, m) => s + m.ms, 0))
    const sorted = [...totals].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const min = Math.min(...totals)
    const max = Math.max(...totals)
    const avg = totals.reduce((s, t) => s + t, 0) / totals.length

    // Per-stage stats
    const stageNames = allResults[0].marks.map(m => m.stage)
    const stageStats = stageNames.map(name => {
      const times = allResults.map(r => r.marks.find(m => m.stage === name)?.ms ?? 0)
      const sSorted = [...times].sort((a, b) => a - b)
      return {
        stage: name,
        median: sSorted[Math.floor(sSorted.length / 2)],
        min: Math.min(...times),
        max: Math.max(...times),
        avg: times.reduce((s, t) => s + t, 0) / times.length,
      }
    })

    console.log('\n=== Summary ===')
    console.log(`Runs: ${numRuns}`)
    console.log(`Total: median=${median.toFixed(1)}ms min=${min.toFixed(1)}ms max=${max.toFixed(1)}ms avg=${avg.toFixed(1)}ms`)
    console.log('\nPer-stage:')
    for (const s of stageStats) {
      console.log(`  ${s.stage.padEnd(25)} median=${s.median.toFixed(1)}ms min=${s.min.toFixed(1)}ms max=${s.max.toFixed(1)}ms`)
    }
  }

  // Write output file if requested
  if (outputPath) {
    const output = {
      timestamp: new Date().toISOString(),
      numRuns,
      coi: coiArg,
      results: allResults.map(r => ({
        ok: r.ok,
        error: r.error,
        marks: r.marks,
        proofLength: r.proofLength,
        actualThreads: r.actualThreads,
        wasmPages: r.wasmPages,
        envInfo: r.envInfo,
      })),
    }
    await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n')
    console.log(`\nResults written to ${outputPath}`)
  }
}

main().catch(err => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
