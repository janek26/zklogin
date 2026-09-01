import { isHex, size } from 'viem'
import type { Hex } from 'viem'
import type { StoredReadySession } from './types'

export const PRELOGIN_KEY = 'zklogin.prelogin.v1'
export const READY_KEY = 'zklogin.ready.v1'

/** Decodes a Solidity `Error(string)` revert payload into its message. */
export function decodeRevertReason(data: Hex | string): string | null {
  if (!data || typeof data !== 'string' || !data.startsWith('0x08c379a0')) return null
  try {
    const body = data.slice(10)
    // ABI: selector(4B) + offset(32B) + length(32B) + utf8 bytes (padded)
    const length = parseInt(body.slice(64, 128), 16)
    const text = body.slice(128, 128 + length * 2)
    return Buffer.from(text, 'hex').toString('utf8')
  } catch {
    return null
  }
}

export function shortAddress(address: string) { return `${address.slice(0, 6)}…${address.slice(-4)}` }
export function formatExpiry(ts: number) { return new Date(ts * 1000).toLocaleString() }

export function requireBytes32(name: string, value: string): asserts value is Hex {
  if (!isHex(value) || size(value) !== 32) throw new Error(`${name}_NOT_BYTES32`)
}

export function validStored(value: unknown): value is StoredReadySession {
  if (!value || typeof value !== 'object') return false
  const x = value as Record<string, unknown>
  return x.version === 1
    && typeof x.privateKey === 'string' && size(x.privateKey as Hex) === 32
    && typeof x.sessionKey === 'string'
    && typeof x.validUntil === 'number' && Number.isInteger(x.validUntil)
    && typeof x.randomness === 'string' && size(x.randomness as Hex) === 32
    && typeof x.accountId === 'string' && size(x.accountId as Hex) === 32
    && typeof x.kernelAddress === 'string'
}
