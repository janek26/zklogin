import { type Address, type Hex, encodeAbiParameters, keccak256, toBytes, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { config } from '../config'

export const SESSION_DOMAIN = keccak256(toBytes('ZKLOGIN_KERNEL_SESSION_V1'))

export type PreLoginSession = {
  privateKey: Hex
  sessionKey: Address
  sessionValidUntil: number
  randomness: Hex
  nonce: Hex
  googleNonce: string
  preparedAt: number
}

export function computeSessionNonce(args: {
  chainId: bigint
  validatorAddress: Address
  appId: Hex
  sessionKey: Address
  sessionValidUntil: number
  randomness: Hex
}): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint48' }, { type: 'bytes32' }],
    [SESSION_DOMAIN, args.chainId, args.validatorAddress, args.appId, args.sessionKey, args.sessionValidUntil, args.randomness],
  ))
}

export function createPreLoginSession(): PreLoginSession {
  const privateKey = generatePrivateKey()
  const sessionSigner = privateKeyToAccount(privateKey)
  const preparedAt = Math.floor(Date.now() / 1000)
  const sessionValidUntil = preparedAt + 24 * 60 * 60
  const randomness = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const nonce = computeSessionNonce({
    chainId: BigInt(config.chainId), validatorAddress: config.validatorAddress,
    appId: config.appId, sessionKey: sessionSigner.address, sessionValidUntil, randomness,
  })
  return { privateKey, sessionKey: sessionSigner.address, sessionValidUntil, randomness, nonce, googleNonce: nonce.slice(2).toLowerCase(), preparedAt }
}
