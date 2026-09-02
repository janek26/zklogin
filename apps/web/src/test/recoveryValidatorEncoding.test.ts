import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, encodeAbiParameters, size, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getEntryPoint } from '@zerodev/sdk/constants'
import { KERNEL_V3_3 } from '@zerodev/sdk/constants'
import { __testOnly, toRecoveryKernelValidator } from '../aa/recoveryValidator'

describe('recovery validator wire format', () => {
  const params = {
    version: `0x${'01'.repeat(32)}` as Hex,
    proofVerificationData: { vkeyHash: `0x${'02'.repeat(32)}` as Hex, proof: '0xdeadbeef' as Hex, publicInputs: [`0x${'03'.repeat(32)}` as Hex] },
    committedInputs: '0xaabb' as Hex,
    serviceConfig: { validityPeriodInSeconds: 604800, domain: 'zklogin-poc.rahrt.com', scope: 'policy-1:1', devMode: false },
  }
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
  it('carries devMode=true in the proposal auth serviceConfig tuple', () => {
    const devModeParams = {
      version: `0x${'01'.repeat(32)}` as Hex,
      proofVerificationData: { vkeyHash: `0x${'02'.repeat(32)}` as Hex, proof: '0xdeadbeef' as Hex, publicInputs: [`0x${'03'.repeat(32)}` as Hex] },
      committedInputs: '0xaabb' as Hex,
      serviceConfig: { validityPeriodInSeconds: 604800, domain: 'zklogin-poc.rahrt.com', scope: 'policy-1:1', devMode: true },
    }
    const encoded = __testOnly.encodeProposalMode({ params: devModeParams, proposedOwner: owner, recoveryNonce: 1n })
    const authAbi = [{
      type: 'tuple',
      components: [
        { name: 'params', type: 'tuple', components: [
          { name: 'version', type: 'bytes32' },
          { name: 'proofVerificationData', type: 'tuple', components: [
            { name: 'vkeyHash', type: 'bytes32' },
            { name: 'proof', type: 'bytes' },
            { name: 'publicInputs', type: 'bytes32[]' },
          ] },
          { name: 'committedInputs', type: 'bytes' },
          { name: 'serviceConfig', type: 'tuple', components: [
            { name: 'validityPeriodInSeconds', type: 'uint256' },
            { name: 'domain', type: 'string' },
            { name: 'scope', type: 'string' },
            { name: 'devMode', type: 'bool' },
          ] },
        ] },
        { name: 'proposedOwner', type: 'address' },
        { name: 'recoveryNonce', type: 'uint64' },
      ],
    }] as const
    const [auth] = decodeAbiParameters(authAbi, encoded.slice(2) as Hex)
    expect(auth.params.serviceConfig.devMode).toBe(true)
  })

  it('encodes the wallet accountId as the recovery validator enableData', async () => {
    // Regression: getEnableData must reproduce the sudo validator's enableData
    // (abi.encode(accountId)), otherwise the kernel address derivation during
    // recovery differs from the wallet's real address and every recovery fails
    // with KERNEL_ADDRESS_DERIVATION_MISMATCH.
    const accountId = `0x${'ab'.repeat(32)}` as Hex
    const validator = await toRecoveryKernelValidator({
      entryPoint: getEntryPoint('0.7'),
      kernelVersion: KERNEL_V3_3,
      chainId: 11155111,
      validatorAddress: owner,
      signer: privateKeyToAccount(`0x${'11'.repeat(32)}`),
      kind: 'owner',
      accountId,
    })
    expect(await validator.getEnableData()).toBe(encodeAbiParameters([{ type: 'bytes32' }], [accountId]))
  })
})
