export type Stage = 'PREPARING' | 'GOOGLE_READY' | 'PROVING' | 'ACTIVATING' | 'READY' | 'SENDING' | 'ERROR'

import type { createWalletClients } from '../aa/client'
export type Wallet = Awaited<ReturnType<typeof createWalletClients>>

import type { Address, Hex } from 'viem'
export type StoredReadySession = { version: 1; privateKey: Hex; sessionKey: Address; validUntil: number; randomness: Hex; accountId: Hex; kernelAddress: Address }

export type SendAction = { type: 'SEND_START' } | { type: 'SEND_DONE' }
