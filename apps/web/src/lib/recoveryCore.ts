import type { Address, Hex } from 'viem'
import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, isAddress, isHex, keccak256, pad, parseAbi, size, toHex, zeroAddress, zeroHash } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// ---------------------------------------------------------------------------
// V2 contract ABI (mirrors ZkLoginKernelValidatorV2.sol)
// ---------------------------------------------------------------------------

export const recoveryAbi = parseAbi([
  'function accountState(address kernel) view returns (bytes32 accountId, address sessionKey, uint48 sessionValidUntil, bytes32 guardianNullifier, uint48 recoveryDelay, uint64 guardianNonce, uint64 recoveryNonce, address permanentOwner, (address proposedOwner, uint48 executableAt, uint64 nonce) recovery)',
  'function setGuardian((bytes32 version, (bytes32 vkeyHash, bytes proof, bytes32[] publicInputs) proofVerificationData, bytes committedInputs, (uint256 validityPeriodInSeconds, string domain, string scope, bool devMode) serviceConfig) params, uint48 delay)',
  'function clearGuardian()',
  'function cancelRecovery()',
  'function proposeRecovery((bytes32 version, (bytes32 vkeyHash, bytes proof, bytes32[] publicInputs) proofVerificationData, bytes committedInputs, (uint256 validityPeriodInSeconds, string domain, string scope, bool devMode) serviceConfig) params, address proposedOwner, uint64 recoveryNonce)',
  'function finalizeRecovery(uint64 recoveryNonce)',
])

export const zkPassportVerifierParamsType = {
  type: 'tuple',
  components: [
    { name: 'version', type: 'bytes32' },
    {
      name: 'proofVerificationData',
      type: 'tuple',
      components: [
        { name: 'vkeyHash', type: 'bytes32' },
        { name: 'proof', type: 'bytes' },
        { name: 'publicInputs', type: 'bytes32[]' },
      ],
    },
    { name: 'committedInputs', type: 'bytes' },
    {
      name: 'serviceConfig',
      type: 'tuple',
      components: [
        { name: 'validityPeriodInSeconds', type: 'uint256' },
        { name: 'domain', type: 'string' },
        { name: 'scope', type: 'string' },
        { name: 'devMode', type: 'bool' },
      ],
    },
  ],
} as const

/** ZKPassport SDK `getSolidityVerifierParameters` output, normalized. */
export type PassportProofParams = {
  version: Hex
  proofVerificationData: { vkeyHash: Hex; proof: Hex; publicInputs: Hex[] }
  committedInputs: Hex
  serviceConfig: { validityPeriodInSeconds: number; domain: string; scope: string; devMode: boolean }
}

/**
 * ABI-shaped passport params for `encodeFunctionData`/`encodeAbiParameters`.
 * The SDK returns `validityPeriodInSeconds` as a JS number; Solidity's
 * `uint256` requires a bigint, so the conversion happens here — at the encode
 * boundary — rather than via type casts at every call site.
 */
export type PassportProofParamsAbi = {
  version: Hex
  proofVerificationData: { vkeyHash: Hex; proof: Hex; publicInputs: Hex[] }
  committedInputs: Hex
  serviceConfig: { validityPeriodInSeconds: bigint; domain: string; scope: string; devMode: boolean }
}

export function toAbiParams(params: PassportProofParams): PassportProofParamsAbi {
  return {
    ...params,
    serviceConfig: { ...params.serviceConfig, validityPeriodInSeconds: BigInt(params.serviceConfig.validityPeriodInSeconds) },
  }
}

export type RecoveryProposal = {
  proposedOwner: Address
  executableAt: number
  nonce: bigint
}

export type RecoveryAccountState = {
  accountId: Hex
  sessionKey: Address
  sessionValidUntil: number
  guardianNullifier: Hex
  recoveryDelay: number
  guardianNonce: bigint
  recoveryNonce: bigint
  permanentOwner: Address
  recovery: RecoveryProposal
}

// ---------------------------------------------------------------------------
// Allowed delays (must match V2 contract constants)
// ---------------------------------------------------------------------------

export const RECOVERY_DELAYS = [
  { seconds: 0, label: 'Immediate' },
  { seconds: 24 * 60 * 60, label: '1 day' },
  { seconds: 3 * 24 * 60 * 60, label: '3 days' },
  { seconds: 7 * 24 * 60 * 60, label: '7 days' },
  { seconds: 30 * 24 * 60 * 60, label: '30 days' },
] as const

