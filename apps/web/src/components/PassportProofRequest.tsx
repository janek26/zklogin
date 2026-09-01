import type { Address } from 'viem'
import { getAddress } from 'viem'
import { ZKPassportQRCode } from '@zkpassport/ui/react'
import type { ProofResult, QueryBuilder, QueryBuilderResult, SolidityVerifierParameters } from '@zkpassport/sdk'
import type { PassportProofParams } from '../lib/recovery'

export type PassportProofAction = 'SET_GUARDIAN' | 'PROPOSE_RECOVERY'

export type PassportProofResult = {
  params: PassportProofParams
  /** Pseudonymous unique identifier returned by the SDK proof. */
  uniqueIdentifier: string | undefined
}

type OnResultResponse = {
  uniqueIdentifier: string | undefined
  verified: boolean
  proofs: ProofResult[]
  sdkInstance: { getSolidityVerifierParameters: (args: { proof: ProofResult; scope: string }) => SolidityVerifierParameters }
}

/**
 * Sole ZKPassportQRCode wrapper. Takes an app-derived action and wallet
 * context, never raw policy configuration. `custom_data` binds the exact
 * canonical recovery hash so the proof cannot be replayed for another
 * action/owner/nonce/wallet.
 *
 * Note: the app's global `svg` icon rule is scoped to exclude this widget
 * (see style.css) so the QR's `fill="currentColor"` svg keeps its own size
 * and fill instead of being forced to 16px/stroke.
 */
export function PassportProofRequest(props: {
  action: PassportProofAction
  walletAddress: Address
  customData: string
  onResult: (result: PassportProofResult) => void
  onError: (error: string) => void
}) {
  const handleResult = ({ uniqueIdentifier, verified, proofs, sdkInstance }: OnResultResponse) => {
    if (!verified) return
    const outer = proofs.find((p) => p.name?.startsWith('outer_evm'))
    if (!outer) {
      props.onError('NO_OUTER_EVM_PROOF')
      return
    }
    const verifierParams = sdkInstance.getSolidityVerifierParameters({ proof: outer, scope: 'policy-1:1' })
    props.onResult({
      params: {
        version: verifierParams.version as `0x${string}`,
        proofVerificationData: {
          vkeyHash: verifierParams.proofVerificationData.vkeyHash as `0x${string}`,
          proof: verifierParams.proofVerificationData.proof as `0x${string}`,
          publicInputs: verifierParams.proofVerificationData.publicInputs as `0x${string}`[],
        },
        committedInputs: verifierParams.committedInputs as `0x${string}`,
        serviceConfig: verifierParams.serviceConfig,
      },
      uniqueIdentifier,
    })
  }

  return (
    <ZKPassportQRCode
      domain="zklogin-poc.rahrt.com"
      mode="compressed-evm"
      query={(builder: QueryBuilder): QueryBuilderResult =>
        builder
          .policy('policy-1')
          .bind('user_address', getAddress(props.walletAddress))
          .bind('chain', 'ethereum_sepolia')
          .bind('custom_data', props.customData)
          .done()
      }
      onResult={handleResult}
      onError={props.onError}
    />
  )
}
