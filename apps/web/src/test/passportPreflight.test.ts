import { describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { checkCertificateRoot } from '../lib/passportPreflight'
import type { PassportProofParams } from '../lib/recoveryCore'

const LATEST_ROOT: Hex = '0x0230cf7904896615a2fab194d5d0e7115bce9749aaaf61805fea7aaf1c8200c0'
const STALE_ROOT: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function proofParams(certRoot: Hex): PassportProofParams {
  return {
    version: '0x0000000000000000000000000000000000000000000000000000000000000001',
    proofVerificationData: {
      vkeyHash: '0x0000000000000000000000000000000000000000000000000000000000000002',
      proof: '0x00',
      publicInputs: [certRoot, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000000000000000000000000001'],
    },
    committedInputs: '0x00',
    serviceConfig: { validityPeriodInSeconds: 604800, domain: 'zklogin-poc.rahrt.com', scope: 'policy-1:1', devMode: false },
  }
}

function reader(valid: boolean, latest: Hex, fail = false) {
  const fn = vi.fn()
  if (fail) {
    fn.mockRejectedValue(new Error('RPC unreachable'))
  } else {
    fn.mockResolvedValueOnce(valid).mockResolvedValueOnce(latest)
  }
  return { readContract: fn }
}

describe('checkCertificateRoot', () => {
  it('returns null when the proof root is valid on-chain', async () => {
    const result = await checkCertificateRoot(proofParams(LATEST_ROOT), reader(true, LATEST_ROOT))
    expect(result).toBeNull()
  })

  it('describes the mismatch when the proof root is stale', async () => {
    const message = await checkCertificateRoot(proofParams(STALE_ROOT), reader(false, LATEST_ROOT))
    expect(message).toContain('stale certificate registry')
    expect(message).toContain('aaaaaaaa')
    expect(message).toContain('0230cf')
  })

  it('returns null when the registry is unreachable (let simulation judge)', async () => {
    const result = await checkCertificateRoot(proofParams(LATEST_ROOT), reader(true, LATEST_ROOT, true))
    expect(result).toBeNull()
  })

  it('passes the certificate registry id and proof timestamp to the registry', async () => {
    const r = reader(true, LATEST_ROOT)
    await checkCertificateRoot(proofParams(STALE_ROOT), r)
    const isRootValidCall = r.readContract.mock.calls[0][0]
    expect(isRootValidCall.functionName).toBe('isRootValid')
    expect(isRootValidCall.args[0]).toBe('0x0000000000000000000000000000000000000000000000000000000000000001')
    expect(isRootValidCall.args[1]).toBe(STALE_ROOT)
    expect(isRootValidCall.args[2]).toBe(1n)
    const latestCall = r.readContract.mock.calls[1][0]
    expect(latestCall.functionName).toBe('latestRoot')
    expect(latestCall.address).toBe('0x1D0000020038d6E40E1d98e09fA1bb3A7DAA8B70')
  })
})
