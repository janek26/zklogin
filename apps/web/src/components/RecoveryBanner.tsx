import type { Address } from 'viem'
import { formatEther } from 'viem'
import type { RecoveryProposal } from '../lib/recovery'
import { shortAddress, formatExpiry } from '../lib/utils'

/**
 * Persistent recovery-state banners rendered above the wallet surfaces.
 * Disabled/absent → setup prompt; pending proposal → cancel affordance;
 * finalized local owner → unsafe warning.
 */
export function RecoveryBanner(props: {
  kind: 'absent' | 'pending' | 'unsafe'
  proposal?: RecoveryProposal
  proposedOwner?: Address
  executableAt?: number
  delaySeconds?: number
  balance?: bigint
  onSetup?: () => void
  onCancel?: () => void
  onForget?: () => void
  disabled?: boolean
}) {
  if (props.kind === 'absent') {
    return (
      <section className="recovery-banner recovery-absent">
        <div>
          <h3>Make this wallet recoverable</h3>
          <p>
            Add your passport as a recovery guardian. If Google access stops working, your
            passport can propose a local replacement owner. You choose how long recovery waits.
          </p>
        </div>
        <button className="compact-button primary recovery-banner-action" onClick={props.onSetup} disabled={props.disabled}>
          Add passport recovery
        </button>
      </section>
    )
  }

  if (props.kind === 'pending') {
    const executable = props.executableAt ? formatExpiry(props.executableAt) : 'soon'
    return (
      <section className="recovery-banner recovery-pending" role="status">
        <div>
          <h3>Recovery is in progress</h3>
          <p>
            A passport recovery can replace this wallet owner after{' '}
            <strong>{executable}</strong>. Your wallet still works. If this was not you, cancel
            recovery now.
          </p>
          {props.proposedOwner && (
            <p className="recovery-details">
              Proposed owner <code>{shortAddress(props.proposedOwner)}</code>
              {props.delaySeconds !== undefined && (
                <> · recovery waits {formatDelay(props.delaySeconds)}</>
              )}
            </p>
          )}
        </div>
        <button className="compact-button danger recovery-banner-action" onClick={props.onCancel} disabled={props.disabled}>
          Cancel recovery
        </button>
      </section>
    )
  }

  // unsafe recovered owner
  return (
    <section className="recovery-banner recovery-unsafe" role="alert">
      <div>
        <h3>Unsafe recovery owner</h3>
        <p>
          This wallet is controlled by a temporary key kept only in this browser. Use Send to
          move funds to a safer wallet as soon as possible. Clearing this browser before you
          move funds can permanently lose access.
        </p>
        {props.balance !== undefined && (
          <p className="recovery-details">
            Balance {formatEther(props.balance)} ETH
          </p>
        )}
      </div>
      <button className="compact-button danger recovery-banner-action" onClick={props.onForget} disabled={props.disabled}>
        Forget recovery key
      </button>
    </section>
  )
}

function formatDelay(seconds: number): string {
  if (seconds === 0) return 'Immediate'
  const days = seconds / 86400
  return Number.isInteger(days) ? `${days} day${days === 1 ? '' : 's'}` : `${seconds}s`
}
