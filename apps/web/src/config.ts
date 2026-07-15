import { getAddress, isAddress, isHex, size, zeroAddress, zeroHash } from 'viem'
import { megaethTestnet } from 'viem/chains'
import deployment from './generated/deployment-megaeth.json'

function envReq(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing configuration: ${name}`)
  return value
}

function bytes32(name: string, value: string): `0x${string}` {
  if (!isHex(value) || size(value) !== 32 || value === zeroHash) {
    throw new Error(`${name} must be a non-zero bytes32`)
  }
  return value
}

function deployedAddress(name: string, value: string) {
  if (!isAddress(value) || getAddress(value) === zeroAddress) {
    throw new Error(`${name} is not deployed; complete deployment generation`)
  }
  return getAddress(value)
}

if (deployment.generation < 1 || deployment.chainId !== 6343) {
  throw new Error('Invalid or template deployment generation')
}

// Use direct import.meta.env.VITE_* access — Vite 8/Rolldown only inlines dot notation, not bracket/computed.
const googleClientId = envReq('VITE_GOOGLE_CLIENT_ID', import.meta.env.VITE_GOOGLE_CLIENT_ID)
const zeroDevProjectId = envReq('VITE_ZERODEV_PROJECT_ID', import.meta.env.VITE_ZERODEV_PROJECT_ID)
const rpcUrl = envReq('VITE_MEGAETH_TESTNET_RPC_URL', import.meta.env.VITE_MEGAETH_TESTNET_RPC_URL)
const redirectUrl = import.meta.env.VITE_REDIRECT_URL

export const config = Object.freeze({
  chain: megaethTestnet,
  chainId: 6343,
  publicRpcUrl: rpcUrl,
  zeroDevRpcUrl: `https://rpc.zerodev.app/api/v3/${zeroDevProjectId}/chain/6343`,
  googleClientId,
  validatorAddress: deployedAddress('validator', deployment.validator),
  ultraVerifierAddress: deployedAddress('ultraVerifier', deployment.ultraVerifier),
  jwkRoot: bytes32('googleJwkRoot', deployment.googleJwkRoot),
  appId: bytes32('appId', deployment.appId),
  redirectOrigin: (redirectUrl && redirectUrl !== 'window.location.origin')
    ? redirectUrl
    : window.location.origin,
})
