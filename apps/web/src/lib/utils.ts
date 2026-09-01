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

/**
 * Digs a readable revert reason out of any thrown value — including nested
 * viem/ZeroDev error chains where the simulation revert from
 * `zd_sponsorUserOperation` is buried several `cause` levels deep. Checks, in
 * order: a direct `data` field, the raw `0x08c379a0…` hex embedded in any
 * string field, then already-decoded reason text in `message`/`details`.
 */
export function extractRevertReason(err: unknown): string | null {
  if (!err) return null

  const seen = new Set<unknown>()
  let current: unknown = err
  while (current && !seen.has(current)) {
    seen.add(current)
    const record = current as Record<string, unknown>

    // Direct revert-data field (JsonRpcError / ContractFunctionRevertedError).
    if (typeof record.data === 'string' && record.data.startsWith('0x08c379a0')) {
      const decoded = decodeRevertReason(record.data)
      if (decoded) return decoded
    }

    // Hex embedded in any message-ish string.
    for (const key of ['message', 'shortMessage', 'details', 'data', 'metaMessages']) {
      const value = record[key]
      const strings = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : typeof value === 'string'
          ? [value]
          : []
      for (const text of strings) {
        const match = text.match(/0x08c379a0[0-9a-fA-F]{64,}/)
        if (match) {
          const decoded = decodeRevertReason(match[0])
          if (decoded) return decoded
        }
      }
    }

    // Already-decoded reason. viem: "…reverted with the following reason:\n
    // Invalid certificate registry root" (reason on its own line). ZeroDev:
    // 'Error: "Invalid certificate registry root"' (quoted inline).
    for (const key of ['message', 'shortMessage', 'details']) {
      const text = record[key]
      if (typeof text !== 'string') continue

      // Quoted inline reason: Error: "…" or 'reverted with reason: "…"'
      const quoted = text.match(/reason[:\s]*["']([^"']{2,})["']/i)
      if (quoted) return quoted[1].trim()

      // Reason on its own line after the label (viem multi-line format).
      const ownLine = text.match(/reason[:\s]*\n\s*([A-Za-z][A-Za-z0-9_ ]{2,})/i)
      if (ownLine) return ownLine[1].trim()
    }

    current = record.cause
  }
  return null
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
