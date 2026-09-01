import type { Address, Hex, LocalAccount } from 'viem'
import { concatHex, encodeAbiParameters, toHex } from 'viem'
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction'
import { toAccount } from 'viem/accounts'
import type { EntryPointType, GetKernelVersion, KernelValidator } from '@zerodev/sdk/types'
import type { PassportProofParams } from '../lib/recoveryCore'
import { makeFinalizeCallData, makeProposeCallData } from '../lib/recoveryCore'

const DUMMY_ECDSA_SIGNATURE = ('0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c') as Hex

const passportAuthAbi = [{
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

export type PassportProposalAuth = { params: PassportProofParams; proposedOwner: Address; recoveryNonce: bigint }

function encodeProposalMode(auth: PassportProposalAuth): Hex {
  return concatHex(['0x02', encodeAbiParameters(passportAuthAbi, [{ ...auth, params: auth.params as never }])])
}
function encodeFinalizeMode(recoveryNonce: bigint, signature: Hex): Hex {
  return concatHex(['0x03', encodeAbiParameters([{ type: 'uint64' }, { type: 'bytes' }], [recoveryNonce, signature])])
}
function encodeOwnerMode(signature: Hex): Hex {
  return concatHex(['0x04', signature])
}

/** Shared local-account wrapper (mirrors zkLoginValidator). */
function toLocalAccount(signer: LocalAccount) {
  return toAccount({
    address: signer.address,
    signMessage: (parameters) => signer.signMessage(parameters),
    signTransaction: async () => { throw new Error('SMART_ACCOUNT_DOES_NOT_SIGN_TRANSACTIONS') },
    signTypedData: (parameters) => signer.signTypedData(parameters),
  })
}

/** Kernel root-validator adapter for recovery modes 0x02–0x04. */
export async function toRecoveryKernelValidator(args: {
  entryPoint: EntryPointType<'0.7'>
  kernelVersion: GetKernelVersion<'0.7'>
  chainId: number
  validatorAddress: Address
  signer: LocalAccount
  kind: 'proposal' | 'finalize' | 'owner'
  /** The wallet's accountId — must match the sudo validator's enableData so
   * the kernel address derivation reproduces the wallet's real address. */
  accountId: Hex
  proposalAuth?: PassportProposalAuth
  recoveryNonce?: bigint
}): Promise<KernelValidator<'RecoveryValidator'>> {
  const local = toLocalAccount(args.signer)
  const userOpHash = (op: UserOperation): Hex => getUserOperationHash({
    userOperation: { ...op, signature: '0x' } as UserOperation<'0.7'>,
    entryPointAddress: args.entryPoint.address,
    entryPointVersion: args.entryPoint.version,
    chainId: args.chainId,
  })
  return {
    ...local,
    address: args.validatorAddress,
    source: 'RecoveryValidator',
    validatorType: 'SECONDARY',
    supportedKernelVersions: args.kernelVersion,
    async getEnableData() { return encodeAbiParameters([{ type: 'bytes32' }], [args.accountId]) },
    getIdentifier() { return args.validatorAddress },
    async getNonceKey(_accountAddress, customNonceKey = 0n) { return customNonceKey },
    async isEnabled() { return false },
    async getStubSignature() {
      if (args.kind === 'proposal') {
        if (!args.proposalAuth) throw new Error('PROPOSAL_AUTH_REQUIRED')
        return encodeProposalMode(args.proposalAuth)
      }
      if (args.kind === 'finalize') {
        if (args.recoveryNonce === undefined) throw new Error('RECOVERY_NONCE_REQUIRED')
        return encodeFinalizeMode(args.recoveryNonce, DUMMY_ECDSA_SIGNATURE)
      }
      return encodeOwnerMode(DUMMY_ECDSA_SIGNATURE)
    },
    async signUserOperation(op) {
      const signature = await args.signer.signMessage({ message: { raw: userOpHash(op) } })
      if (args.kind === 'proposal') {
        if (!args.proposalAuth) throw new Error('PROPOSAL_AUTH_REQUIRED')
        return encodeProposalMode(args.proposalAuth)
      }
      if (args.kind === 'finalize') {
        if (args.recoveryNonce === undefined) throw new Error('RECOVERY_NONCE_REQUIRED')
        return encodeFinalizeMode(args.recoveryNonce, signature)
      }
      return encodeOwnerMode(signature)
    },
  }
}

export const __testOnly = { encodeProposalMode, encodeFinalizeMode, encodeOwnerMode, makeProposeCallData, makeFinalizeCallData }
