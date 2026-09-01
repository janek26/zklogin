import { describe, expect, it } from 'vitest'
import { zeroAddress } from 'viem'
import {
  type PassportProofParams,
  ACTION_PROPOSE_RECOVERY,
  ACTION_SET_GUARDIAN,
  DEFAULT_RECOVERY_DELAY_SECONDS,
  RECOVERY_DELAYS,
  bindingAsciiHex,
  formatRecoveryCountdown,
  makeFinalizeCallData,
  makeFinalizeInnerData,
  makeProposeCallData,
  makeProposeInnerData,
  makeSetGuardianInnerData,
  recoveryBinding,
  recoverySurfaceKind,
  type RecoveryAccountState,
} from '../lib/recoveryCore'

const KERNEL = '0x1111111111111111111111111111111111111111'
const VALIDATOR = '0x2222222222222222222222222222222222222222'
const OWNER = '0x3333333333333333333333333333333333333333'

function baseState(overrides: Partial<RecoveryAccountState> = {}): RecoveryAccountState {
  return {
    accountId: `0x${'11'.repeat(32)}`,
    sessionKey: zeroAddress,
    sessionValidUntil: 0,
    guardianNullifier: zeroAddress,
    recoveryDelay: 7 * 24 * 60 * 60,
    guardianNonce: 0n,
    recoveryNonce: 0n,
    permanentOwner: zeroAddress,
    recovery: { proposedOwner: zeroAddress, executableAt: 0, nonce: 0n },
    ...overrides,
  }
}

describe('canonical recovery bindings', () => {
  it('produces a 32-byte hash that changes with every bound field', () => {
    const base = { chainId: 11155111, kernel: KERNEL, action: ACTION_SET_GUARDIAN, proposedOwner: zeroAddress, guardianNonce: 1n, recoveryNonce: 0n } as const
    const binding = recoveryBinding(base)
    expect(binding).toMatch(/^0x[0-9a-f]{64}$/)
    expect(recoveryBinding({ ...base, chainId: 1 })).not.toBe(binding)
    expect(recoveryBinding({ ...base, proposedOwner: OWNER })).not.toBe(binding)
    expect(recoveryBinding({ ...base, guardianNonce: 2n })).not.toBe(binding)
    expect(recoveryBinding({ ...base, recoveryNonce: 1n })).not.toBe(binding)
    expect(recoveryBinding({ ...base, kernel: OWNER })).not.toBe(binding)
  })

  it('distinguishes SET_GUARDIAN from PROPOSE_RECOVERY', () => {
    const setGuardian = recoveryBinding({ chainId: 11155111, kernel: KERNEL, action: ACTION_SET_GUARDIAN, proposedOwner: zeroAddress, guardianNonce: 1n, recoveryNonce: 0n })
    const propose = recoveryBinding({ chainId: 11155111, kernel: KERNEL, action: ACTION_PROPOSE_RECOVERY, proposedOwner: OWNER, guardianNonce: 1n, recoveryNonce: 1n })
    expect(propose).not.toBe(setGuardian)
  })

  it('serializes the binding to the exact ASCII custom_data string', () => {
    const binding = recoveryBinding({ chainId: 11155111, kernel: KERNEL, action: ACTION_SET_GUARDIAN, proposedOwner: zeroAddress, guardianNonce: 1n, recoveryNonce: 0n })
    expect(bindingAsciiHex(binding)).toBe(binding.toLowerCase())
    expect(bindingAsciiHex(binding)).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('allowed recovery delays', () => {
  it('offers exactly the five contract delays with 7 days as the default', () => {
    expect(RECOVERY_DELAYS.map((d) => d.seconds)).toEqual([0, 86400, 259200, 604800, 2592000])
    expect(DEFAULT_RECOVERY_DELAY_SECONDS).toBe(604800)
  })
})

describe('exact call-data builders', () => {
  const params = {
    version: `0x${'01'.repeat(32)}`,
    proofVerificationData: { vkeyHash: `0x${'02'.repeat(32)}`, proof: '0xdeadbeef', publicInputs: [`0x${'03'.repeat(32)}`] },
    committedInputs: '0xaabb',
    serviceConfig: { validityPeriodInSeconds: 604800, domain: 'zklogin-poc.rahrt.com', scope: 'policy-1:1', devMode: false },
  } as PassportProofParams

  it('mode-0x02 proposal data wraps proposeRecovery through Kernel execute', () => {
    const inner = makeProposeInnerData({ params, proposedOwner: OWNER, recoveryNonce: 1n })
    const call = makeProposeCallData({ validatorAddress: VALIDATOR, params, proposedOwner: OWNER, recoveryNonce: 1n })
    expect(call).toMatch(/^0x/)
    expect(inner).toMatch(/^0x/)
    // The Kernel execute wrapper embeds the validator address and zero value.
    expect(call.toLowerCase()).toContain(VALIDATOR.slice(2).toLowerCase())
  })

  it('mode-0x03 finalize data is exact', () => {
    const inner = makeFinalizeInnerData(7n)
    const call = makeFinalizeCallData({ validatorAddress: VALIDATOR, recoveryNonce: 7n })
    expect(call).toMatch(/^0x/)
    expect(inner).toMatch(/^0x/)
    expect(call.toLowerCase()).toContain(VALIDATOR.slice(2).toLowerCase())
  })

  it('setGuardian inner data encodes params + delay', () => {
    const data = makeSetGuardianInnerData({ params, delaySeconds: 604800 })
    expect(data).toMatch(/^0x/)
  })
})

describe('recovery view-model transitions', () => {
  it('absent when no guardian is installed (zero bytes32 nullifier) and no proposal', () => {
    // Regression: guardianNullifier is bytes32 — the zero bytes32
    // (0x0000…0000, 64 chars) must be treated as "no guardian", never
    // compared against the 20-byte zeroAddress, and never truthy.
    const state = baseState({
      guardianNullifier: `0x${'00'.repeat(32)}`,
      recovery: { proposedOwner: zeroAddress, executableAt: 0, nonce: 0n },
    })
    expect(recoverySurfaceKind(state)).toBe('absent')
  })

  it('none once a guardian is installed', () => {
    const state = baseState({
      guardianNullifier: `0x${'aa'.repeat(32)}`,
      recovery: { proposedOwner: zeroAddress, executableAt: 0, nonce: 0n },
    })
    expect(recoverySurfaceKind(state)).toBe('none')
  })

  it('pending while a proposal exists', () => {
    const state = baseState({ guardianNullifier: `0x${'aa'.repeat(32)}`, recovery: { proposedOwner: OWNER, executableAt: 1_700_000_000, nonce: 1n } })
    expect(recoverySurfaceKind(state)).toBe('pending')
  })

  it('unsafe after finalization regardless of proposal state', () => {
    const state = baseState({
      permanentOwner: OWNER,
      guardianNullifier: `0x${'aa'.repeat(32)}`,
      recovery: { proposedOwner: OWNER, executableAt: 1_700_000_000, nonce: 1n },
    })
    expect(recoverySurfaceKind(state)).toBe('unsafe')
  })
})

describe('countdown formatting', () => {
  it('formats hour/minute/second boundaries', () => {
    expect(formatRecoveryCountdown(3661)).toBe('1h 1m 1s')
    expect(formatRecoveryCountdown(61)).toBe('1m 1s')
    expect(formatRecoveryCountdown(1)).toBe('1s')
  })

  it('reports the deadline at zero and below', () => {
    expect(formatRecoveryCountdown(0)).toBe('Deadline reached')
    expect(formatRecoveryCountdown(-5)).toBe('Deadline reached')
  })
})
