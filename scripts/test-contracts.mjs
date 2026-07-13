import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ganache from 'ganache'
import solc from 'solc'
import {
  AbiCoder,
  BrowserProvider,
  ContractFactory,
  Interface,
  Wallet,
  ZeroHash,
  concat,
  getBytes,
  hexlify,
  id,
  keccak256,
  solidityPacked,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
} from 'ethers'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = 'contracts/src/ZkLoginKernelValidator.sol'
const helperPath = 'contracts/test/ProtocolTestHelpers.sol'
const sources = Object.fromEntries(await Promise.all([sourcePath, helperPath].map(async (file) => [file, { content: await readFile(resolve(root, file), 'utf8') }])))
const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: (path) => {
  // Ganache currently supports Shanghai. The production dependency's
  // MessageHashUtils also imports unrelated Cancun-only helper code. This
  // test-only shim provides the one byte-for-byte equivalent bytes32 helper
  // actually used by ZkLoginKernelValidator; it does not alter production
  // sources or dependencies.
  if (path === '@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol') {
    return { contents: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
library MessageHashUtils {
  function toEthSignedMessageHash(bytes32 messageHash) internal pure returns (bytes32 digest) {
    assembly ("memory-safe") {
      mstore(0x00, "\\x19Ethereum Signed Message:\\n32")
      mstore(0x1c, messageHash)
      digest := keccak256(0x00, 0x3c)
    }
  }
}` }
  }
  const candidates = [resolve(root, 'node_modules', path), resolve(root, 'contracts', path), resolve(root, path)]
  for (const candidate of candidates) {
    try { return { contents: readFileSync(candidate, 'utf8') } } catch { /* next */ }
  }
  return { error: `Import not found: ${path}` }
} }))
if (output.errors?.some((item) => item.severity === 'error')) throw new Error(output.errors.map((item) => item.formattedMessage).join('\n'))

function artifact(source, contract) {
  const item = output.contracts[source]?.[contract]
  if (!item?.evm.bytecode.object) throw new Error(`Missing compiled artifact ${source}:${contract}`)
  return { abi: item.abi, bytecode: `0x${item.evm.bytecode.object}` }
}
async function deploy(signer, source, contract, args = []) {
  const { abi, bytecode } = artifact(source, contract)
  const deployed = await new ContractFactory(abi, bytecode, signer).deploy(...args)
  await deployed.waitForDeployment()
  return deployed
}
function inputsFor(accountId, jwtIat, publicKeyHash, nonce) {
  const symbols = '0123456789abcdef'
  const fields = [accountId, zeroPadValue(toBeHex(jwtIat), 32), publicKeyHash]
  for (const byte of getBytes(nonce)) {
    fields.push(zeroPadValue(hexlify(Uint8Array.of(symbols.charCodeAt(byte >> 4))), 32))
    fields.push(zeroPadValue(hexlify(Uint8Array.of(symbols.charCodeAt(byte & 15))), 32))
  }
  assert.equal(fields.length, 67)
  return fields
}

const ganacheProvider = ganache.provider({ chain: { chainId: 84532, hardfork: 'shanghai' }, logging: { quiet: true }, wallet: { totalAccounts: 5, defaultBalance: 1_000 } })
const provider = new BrowserProvider(ganacheProvider)
const owner = await provider.getSigner(0)
const session = new Wallet(Object.values(ganacheProvider.getInitialAccounts())[1].secretKey, provider)
const accountId = id('account-id')
const publicKeyHash = id('google-jwk-hash')
const appId = id('app-id')
const jwtIat = BigInt((await provider.getBlock('latest')).timestamp)
const validUntil = jwtIat + 3_600n
const randomness = id('randomness')
const leaf = keccak256(concat([keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32'], [publicKeyHash]))]))
const verifier = await deploy(owner, helperPath, 'StrictMockVerifier')
const validator = await deploy(owner, sourcePath, 'ZkLoginKernelValidator', [await verifier.getAddress(), leaf, appId])
const kernel = await deploy(owner, helperPath, 'NodeKernelCaller')
const kernelAddress = await kernel.getAddress()
const sessionAddress = await session.getAddress()
const validatorAddress = await validator.getAddress()
await (await kernel.install(validatorAddress, accountId)).wait()

const activationInterface = new Interface(['function activateSession(address sessionKey,uint48 validUntil,bytes32 randomness)'])
const executeInterface = new Interface(['function execute(bytes32 execMode,bytes executionCalldata)'])
const activationCallData = (sessionKey = sessionAddress, until = validUntil, salt = randomness, target = validatorAddress, value = 0n) => {
  const inner = activationInterface.encodeFunctionData('activateSession', [sessionKey, until, salt])
  return executeInterface.encodeFunctionData('execute', [ZeroHash, solidityPacked(['address', 'uint256', 'bytes'], [target, value, inner])])
}
const currentNonce = await validator.sessionNonce(sessionAddress, validUntil, randomness)
await (await verifier.setExpectedInputs(inputsFor(accountId, jwtIat, publicKeyHash, currentNonce))).wait()
const proofTuple = 'tuple(bytes proof,uint64 jwtIat,bytes32 publicKeyHash,bytes32[] jwkProof,address sessionKey,uint48 sessionValidUntil,bytes32 randomness,bytes sessionSignature)'
const signHash = async (hash) => session.signMessage(getBytes(hash))
const proofOperation = async ({ callData = activationCallData(), keyHash = publicKeyHash, sessionKey = sessionAddress, until = validUntil, salt = randomness, hash = id('valid-userop'), signature } = {}) => {
  const sessionSignature = signature ?? await signHash(hash)
  const encoded = AbiCoder.defaultAbiCoder().encode([proofTuple], [[
    '0x0102', jwtIat, keyHash, [], sessionKey, until, salt, sessionSignature,
  ]])
  return {
    sender: kernelAddress, nonce: 0n, initCode: '0x', callData,
    accountGasLimits: ZeroHash, preVerificationGas: 0n, gasFees: ZeroHash,
    paymasterAndData: '0x', signature: `0x00${encoded.slice(2)}`,
  }
}
const validateProof = async (args = {}) => {
  const hash = args.hash ?? id('valid-userop')
  return kernel.validate.staticCall(validatorAddress, await proofOperation({ ...args, hash }), hash)
}
const failed = 1n
const expectedProofData = ((jwtIat - 300n) << 208n) | ((jwtIat + 600n) << 160n)

assert.equal((await validator.accountState(kernelAddress))[0], accountId, 'onInstall stores account ID')
await assert.rejects(async () => (await kernel.install(validatorAddress, accountId)).wait(), /revert|AlreadyInitialized/i, 'second install must revert')
assert.equal(await validateProof(), expectedProofData, 'valid proof-mode operation must return bounded validation data')

await (await verifier.setResult(false, false)).wait()
assert.equal(await validateProof(), failed, 'false verifier result must fail validation')
await (await verifier.setResult(true, true)).wait()
assert.equal(await validateProof(), failed, 'reverting verifier must fail validation')
await (await verifier.setResult(true, false)).wait()

assert.equal(await validateProof({ keyHash: id('wrong-jwk') }), failed, 'JWK Merkle root must be enforced')
assert.equal(await validateProof({ salt: id('wrong-nonce') }), failed, 'nonce/public inputs must be proof-bound')
assert.equal(await validateProof({ callData: activationCallData(sessionAddress, validUntil, randomness, '0x000000000000000000000000000000000000bEEF') }), failed, 'activation target must be exact')
assert.equal(await validateProof({ callData: activationCallData(sessionAddress, validUntil, randomness, validatorAddress, 1n) }), failed, 'activation value must be zero')
assert.equal(await validateProof({ hash: id('changed-userop'), signature: await signHash(id('original-userop')) }), failed, 'temporary signature must bind the exact userOp hash')
assert.equal(await validateProof({ until: jwtIat }), failed, 'session must outlive jwtIat')
assert.equal(await validateProof({ until: jwtIat + 24n * 60n * 60n + 301n }), failed, 'session maximum must be enforced')

await (await kernel.activate(validatorAddress, sessionAddress, validUntil, randomness)).wait()
const state = await validator.accountState(kernelAddress)
assert.equal(state[1].toLowerCase(), sessionAddress.toLowerCase(), 'activation stores the temporary key')
assert.equal(state[2], validUntil, 'activation stores the requested expiry')
const sessionHash = id('session-userop')
const sessionSig = await signHash(sessionHash)
const sessionOperation = { sender: kernelAddress, nonce: 0n, initCode: '0x', callData: '0xdeadbeef', accountGasLimits: ZeroHash, preVerificationGas: 0n, gasFees: ZeroHash, paymasterAndData: '0x', signature: `0x01${sessionSig.slice(2)}` }
assert.equal(await kernel.validate.staticCall(validatorAddress, sessionOperation, sessionHash), validUntil << 160n, 'session mode intentionally accepts arbitrary callData')
assert.equal(await kernel.validate.staticCall(validatorAddress, sessionOperation, id('changed-session-userop')), failed, 'session mode binds the exact hash')
assert.equal(await validator.isValidSignatureWithSender(kernelAddress, ZeroHash, '0x'), '0xffffffff', 'ERC-1271 is deliberately disabled')
await (await kernel.uninstall(validatorAddress)).wait()
assert.equal((await validator.accountState(kernelAddress))[0], ZeroHash, 'onUninstall clears state')

console.log('Contract integration tests passed: compile + deployment + 16 protocol assertions')
