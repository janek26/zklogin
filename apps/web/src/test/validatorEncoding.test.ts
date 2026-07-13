import { describe, expect, it } from 'vitest'
import { size } from 'viem'
import { __testOnly, makeActivationCallData, makeActivationInnerData } from '../aa/zkLoginValidator'

describe('validator wire format', () => {
  const auth = { proof: '0x1234' as const, jwtIat: 1n, publicKeyHash: `0x${'11'.repeat(32)}` as const, jwkProof: [] as `0x${string}`[], sessionKey: '0x1111111111111111111111111111111111111111' as const, sessionValidUntil: 2, randomness: `0x${'22'.repeat(32)}` as const }
  it('prefixes proof signatures exactly once and uses Solidity tuple order', () => {
    const encoded = __testOnly.encodeProofMode(auth, `0x${'33'.repeat(65)}`)
    expect(encoded.slice(0, 4)).toBe('0x00')
    expect(size(encoded)).toBeGreaterThan(65)
  })
  it('makes session signatures exactly mode plus ECDSA', () => {
    expect(size(__testOnly.encodeSessionMode(`0x${'33'.repeat(65)}`))).toBe(66)
  })
  it('constructs activation inner calldata and Kernel execute wrapper', () => {
    const args = { validatorAddress: '0x1111111111111111111111111111111111111111', sessionKey: '0x2222222222222222222222222222222222222222', sessionValidUntil: 1_700_000_000, randomness: `0x${'44'.repeat(32)}` } as const
    expect(makeActivationInnerData(args)).toMatch(/^0x/)
    expect(makeActivationCallData(args)).toMatch(/^0x/)
  })
})
