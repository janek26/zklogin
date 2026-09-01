import { readFile } from 'node:fs/promises'
import { createPublicClient, getAddress, http, keccak256 } from 'viem'
import { sepolia } from 'viem/chains'

const rpcUrl = process.env.SEPOLIA_RPC_URL ?? 'https://eth-sepolia.g.alchemy.com/v2/alch_5OJye4DK3Nyur-3ivzvOC'
const deployment = JSON.parse(await readFile(new URL('../apps/web/src/generated/deployment-sepolia.json', import.meta.url)))
if (deployment.generation < 1) throw new Error('deployment-sepolia.json is a template')
const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
const addresses = {
  entryPoint: deployment.entryPoint,
  kernelImplementation: deployment.kernelImplementation,
  kernelFactory: deployment.kernelFactory,
  kernelMetaFactory: deployment.kernelMetaFactory,
  ultraVerifier: deployment.ultraVerifier,
  validator: deployment.validator,
  zkPassportVerifier: deployment.zkPassportVerifier,
}
for (const [name, raw] of Object.entries(addresses)) {
  const address = getAddress(raw)
  const code = await client.getCode({ address })
  if (!code || code === '0x') throw new Error(`Missing runtime code: ${name} ${address}`)
  console.log(`${name} ${address} ${keccak256(code)}`)
}
const abi = [
  { type: 'function', name: 'googleProofVerifier', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'googleJwkRoot', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'appId', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'zkPassportVerifier', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
]
const [verifier, root, appId, zkPassportVerifier] = await Promise.all(['googleProofVerifier', 'googleJwkRoot', 'appId', 'zkPassportVerifier'].map((functionName) => client.readContract({ address: getAddress(deployment.validator), abi, functionName })))
if (getAddress(verifier) !== getAddress(deployment.ultraVerifier) || root.toLowerCase() !== deployment.googleJwkRoot.toLowerCase() || appId.toLowerCase() !== deployment.appId.toLowerCase() || getAddress(zkPassportVerifier) !== getAddress(deployment.zkPassportVerifier)) throw new Error('Validator immutable configuration mismatch')
console.log('Deployment preflight passed')
