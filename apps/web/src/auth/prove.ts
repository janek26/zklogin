import type { BrowserProof } from './prover.worker'
export function proveInBrowser(jwt: string, expectedNonce: string): Promise<BrowserProof> {
  const worker = new Worker(new URL('./prover.worker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => { worker.terminate(); reject(new Error('PROVING_TIMEOUT')) }, 5 * 60_000)
    worker.onmessage = (event) => { window.clearTimeout(timeout); worker.terminate(); event.data.ok ? resolve(event.data.response) : reject(new Error(event.data.error)) }
    worker.onerror = () => { window.clearTimeout(timeout); worker.terminate(); reject(new Error('PROVING_WORKER_CRASHED')) }
    worker.postMessage({ jwt, expectedNonce })
  })
}
