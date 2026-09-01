import { describe, expect, it } from 'vitest'
import { size } from 'viem'
import { __testOnly } from '../aa/recoveryValidator'

describe('recovery validator wire format', () => {
  const params = {
    version: `0x${'01'.repeat(32)}`,
    proofVerificationData: { vkeyHash: `0x${'02'.repeat(32)}`, proof: '0xdeadbeef', publicInputs: [`0x${'03'.repeat(32)}`] },
    committedInputs: '0xaabb',
    serviceConfig: { validityPeriodInSeconds: 604800, domain: 'zklogin-poc.rahrt.com', scope: 'policy-1:1', devMode: false },
  } as never
  const owner = '0x3333333333333333333333333333333333333333' as `0x${string}`
  const sig = `0x${'44'.repeat(65)}` as `0x${string}`

  it('prefixes proposal signatures with mode 0x02 and the full auth tuple', () => {
    const encoded = __testOnly.encodeProposalMode({ params, proposedOwner: owner, recoveryNonce: 1n })
    expect(encoded.slice(0, 4)).toBe('0x02')
    expect(size(encoded)).toBeGreaterThan(65)
  })

  it('prefixes finalize signatures with mode 0x03, nonce, and ECDSA', () => {
    const encoded = __testOnly.encodeFinalizeMode(7n, sig)
    expect(encoded.slice(0, 4)).toBe('0x03')
    // mode + (uint64 padded 32B, offset 32B, length 32B, 65-byte sig padded to 96B)
    expect(size(encoded)).toBe(1 + 32 + 32 + 32 + 96)
  })

  it('prefixes owner signatures with mode 0x04 and ECDSA only', () => {
    const encoded = __testOnly.encodeOwnerMode(sig)
    expect(encoded.slice(0, 4)).toBe('0x04')
    expect(size(encoded)).toBe(66)
  })

  it('builds mode-0x02 exact proposal call data', () => {
    const call = __testOnly.makeProposeCallData({ validatorAddress: owner, params, proposedOwner: owner, recoveryNonce: 1n })
    expect(call).toMatch(/^0x/)
  })

  it('builds mode-0x03 exact finalize call data', () => {
    const call = __testOnly.makeFinalizeCallData({ validatorAddress: owner, recoveryNonce: 1n })
    expect(call).toMatch(/^0x/)
  })
})