export const DEFAULT_RECOVERY_DELAY_SECONDS = 7 * 24 * 60 * 60

/**
 * Human label for a recovery delay in seconds. The zero case reads as a
 * noun phrase ("Immediate"), so call sites must phrase the sentence to fit:
 * "Recovery happens immediately" rather than "Recovery waits Immediate".
 */
export function formatRecoveryDelay(seconds: number): string {
  if (seconds === 0) return 'Immediate'
  const days = seconds / 86400
  return Number.isInteger(days) ? `${days} day${days === 1 ? '' : 's'}` : `${seconds}s`
}

// ---------------------------------------------------------------------------
// Canonical proof bindings (must match V2 contract _binding + _asciiHex)
// ---------------------------------------------------------------------------

const RECOVERY_DOMAIN = keccak256(toHex('ZKLOGIN_PASSPORT_RECOVERY_V2'))
export const ACTION_SET_GUARDIAN = keccak256(toHex('SET_GUARDIAN'))
export const ACTION_PROPOSE_RECOVERY = keccak256(toHex('PROPOSE_RECOVERY'))

export function recoveryBinding(args: {
  chainId: number
  kernel: Address
  action: Hex
  proposedOwner: Address
  guardianNonce: bigint
  recoveryNonce: bigint
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint64' },
        { type: 'uint64' },
      ],
      [RECOVERY_DOMAIN, BigInt(args.chainId), getAddress(args.kernel), args.action, getAddress(args.proposedOwner), args.guardianNonce, args.recoveryNonce],
    ),
  )
}

/** Lowercase 0x-prefixed ASCII hex — identical to the contract's `asciiHex`. */
export function bindingAsciiHex(binding: Hex): string {
  return binding.toLowerCase()
}

// ---------------------------------------------------------------------------
// Exact call-data builders (mirror the contract's _isExact* reconstruction)
// ---------------------------------------------------------------------------

const kernelExecuteAbi = parseAbi(['function execute(bytes32 execMode,bytes executionCalldata)'])

/** Inner `proposeRecovery(params, proposedOwner, recoveryNonce)` call. */
export function makeProposeInnerData(args: { params: PassportProofParams; proposedOwner: Address; recoveryNonce: bigint }): Hex {
  return encodeFunctionData({
    abi: recoveryAbi,
    functionName: 'proposeRecovery',
    args: [toAbiParams(args.params), args.proposedOwner, args.recoveryNonce],
  })
}

/** Kernel `execute` wrapper around proposeRecovery — the mode-0x02 exact call data. */
export function makeProposeCallData(args: { validatorAddress: Address; params: PassportProofParams; proposedOwner: Address; recoveryNonce: bigint }): Hex {
  return encodeFunctionData({
    abi: kernelExecuteAbi,
    functionName: 'execute',
    args: [pad(toHex(0), { size: 32 }), concatHex([args.validatorAddress, toHex(0n, { size: 32 }), makeProposeInnerData(args)])],
  })
}

/** Inner `finalizeRecovery(recoveryNonce)` call. */
export function makeFinalizeInnerData(recoveryNonce: bigint): Hex {
  return encodeFunctionData({ abi: recoveryAbi, functionName: 'finalizeRecovery', args: [recoveryNonce] })
}

/** Kernel `execute` wrapper around finalizeRecovery — the mode-0x03 exact call data. */
export function makeFinalizeCallData(args: { validatorAddress: Address; recoveryNonce: bigint }): Hex {
  return encodeFunctionData({
    abi: kernelExecuteAbi,
    functionName: 'execute',
    args: [pad(toHex(0), { size: 32 }), concatHex([args.validatorAddress, toHex(0n, { size: 32 }), makeFinalizeInnerData(args.recoveryNonce)])],
  })
}

/** Inner `setGuardian(params, delay)` call (executed via session/proof modes). */
export function makeSetGuardianInnerData(args: { params: PassportProofParams; delaySeconds: number }): Hex {
  return encodeFunctionData({ abi: recoveryAbi, functionName: 'setGuardian', args: [toAbiParams(args.params), args.delaySeconds] })
}

/** Inner `cancelRecovery()` call. */
export function makeCancelInnerData(): Hex {
  return encodeFunctionData({ abi: recoveryAbi, functionName: 'cancelRecovery' })
}

