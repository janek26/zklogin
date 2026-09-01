import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isHex, size, toHex } from 'viem'
import {
  createLocalRecoveryKey,
  deleteLocalRecoveryKey,
  loadLocalRecoveryKey,
  recoveryStorageKey,
} from '../lib/recoveryCore'

const CHAIN_ID = 11155111
const KERNEL = '0x1111111111111111111111111111111111111111'

// Minimal localStorage shim for node-based unit tests.
const store = new Map<string, string>()
beforeEach(() => store.clear())
afterEach(() => store.clear())

;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) },
  clear: () => store.clear(),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() { return store.size },
}

describe('local recovery key lifecycle', () => {
  it('stores the raw key under the scoped storage key', () => {
    const key = createLocalRecoveryKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 1n })
    expect(isHex(key.privateKey)).toBe(true)
    expect(size(key.privateKey)).toBe(32)
    const raw = store.get(recoveryStorageKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 1n }))
    expect(raw).toBe(key.privateKey)
  })

  it('loads back the key and derives the same address', () => {
    const created = createLocalRecoveryKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 2n })
    const loaded = loadLocalRecoveryKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 2n })
    expect(loaded?.privateKey).toBe(created.privateKey)
    expect(loaded?.address).toBe(created.address)
  })

  it('rejects and removes a malformed stored key', () => {
    store.set(recoveryStorageKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 3n }), 'not-a-key')
    const loaded = loadLocalRecoveryKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 3n })
    expect(loaded).toBeNull()
    expect(store.has(recoveryStorageKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 3n }))).toBe(false)
  })

  it('rejects a wrong-length stored key', () => {
    store.set(recoveryStorageKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 4n }), toHex('0x1234'))
    expect(loadLocalRecoveryKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 4n })).toBeNull()
  })

  it('returns null when nothing is stored', () => {
    expect(loadLocalRecoveryKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 5n })).toBeNull()
  })

  it('deletes the key on cancel/replace', () => {
    createLocalRecoveryKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 6n })
    deleteLocalRecoveryKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 6n })
    expect(store.size).toBe(0)
  })

  it('scopes keys per chain, kernel, and nonce', () => {
    const a = recoveryStorageKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 7n })
    const b = recoveryStorageKey({ chainId: 1, kernelAddress: KERNEL, recoveryNonce: 7n })
    const c = recoveryStorageKey({ chainId: CHAIN_ID, kernelAddress: '0x2222222222222222222222222222222222222222', recoveryNonce: 7n })
    const d = recoveryStorageKey({ chainId: CHAIN_ID, kernelAddress: KERNEL, recoveryNonce: 8n })
    expect(new Set([a, b, c, d]).size).toBe(4)
  })
})
