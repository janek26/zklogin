import type { Address, Hex } from 'viem'
import { createPublicClient, http } from 'viem'
import { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient } from '@zerodev/sdk'
import { KERNEL_V3_3, getEntryPoint } from '@zerodev/sdk/constants'
import type { KernelValidator } from '@zerodev/sdk/types'
import type { KernelAccountClient, CreateKernelAccountReturnType } from '@zerodev/sdk'
import { config } from '../config'

export const entryPoint = getEntryPoint('0.7')
export const kernelVersion = KERNEL_V3_3

// L1 Sepolia confirms at ~12s/block. Polling at 4s (viem's standard default)
// notices a confirmation within one block without spamming the RPC.
export const publicClient = createPublicClient({ chain: config.chain, transport: http(config.publicRpcUrl), pollingInterval: 4_000 })

export interface WalletClients {
  account: CreateKernelAccountReturnType
  kernelClient: KernelAccountClient
}

export async function createWalletClients(validator: KernelValidator<'ZkLoginKernelValidator' | 'RecoveryValidator'>): Promise<WalletClients> {
  const account = await createKernelAccount(publicClient, { entryPoint, kernelVersion, index: 0n, plugins: { sudo: validator } })
  const paymasterClient = createZeroDevPaymasterClient({ chain: config.chain, transport: http(config.zeroDevRpcUrl) })
  const sponsor = async (userOperation: Parameters<typeof paymasterClient.sponsorUserOperation>[0]['userOperation']) => paymasterClient.sponsorUserOperation({ userOperation })
  const kernelClient = createKernelAccountClient({
    account, chain: config.chain, client: publicClient, bundlerTransport: http(config.zeroDevRpcUrl),
    paymaster: { getPaymasterStubData: sponsor, getPaymasterData: sponsor },
    pollingInterval: 4_000,
  })
  return { account, kernelClient }
}

/** Address-based account construction for recovery: derive the same Kernel the
 * wallet already uses, then verify the derivation matches. */
export async function createRecoveryWalletClients(validator: KernelValidator<'RecoveryValidator'>, expectedKernelAddress: Address): Promise<WalletClients> {
  const clients = await createWalletClients(validator as KernelValidator<'ZkLoginKernelValidator' | 'RecoveryValidator'>)
  if (clients.account.address.toLowerCase() !== expectedKernelAddress.toLowerCase()) {
    throw new Error('KERNEL_ADDRESS_DERIVATION_MISMATCH')
  }
  return clients
}

export async function waitForSuccess(kernelClient: WalletClients['kernelClient'], hash: Hex) {
  // 4s retryInterval (matching client polling) × 45 = up to 3 minutes for the
  // UserOperation to confirm on L1 Sepolia before giving up.
  const receipt = await kernelClient.waitForUserOperationReceipt({ hash, timeout: 180_000, retryCount: 45 })
  if (!receipt.success) throw new Error('USER_OPERATION_REVERTED')
  return receipt
}
