import { readFile } from 'node:fs/promises'
import { createPublicClient, getAddress, http, keccak256 } from 'viem'
import { megaethTestnet } from 'viem/chains'

const rpcUrl = process.env.MEGAETH_TESTNET_RPC_URL ?? 'https://carrot.megaeth.com/rpc'
const deployment = JSON.parse(await readFile(new URL('../apps/web/src/generated/deployment-megaeth.json', import.meta.url)))
if (deployment.generation < 1) throw new Error('deployment-megaeth.json is a template')
const client = createPublicClient({ chain: megaethTestnet, transport: http(rpcUrl) })
const addresses = {
  entryPoint: deployment.entryPoint,
  kernelImplementation: deployment.kernelImplementation,
  kernelFactory: deployment.kernelFactory,
  kernelMetaFactory: deployment.kernelMetaFactory,
  ultraVerifier: deployment.ultraVerifier,
  validator: deployment.validator,
}
for (const [name, raw] of Object.entries(addresses)) {
  const address = getAddress(raw)
  const code = await client.getCode({ address })
  if (!code || code === '0x') throw new Error(`Missing runtime code: ${name} ${address}`)
  console.log(`${name} ${address} ${keccak256(code)}`)
}
const abi = [
  { type: 'function', name: 'proofVerifier', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'googleJwkRoot', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'appId', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
] 
const [verifier, root, appId] = await Promise.all(['proofVerifier', 'googleJwkRoot', 'appId'].map((functionName) => client.readContract({ address: getAddress(deployment.validator), abi, functionName })))
if (getAddress(verifier) !== getAddress(deployment.ultraVerifier) || root.toLowerCase() !== deployment.googleJwkRoot.toLowerCase() || appId.toLowerCase() !== deployment.appId.toLowerCase()) throw new Error('Validator immutable configuration mismatch')
console.log('Deployment preflight passed')
