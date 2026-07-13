import type { Hex } from 'viem'
import { createPublicClient, http } from 'viem'
import { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient } from '@zerodev/sdk'
import { KERNEL_V3_3, getEntryPoint } from '@zerodev/sdk/constants'
import type { KernelValidator } from '@zerodev/sdk/types'
import { config } from '../config'

export const entryPoint = getEntryPoint('0.7')
export const kernelVersion = KERNEL_V3_3
export const publicClient = createPublicClient({ chain: config.chain, transport: http(config.publicRpcUrl) })

export async function createWalletClients(validator: KernelValidator<'ZkLoginKernelValidator'>) {
  const account = await createKernelAccount(publicClient, { entryPoint, kernelVersion, index: 0n, plugins: { sudo: validator } })
  const paymasterClient = createZeroDevPaymasterClient({ chain: config.chain, transport: http(config.zeroDevRpcUrl) })
  const sponsor = async (userOperation: Parameters<typeof paymasterClient.sponsorUserOperation>[0]['userOperation']) => paymasterClient.sponsorUserOperation({ userOperation })
  const kernelClient = createKernelAccountClient({
    account, chain: config.chain, client: publicClient, bundlerTransport: http(config.zeroDevRpcUrl),
    paymaster: { getPaymasterStubData: sponsor, getPaymasterData: sponsor },
  })
  return { account, kernelClient }
}

export async function waitForSuccess(kernelClient: Awaited<ReturnType<typeof createWalletClients>>['kernelClient'], hash: Hex) {
  const receipt = await kernelClient.waitForUserOperationReceipt({ hash, timeout: 120_000, retryCount: 60 })
  if (!receipt.success) throw new Error('USER_OPERATION_REVERTED')
  return receipt
}
