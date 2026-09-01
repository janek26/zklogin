import type { Address } from 'viem'
import { getAddress } from 'viem'
import { publicClient } from '../aa/client'
import { config } from '../config'
import {
  recoveryAbi,
  type RecoveryAccountState,
} from './recoveryCore'

// Re-export the config-free core so existing imports keep working.
export * from './recoveryCore'

// ---------------------------------------------------------------------------
// Public state reads (needs chain config — kept out of recoveryCore so tests
// can import the pure helpers without VITE_* env vars).
// ---------------------------------------------------------------------------

export async function readRecoveryState(kernel: Address): Promise<RecoveryAccountState> {
  const [accountId, sessionKey, sessionValidUntil, guardianNullifier, recoveryDelay, guardianNonce, recoveryNonce, permanentOwner, recovery] =
    await publicClient.readContract({
      address: config.validatorAddress,
      abi: recoveryAbi,
      functionName: 'accountState',
      args: [getAddress(kernel)],
    })
  return {
    accountId,
    sessionKey,
    sessionValidUntil,
    guardianNullifier,
    recoveryDelay,
    guardianNonce,
    recoveryNonce,
    permanentOwner,
    recovery: { proposedOwner: recovery.proposedOwner, executableAt: recovery.executableAt, nonce: recovery.nonce },
  }
}
