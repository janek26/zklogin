import type { Address, Hex } from 'viem'
import { publicClient } from '../aa/client'
import { config } from '../config'
import type { PassportProofParams } from './recovery'

type RegistryReader = Pick<typeof publicClient, 'readContract'>

// RegistryID.CERTIFICATE — see zkpassport-registry-contracts lib/Constants.sol
const CERTIFICATE_REGISTRY_ID: Hex = '0x0000000000000000000000000000000000000000000000000000000000000001'

const rootRegistryAbi = [
  {
    type: 'function',
    name: 'isRootValid',
    inputs: [
      { type: 'bytes32', name: 'registryId' },
      { type: 'bytes32', name: 'root' },
      { type: 'uint256', name: 'timestamp' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'latestRoot',
    inputs: [{ type: 'bytes32', name: 'registryId' }],
    outputs: [{ type: 'bytes32' }],
    stateMutability: 'view',
  },
] as const

/**
 * Pre-submit guard mirroring `SubVerifier._validateCertificateRoot`: the
 * proof's embedded certificate registry root must be valid on-chain at the
 * proof's own timestamp. This catches the common failure where the ZKPassport
 * app generated the proof against a stale certificate snapshot — the user gets
 * an actionable message instead of a cryptic simulation revert buried in the
 * paymaster RPC error.
 *
 * Returns a human-readable error string when the root is stale, or null when
 * the proof should pass the registry check (or the registry is unreachable —
 * in that case let the real on-chain simulation be the judge).
 */
export async function checkCertificateRoot(
  params: PassportProofParams,
  reader: RegistryReader = publicClient,
): Promise<string | null> {
  const publicInputs = params.proofVerificationData.publicInputs
  const certificateRoot = publicInputs[0]
  // publicInputs[2] = CURRENT_DATE (u64 proof timestamp), used by SubVerifier.
  const proofTimestamp = publicInputs[2]

  try {
    const registry = config.zkPassportRootRegistry as Address
    const [valid, latest] = await Promise.all([
      reader.readContract({
        address: registry,
        abi: rootRegistryAbi,
        functionName: 'isRootValid',
        args: [CERTIFICATE_REGISTRY_ID, certificateRoot as Hex, BigInt(proofTimestamp)],
      }),
      reader.readContract({
        address: registry,
        abi: rootRegistryAbi,
        functionName: 'latestRoot',
        args: [CERTIFICATE_REGISTRY_ID],
      }),
    ])

    if (valid) return null

    const latestShort = latest ? `${latest.slice(0, 10)}…${latest.slice(-8)}` : 'unknown'
    const proofShort = certificateRoot ? `${certificateRoot.slice(0, 10)}…${certificateRoot.slice(-8)}` : 'unknown'
    return [
      'The passport app generated this proof against a stale certificate registry.',
      `Proof certificate root ${proofShort} is not the registry's latest root ${latestShort}.`,
      'Update the ZKPassport app (or re-verify in it) so it uses the current registry, then scan again.',
    ].join(' ')
  } catch {
    // Registry unreachable — the actual simulation will surface any revert.
    return null
  }
}