/** Inner `clearGuardian()` call. */
export function makeClearGuardianInnerData(): Hex {
  return encodeFunctionData({ abi: recoveryAbi, functionName: 'clearGuardian' })
}

// ---------------------------------------------------------------------------
// Local recovery key lifecycle
// ---------------------------------------------------------------------------

export function recoveryStorageKey(args: { chainId: number; kernelAddress: Address; recoveryNonce: bigint | number }): string {
  return `zklogin.recovery.${args.chainId}.${getAddress(args.kernelAddress)}.${args.recoveryNonce.toString()}`
}

/** Generates a local secp256k1 owner key and stores ONLY the raw key. */
export function createLocalRecoveryKey(args: { chainId: number; kernelAddress: Address; recoveryNonce: bigint | number }): { privateKey: Hex; address: Address } {
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  localStorage.setItem(recoveryStorageKey(args), privateKey)
  return { privateKey, address: account.address }
}

/** Reads the stored raw key, validating its byte length. */
export function loadLocalRecoveryKey(args: { chainId: number; kernelAddress: Address; recoveryNonce: bigint | number }): { privateKey: Hex; address: Address } | null {
  const raw = localStorage.getItem(recoveryStorageKey(args))
  if (!raw) return null
  if (!isHex(raw) || size(raw) !== 32) {
    localStorage.removeItem(recoveryStorageKey(args))
    return null
  }
  try {
    const account = privateKeyToAccount(raw)
    return { privateKey: raw, address: account.address }
  } catch {
    localStorage.removeItem(recoveryStorageKey(args))
    return null
  }
}

/** Deletes the local key — used on cancel/replace and explicit forget. */
export function deleteLocalRecoveryKey(args: { chainId: number; kernelAddress: Address; recoveryNonce: bigint | number }): void {
  localStorage.removeItem(recoveryStorageKey(args))
}

// Recovered-wallet marker: lets refresh restore the local-owner dashboard
// without a Google session (recovery is keyed by the local key, not Google).
// ---------------------------------------------------------------------------

export function recoveredWalletKey(chainId: number): string {
  return `zklogin.recovered.${chainId}`
}

/** Records which kernel this browser holds the local owner key for. */
export function rememberRecoveredWallet(chainId: number, kernelAddress: Address): void {
  localStorage.setItem(recoveredWalletKey(chainId), getAddress(kernelAddress))
}

/** Returns the remembered kernel, or null when no recovery marker exists. */
export function loadRecoveredWallet(chainId: number): Address | null {
  const raw = localStorage.getItem(recoveredWalletKey(chainId))
  return raw && isAddress(raw) ? getAddress(raw) : null
}

/** Clears the marker — used on forget/transfer-out of a recovered wallet. */
export function forgetRecoveredWallet(chainId: number): void {
  localStorage.removeItem(recoveredWalletKey(chainId))
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function assertChecksummedAddress(value: string): Address {
  if (!isAddress(value)) throw new Error('INVALID_ADDRESS')
  return getAddress(value)
}

// ---------------------------------------------------------------------------
// Pure view-model helpers (unit-testable without a DOM)
// ---------------------------------------------------------------------------

export type RecoverySurfaceKind = 'absent' | 'pending' | 'unsafe' | 'none'

/**
 * Maps on-chain recovery state to the dashboard banner surface. A wallet
 * with a guardian installed shows no banner ('none'); otherwise absent →
 * setup prompt, pending proposal → cancel banner, permanent local owner →
 * unsafe warning. `guardianNullifier` is bytes32, so it must be compared
 * against the 32-byte zero (never the 20-byte zeroAddress).
 */
export function recoverySurfaceKind(state: RecoveryAccountState): RecoverySurfaceKind {
  if (state.permanentOwner !== zeroAddress) return 'unsafe'
  if (state.recovery.proposedOwner !== zeroAddress) return 'pending'
  if (state.guardianNullifier !== zeroHash) return 'none'
  return 'absent'
}

/** Formats a remaining-seconds countdown; boundaries are presentation-only. */
export function formatRecoveryCountdown(remainingSeconds: number): string {
  if (remainingSeconds <= 0) return 'Deadline reached'
  const h = Math.floor(remainingSeconds / 3600)
  const m = Math.floor((remainingSeconds % 3600) / 60)
  const s = remainingSeconds % 60
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`
}
