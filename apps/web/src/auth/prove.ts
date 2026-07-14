import type { BrowserProof } from './prover.worker'

export type ProveProgress = { phase: 'witness' | 'proof' }

export function proveInBrowser(
  jwt: string,
  expectedNonce: string,
  onProgress?: (p: ProveProgress) => void,
): Promise<BrowserProof> {
  const worker = new Worker(new URL('./prover.worker.ts', import.meta.url), { type: 'module' })
  const { promise, resolve, reject } = Promise.withResolvers<BrowserProof>()
  const timeout = window.setTimeout(() => { worker.terminate(); reject(new Error('PROVING_TIMEOUT')) }, 5 * 60_000)

  worker.onmessage = (event) => {
    if (event.data.type === 'phase') {
      const phase = event.data.detail as ProveProgress['phase']
      if (phase === 'proof') onProgress?.({ phase: 'proof' })
      else onProgress?.({ phase: 'witness' })
      return
    }
    window.clearTimeout(timeout)
    worker.terminate()
    event.data.ok ? resolve(event.data.response) : reject(new Error(event.data.error))
  }
  worker.onerror = () => { window.clearTimeout(timeout); worker.terminate(); reject(new Error('PROVING_WORKER_CRASHED')) }
  worker.postMessage({ jwt, expectedNonce })
  return promise
}
