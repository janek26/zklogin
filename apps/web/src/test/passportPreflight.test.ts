import { describe, expect, it, vi, type Mock } from 'vitest'
import type { Hex } from 'viem'
import { checkCertificateRoot, type RegistryReader } from '../lib/passportPreflight'
import type { PassportProofParams } from '../lib/recoveryCore'

const LATEST_ROOT: Hex = '0x0230cf7904896615a2fab194d5d0e7115bce9749aaaf61805fea7aaf1c8200c0'
const STALE_ROOT: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const REGISTRY = '0x1D0000020038d6E40E1d98e09fA1bb3A7DAA8B70'

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

function makeReader(valid: boolean, latest: Hex, fail = false) {
  const readContract = vi.fn()
  if (fail) {
    readContract.mockRejectedValue(new Error('RPC unreachable'))
  } else {
    readContract.mockResolvedValueOnce(valid).mockResolvedValueOnce(latest)
  }
  return { readContract, reader: { readContract } as unknown as RegistryReader }
}

describe('checkCertificateRoot', () => {
  it('returns null when the proof root is valid on-chain', async () => {
    const { reader } = makeReader(true, LATEST_ROOT)
    const result = await checkCertificateRoot(proofParams(LATEST_ROOT), { reader, registryAddress: REGISTRY })
    expect(result).toBeNull()
  })

  it('describes the mismatch when the proof root is stale', async () => {
    const { reader } = makeReader(false, LATEST_ROOT)
    const message = await checkCertificateRoot(proofParams(STALE_ROOT), { reader, registryAddress: REGISTRY })
    expect(message).toContain('stale certificate registry')
    expect(message).toContain('aaaaaaaa')
    expect(message).toContain('0230cf')
  })

  it('returns null when the registry is unreachable (let simulation judge)', async () => {
    const { reader } = makeReader(true, LATEST_ROOT, true)
    const result = await checkCertificateRoot(proofParams(LATEST_ROOT), { reader, registryAddress: REGISTRY })
    expect(result).toBeNull()
  })

  it('passes the certificate registry id and proof timestamp to the registry', async () => {
    const { readContract, reader } = makeReader(true, LATEST_ROOT)
    await checkCertificateRoot(proofParams(STALE_ROOT), { reader, registryAddress: REGISTRY })
    const mock = readContract as Mock
    const isRootValidCall = mock.mock.calls[0][0] as { functionName: string; args: unknown[] }
    expect(isRootValidCall.functionName).toBe('isRootValid')
    expect(isRootValidCall.args[0]).toBe('0x0000000000000000000000000000000000000000000000000000000000000001')
    expect(isRootValidCall.args[1]).toBe(STALE_ROOT)
    expect(isRootValidCall.args[2]).toBe(1n)
    const latestCall = mock.mock.calls[1][0] as { functionName: string; address: string }
    expect(latestCall.functionName).toBe('latestRoot')
    expect(latestCall.address).toBe(REGISTRY)
  })
})
