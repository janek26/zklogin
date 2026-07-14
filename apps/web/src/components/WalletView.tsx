import type { Hex } from 'viem'
import { formatEther } from 'viem'
import type { Wallet } from '../lib/types'
import { shortAddress, formatExpiry } from '../lib/utils'
import { config } from '../config'
import { ArrowIcon, CopyIcon, RefreshIcon } from './Icons'

export function WalletView({
  wallet,
  balance,
  recipient,
  amount,
  error,
  userOpHash,
  sessionExpiry,
  countdown,
  sending,
  spinning,
  canSend,
  onRecipientChange,
  onAmountChange,
  onCopyAddress,
  onRefresh,
  onSend,
}: {
  wallet: Wallet
  balance: bigint
  recipient: string
  amount: string
  error: string | null
  userOpHash: Hex | null
  sessionExpiry: number
  countdown: string
  sending: boolean
  spinning: boolean
  canSend: boolean
  onRecipientChange: (value: string) => void
  onAmountChange: (value: string) => void
  onCopyAddress: () => void
  onRefresh: () => void
  onSend: () => void
}) {
  return (
    <div className="wallet-grid">
      <section className="balance-card card">
        <div className="card-header">
          <div>
            <p className="eyebrow">Available balance</p>
            <button className="address-button" onClick={onCopyAddress} title="Copy wallet address">
              <span>{shortAddress(wallet.account.address)}</span>
              <CopyIcon />
            </button>
          </div>
          <button
            className={`icon-button${spinning ? ' spin-once' : ''}`}
            onClick={onRefresh}
            title="Refresh balance"
          >
            <RefreshIcon />
          </button>
        </div>
        <div className="balance-value">{formatEther(balance)}<span> ETH</span></div>
        <div className="balance-meta">
          <span><i /> Ready to send</span>
          <span>Session ends {formatExpiry(sessionExpiry)}</span>
        </div>
      </section>

      <section className="send-card card">
        <div className="card-header">
          <div>
            <p className="eyebrow">Send</p>
            <h2>Native ETH</h2>
          </div>
          <span className="asset-token">ETH</span>
        </div>
        <div className="field">
          <label htmlFor="recipient">Recipient</label>
          <input id="recipient" value={recipient} onChange={(event) => onRecipientChange(event.target.value)} placeholder="0x1234…" autoComplete="off" spellCheck="false" />
        </div>
        <div className="field amount-field">
          <label htmlFor="amount">Amount</label>
          <div className="amount-input">
            <input id="amount" value={amount} onChange={(event) => onAmountChange(event.target.value)} placeholder="0.00" inputMode="decimal" />
            <span>ETH</span>
          </div>
        </div>
        <button className="primary-button" disabled={!canSend} onClick={onSend}>
          {sending ? <><span className="button-spinner" /> Sending&hellip;</> : <>Send <ArrowIcon /></>}
        </button>
        {error && (
          <div className="alert compact" role="alert">
            <strong>Transfer needs attention</strong>
            <span>{error}</span>
          </div>
        )}
      </section>

      <aside className="session-info">
        <div className="session-info-top">
          <svg viewBox="0 0 24 24" aria-hidden="true" width="13" height="13">
            <path d="M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3z" fill="currentColor" />
          </svg>
          Session key active
        </div>
        <div className="session-info-body">
          <svg className="session-ring" viewBox="0 0 40 40" aria-hidden="true">
            <circle className="session-ring-track" cx="20" cy="20" r="16" fill="none" />
            <circle className="session-ring-fill" cx="20" cy="20" r="16" fill="none" strokeDasharray={100} strokeDashoffset={100 * (1 - Math.max(1, Math.min(99, Math.round(((sessionExpiry - Math.floor(Date.now() / 1000)) / 86400) * 100))) / 100)} strokeLinecap="round" />
          </svg>
          <div className="session-countdown">{countdown || '—'}</div>
        </div>
        <p>Only this browser tab holds your temporary key. Closing it requires a new Google sign-in.</p>
      </aside>
    </div>
  )
}
