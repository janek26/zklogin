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
  sdkInstance: {
    getSolidityVerifierParameters: (args: { proof: ProofResult; scope: string; devMode?: boolean }) => SolidityVerifierParameters
  }
}

/**
 * Sole ZKPassportQRCode wrapper. Takes an app-derived action and wallet
 * context, never raw policy configuration. `custom_data` binds the exact
 * canonical recovery hash so the proof cannot be replayed for another
 * action/owner/nonce/wallet.
 *
 * devMode=true selects the Sepolia certificate registry in the ZKPassport
 * SDK (the app embeds `dev=1` in the QR), which is the only registry whose
 * root the Sepolia-deployed verifier accepts. The on-chain validator accepts
 * devMode proofs for real passports but still rejects mock-passport nullifiers,
 * since the Sepolia registry contains ZKR mock certs.
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
    if (!verified) {
      console.warn('[passport] proof reported not verified', { uniqueIdentifier, verified })
      return
    }
    // compressed-evm mode returns a single outer proof — per ZKPassport docs,
    // take proofs[0] directly rather than filtering by name.
    const outer = proofs[0]
    if (!outer) {
      console.warn('[passport] no outer EVM proof in result', { proofCount: proofs.length })
      props.onError('NO_OUTER_EVM_PROOF')
      return
    }
    // devMode: true mirrors the `dev=1` embedded in the QR so
    // serviceConfig.devMode=true reaches the contract, selecting the Sepolia
    // certificate registry in the SDK's verifier-params builder.
    const verifierParams = sdkInstance.getSolidityVerifierParameters({ proof: outer, scope: 'policy-1:1', devMode: true })
    // Console visibility: the embedded certificate/circuit registry roots and
    // proof date are what the on-chain verifier checks first.
    console.log('[passport] proof result', {
      uniqueIdentifier,
      verified,
      proofCount: proofs.length,
      version: verifierParams.version,
      vkeyHash: verifierParams.proofVerificationData.vkeyHash,
      certificateRegistryRoot: verifierParams.proofVerificationData.publicInputs[0],
      circuitRegistryRoot: verifierParams.proofVerificationData.publicInputs[1],
      currentDate: verifierParams.proofVerificationData.publicInputs[2],
      scope: verifierParams.serviceConfig.scope,
      domain: verifierParams.serviceConfig.domain,
      validityPeriodInSeconds: verifierParams.serviceConfig.validityPeriodInSeconds,
      devMode: verifierParams.serviceConfig.devMode,
      proofBytes: verifierParams.proofVerificationData.proof.length,
    })
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
      devMode
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
