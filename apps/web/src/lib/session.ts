import { parseAbi } from 'viem'
import type { Address, Hex } from 'viem'

import { createPreLoginSession, type PreLoginSession } from '../auth/nonce'
import { publicClient } from '../aa/client'
import { config } from '../config'
import { PRELOGIN_KEY } from './utils'
import type { StoredReadySession } from './types'

export const validatorStateAbi = parseAbi(['function accountState(address kernel) view returns (bytes32 accountId,address sessionKey,uint48 sessionValidUntil)'])

export function loadOrCreatePreLogin(): PreLoginSession {
  const raw = sessionStorage.getItem(PRELOGIN_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PreLoginSession
      if (Number.isInteger(parsed.preparedAt) && Number.isInteger(parsed.sessionValidUntil) && Math.floor(Date.now() / 1000) - parsed.preparedAt <= 300) return parsed
    } catch { /* regenerate */ }
  }
  const created = createPreLoginSession()
  sessionStorage.setItem(PRELOGIN_KEY, JSON.stringify(created))
  return created
}

export async function assertActivated(expected: { kernel: Address; accountId: Hex; sessionKey: Address; validUntil: number }) {
  const code = await publicClient.getCode({ address: expected.kernel })
  if (!code || code === '0x') throw new Error('KERNEL_NOT_DEPLOYED')
  const [accountId, sessionKey, validUntil] = await publicClient.readContract({ address: config.validatorAddress, abi: validatorStateAbi, functionName: 'accountState', args: [expected.kernel] })
  if (accountId.toLowerCase() !== expected.accountId.toLowerCase() || sessionKey.toLowerCase() !== expected.sessionKey.toLowerCase() || validUntil !== expected.validUntil) throw new Error('ACTIVATION_POSTCONDITION_FAILED')
}
