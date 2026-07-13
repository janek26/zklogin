import type { Address, Hex, LocalAccount } from 'viem'
import { concatHex, encodeAbiParameters, encodeFunctionData, parseAbi, toHex, zeroHash } from 'viem'
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction'
import { toAccount } from 'viem/accounts'
import type { EntryPointType, GetKernelVersion, KernelValidator } from '@zerodev/sdk/types'

const validatorAbi = parseAbi(['function activateSession(address sessionKey,uint48 validUntil,bytes32 randomness)'])
const kernelExecuteAbi = parseAbi(['function execute(bytes32 execMode,bytes executionCalldata)'])

export function makeActivationInnerData(args: { sessionKey: Address; sessionValidUntil: number; randomness: Hex }): Hex {
  return encodeFunctionData({ abi: validatorAbi, functionName: 'activateSession', args: [args.sessionKey, args.sessionValidUntil, args.randomness] })
}

export function makeActivationCallData(args: { validatorAddress: Address; sessionKey: Address; sessionValidUntil: number; randomness: Hex }): Hex {
  return encodeFunctionData({
    abi: kernelExecuteAbi,
    functionName: 'execute',
    args: [zeroHash, concatHex([args.validatorAddress, toHex(0n, { size: 32 }), makeActivationInnerData(args)])],
  })
}

const DUMMY_ECDSA_SIGNATURE = ('0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c') as Hex
const proofAuthAbi = [{ type: 'tuple', components: [
  { name: 'proof', type: 'bytes' }, { name: 'jwtIat', type: 'uint64' }, { name: 'publicKeyHash', type: 'bytes32' }, { name: 'jwkProof', type: 'bytes32[]' },
  { name: 'sessionKey', type: 'address' }, { name: 'sessionValidUntil', type: 'uint48' }, { name: 'randomness', type: 'bytes32' }, { name: 'sessionSignature', type: 'bytes' },
] }] as const

export type ProofAuth = { proof: Hex; jwtIat: bigint; publicKeyHash: Hex; jwkProof: Hex[]; sessionKey: Address; sessionValidUntil: number; randomness: Hex }
function encodeProofMode(auth: ProofAuth, sessionSignature: Hex): Hex { return concatHex(['0x00', encodeAbiParameters(proofAuthAbi, [{ ...auth, sessionSignature }])]) }
function encodeSessionMode(signature: Hex): Hex { return concatHex(['0x01', signature]) }

/** Kernel root-validator adapter. The contract, not this client object, is authoritative. */
export async function toZkLoginKernelValidator(args: {
  entryPoint: EntryPointType<'0.7'>
  kernelVersion: GetKernelVersion<'0.7'>
  chainId: number
  validatorAddress: Address
  accountId: Hex
  sessionSigner: LocalAccount
  activationCallData: Hex
  proofAuth?: ProofAuth
}): Promise<KernelValidator<'ZkLoginKernelValidator'>> {
  if (args.proofAuth && args.proofAuth.sessionKey.toLowerCase() !== args.sessionSigner.address.toLowerCase()) throw new Error('SESSION_SIGNER_MISMATCH')
  const local = toAccount({
    address: args.sessionSigner.address,
    signMessage: (parameters) => args.sessionSigner.signMessage(parameters),
    signTransaction: async () => { throw new Error('SMART_ACCOUNT_DOES_NOT_SIGN_TRANSACTIONS') },
    signTypedData: (parameters) => args.sessionSigner.signTypedData(parameters),
  })
  const isActivation = (op: UserOperation) => op.callData.toLowerCase() === args.activationCallData.toLowerCase()
  const userOpHash = (op: UserOperation): Hex => getUserOperationHash({
    userOperation: { ...op, signature: '0x' } as UserOperation<'0.7'>,
    entryPointAddress: args.entryPoint.address,
    entryPointVersion: args.entryPoint.version,
    chainId: args.chainId,
  })
  return {
    ...local,
    address: args.validatorAddress,
    source: 'ZkLoginKernelValidator',
    validatorType: 'SECONDARY',
    supportedKernelVersions: args.kernelVersion,
    async getEnableData() { return encodeAbiParameters([{ type: 'bytes32' }], [args.accountId]) },
    getIdentifier() { return args.validatorAddress },
    async getNonceKey(_accountAddress, customNonceKey = 0n) { return customNonceKey },
    async isEnabled() { return false },
    async getStubSignature(op) {
      if (isActivation(op)) {
        if (!args.proofAuth) throw new Error('PROOF_REQUIRED_FOR_ACTIVATION')
        return encodeProofMode(args.proofAuth, DUMMY_ECDSA_SIGNATURE)
      }
      return encodeSessionMode(DUMMY_ECDSA_SIGNATURE)
    },
    async signUserOperation(op) {
      const signature = await args.sessionSigner.signMessage({ message: { raw: userOpHash(op) } })
      if (isActivation(op)) {
        if (!args.proofAuth) throw new Error('PROOF_REQUIRED_FOR_ACTIVATION')
        return encodeProofMode(args.proofAuth, signature)
      }
      return encodeSessionMode(signature)
    },
  }
}

export const __testOnly = { encodeProofMode, encodeSessionMode }
