import { getAddress, isAddress, isHex, size, zeroAddress, zeroHash } from 'viem'
// Google OAuth client ID from VITE_GOOGLE_CLIENT_ID env var at build time
import { megaethTestnet } from 'viem/chains'
import deployment from './generated/deployment-megaeth.json'

function required(name: string): string {
  const value = import.meta.env[name]
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

const projectId = required('VITE_ZERODEV_PROJECT_ID')

export const config = Object.freeze({
  chain: megaethTestnet,
  chainId: 6343,
  publicRpcUrl: required('VITE_MEGAETH_TESTNET_RPC_URL'),
  zeroDevRpcUrl: `https://rpc.zerodev.app/api/v3/${projectId}/chain/6343`,
  googleClientId: required('VITE_GOOGLE_CLIENT_ID'),
  validatorAddress: deployedAddress('validator', deployment.validator),
  ultraVerifierAddress: deployedAddress('ultraVerifier', deployment.ultraVerifier),
  jwkRoot: bytes32('googleJwkRoot', deployment.googleJwkRoot),
  appId: bytes32('appId', deployment.appId),
})
