/// <reference lib="webworker" />
/**
 * Instrumented prover worker for benchmarking.
 * Mirrors prover.worker.ts but uses the benchmark fixture and emits
 * fine-grained timing marks via console.time/timeEnd capture.
 */
import { zklogin } from '@shield-labs/zklogin'
import fixture from '../generated/benchmark-fixture.json'

type Request = { jwt: string; expectedNonce: string }
export type BenchMark = { stage: string; ms: number }
export type BenchResult = {
  ok: boolean
  error?: string
  marks: BenchMark[]
  proofLength?: number
  actualThreads?: number
  wasmPages?: number
  proofHex?: string
}

type FrozenKey = Awaited<ReturnType<zklogin.PublicKeyRegistry['getPublicKeyByKid']>>

class BenchPublicKeyRegistry extends zklogin.PublicKeyRegistry {
  override async getPublicKeyByKid(kid: string): Promise<FrozenKey> {
    const key = (fixture.jwkSnapshot as { keys: Array<{ kid: string }> }).keys.find(
      (k) => k.kid === kid,
    )
    if (!key) throw new Error('JWK_SNAPSHOT_MISS')
    // Fixture keys are structurally identical to registry keys (same limb format + hash).
    return key as unknown as FrozenKey
  }
}

const context = self as unknown as DedicatedWorkerGlobalScope

context.onmessage = async (event: MessageEvent<Request>) => {
  const post = (msg: BenchResult) => context.postMessage(msg)
  const marks: BenchMark[] = []

  // Capture console.time/timeEnd pairs that the SDK emits internally
  const timers = new Map<string, number>()
  const origTime = console.time
  const origTimeEnd = console.timeEnd
  console.time = (label: string) => {
    timers.set(label, performance.now())
    origTime.call(console, label)
  }
  console.timeEnd = (label: string) => {
    const start = timers.get(label)
    if (start !== undefined) {
      marks.push({ stage: label, ms: performance.now() - start })
      timers.delete(label)
    }
    origTimeEnd.call(console, label)
  }

  try {
    // --- Overall proof (includes dynamic imports, prepare, witness, proof generation) ---
    const t0 = performance.now()
    const result = await new zklogin.ZkLogin(new BenchPublicKeyRegistry()).proveJwt(
      event.data.jwt,
      event.data.expectedNonce,
    )
    marks.push({ stage: 'total_proveJwt', ms: performance.now() - t0 })

    if (!result) throw new Error('JWT_OR_NONCE_REJECTED')

    // --- Match JWK for jwkProof (same as prover.worker.ts) ---
    const key = (fixture.jwkSnapshot as { keys: Array<{ hash: string; jwkProof: `0x${string}`[] }> }).keys.find(
      (candidate) => candidate.hash.toLowerCase() === result.input.public_key_hash.toLowerCase(),
    )
    if (!key) throw new Error('JWK_SNAPSHOT_MISS')

    // --- Extract proof info ---
    const proofHex = result.proof

    post({
      ok: true,
      marks,
      proofLength: proofHex.length / 2 - 1, // hex string minus 0x prefix
      proofHex,
    } satisfies BenchResult)
  } catch (error) {
    post({
      ok: false,
      error: error instanceof Error ? error.message : 'PROVING_FAILED',
      marks,
    } satisfies BenchResult)
  } finally {
    console.time = origTime
    console.timeEnd = origTimeEnd
  }
}
