import { getAddress, isAddress, isHex, size, zeroAddress, zeroHash } from 'viem'
import { sepolia } from 'viem/chains'
import deployment from './generated/deployment-sepolia.json'

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

if (deployment.generation < 1 || deployment.chainId !== 11155111) {
  throw new Error('Invalid or template deployment generation')
}

// Use direct import.meta.env.VITE_* access — Vite 8/Rolldown only inlines dot notation, not bracket/computed.
const googleClientId = envReq('VITE_GOOGLE_CLIENT_ID', import.meta.env.VITE_GOOGLE_CLIENT_ID)
const zeroDevProjectId = envReq('VITE_ZERODEV_PROJECT_ID', import.meta.env.VITE_ZERODEV_PROJECT_ID)
const rpcUrl = envReq('VITE_SEPOLIA_RPC_URL', import.meta.env.VITE_SEPOLIA_RPC_URL)
const redirectUrl = import.meta.env.VITE_REDIRECT_URL

export const config = Object.freeze({
  chain: sepolia,
  chainId: 11155111,
  publicRpcUrl: rpcUrl,
  zeroDevRpcUrl: `https://rpc.zerodev.app/api/v3/${zeroDevProjectId}/chain/11155111`,
  googleClientId,
  validatorAddress: deployedAddress('validator', deployment.validator),
  ultraVerifierAddress: deployedAddress('ultraVerifier', deployment.ultraVerifier),
  jwkRoot: bytes32('googleJwkRoot', deployment.googleJwkRoot),
  appId: bytes32('appId', deployment.appId),
  // ZKPassport-operated Sepolia infrastructure (deterministic across chains,
  // per docs.zkpassport.id/getting-started/onchain). Used for a pre-submit
  // check that the proof's certificate root is still valid on-chain.
  zkPassportRootRegistry: '0x1D0000020038d6E40E1d98e09fA1bb3A7DAA8B70' as const,
  zkPassportCertificateRegistry: '0x5135c41430e263Fbf734Be9F1fE9F5833B81393F' as const,
  // Kernel factory salt. Bump to force every wallet to a fresh address: stored
  // sessions stop deriving (KERNEL_ADDRESS_DERIVATION_MISMATCH → reset), so all
  // users get a clean wallet with no legacy-state handling.
  walletSalt: 2n,
  redirectOrigin: (redirectUrl && redirectUrl !== 'window.location.origin')
    ? redirectUrl
    : window.location.origin,
})
