import type { BrowserProof } from './prover.worker'

export type ProveProgress = { phase: 'witness' | 'proof' }

export function proveInBrowser(
  jwt: string,
  expectedNonce: string,
  onProgress?: (p: ProveProgress) => void,
): Promise<BrowserProof> {
  const worker = new Worker(new URL('./prover.worker.ts', import.meta.url), { type: 'module' })
  const { promise, resolve, reject } = Promise.withResolvers<BrowserProof>()
  let settled = false
  const fail = (reason: string) => { if (settled) return; settled = true; window.clearTimeout(timeout); worker.terminate(); reject(new Error(reason)) }
  const timeout = window.setTimeout(() => fail('PROVING_TIMEOUT'), 5 * 60_000)

  worker.onmessage = (event) => {
    if (event.data.type === 'phase') {
      const phase = event.data.detail as ProveProgress['phase']
      if (phase === 'proof') onProgress?.({ phase: 'proof' })
      else onProgress?.({ phase: 'witness' })
      return
    }
    if (event.data.ok) resolve(event.data.response)
    else fail(event.data.error ?? 'PROVING_FAILED')
    settled = true; window.clearTimeout(timeout); worker.terminate()
  }
  worker.onerror = () => fail('PROVING_WORKER_CRASHED')
  worker.onmessageerror = () => fail('PROVING_WORKER_CRASHED')
  worker.postMessage({ jwt, expectedNonce })
  return promise
}
