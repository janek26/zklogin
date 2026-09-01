import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Address } from 'viem'
import { formatEther, parseEther } from 'viem'
import { RecoveryBanner } from './components/RecoveryBanner'
import { RecoveryLogin } from './components/RecoveryLogin'
import { RefreshIcon } from './components/Icons'
import { createRecoveryWalletClients, publicClient, waitForSuccess } from './aa/client'
import { toRecoveryKernelValidator } from './aa/recoveryValidator'
import { entryPoint, kernelVersion } from './aa/client'
import { config } from './config'
import { privateKeyToAccount } from 'viem/accounts'
import { loadLocalRecoveryKey, readRecoveryState } from './lib/recovery'
import { makeFinalizeCallData } from './lib/recovery'
import './style.css'

/**
 * Independent static recovery entrypoint (recovery.html). Contains only the
 * no-Google recovery flow plus a native-send surface once a local owner is
 * finalized. Domain-origin hardening is deliberately deferred for this POC.
 *
 * Limitation: if a different compatible recovery app/browser starts recovery,
 * it has its own local storage and owner key; it intentionally replaces the
 * existing proposal and restarts the selected delay. This artifact can only
 * complete a proposal whose local key exists in THIS browser's storage.
 */
function RecoveryEntry() {
  const [kernelAddress, setKernelAddress] = useState<Address | null>(null)
  const [balance, setBalance] = useState<bigint>(0n)
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useState<`0x${string}` | null>(null)

  const handleRecovered = async (kernel: Address) => {
    setKernelAddress(kernel)
    setBalance(await publicClient.getBalance({ address: kernel }))
  }

  const refresh = async () => {
    if (!kernelAddress) return
    setBalance(await publicClient.getBalance({ address: kernelAddress }))
  }

  const send = async (to: string, amount: string) => {
    if (!kernelAddress) return
    try {
      const state = await readRecoveryState(kernelAddress)
      if (!state.permanentOwner) throw new Error('NO_PERMANENT_OWNER')
      const key = loadLocalRecoveryKey({
        chainId: config.chainId,
        kernelAddress,
        recoveryNonce: state.recoveryNonce,
      })
      if (!key) throw new Error('LOCAL_KEY_MISSING')
      const signer = privateKeyToAccount(key.privateKey)
      const validator = await toRecoveryKernelValidator({
        entryPoint,
        kernelVersion,
        chainId: config.chainId,
        validatorAddress: config.validatorAddress,
        signer,
        kind: 'owner',
        accountId: state.accountId,
      })
      const clients = await createRecoveryWalletClients(validator as never, kernelAddress)
      const tx = await clients.kernelClient.sendUserOperation({
                calls: [{ to: to as Address, value: parseEther(amount), data: '0x' }],
      })
      setHash(tx)
      await waitForSuccess(clients.kernelClient, tx)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'SEND_FAILED')
    }
  }

  return (
    <main className="app-shell">
      <nav className="topbar" aria-label="Recovery navigation">
        <span className="topbar-title">zkLogin wallet · recovery</span>
        <span className="network-badge"><i /> {config.chain.name}</span>
      </nav>
      <section className="wallet-frame is-ready">
        {!kernelAddress ? (
          <RecoveryLogin onRecovered={(kernel) => { void handleRecovered(kernel) }} />
        ) : (
          <RecoveryPanel
            kernelAddress={kernelAddress}
            balance={balance}
            error={error}
            hash={hash}
            onRefresh={() => { void refresh() }}
            onSend={send}
          />
        )}
      </section>
      <footer>Unaudited research POC</footer>
    </main>
  )
}

function RecoveryPanel(props: {
  kernelAddress: Address
  balance: bigint
  error: string | null
  hash: `0x${string}` | null
  onRefresh: () => void
  onSend: (to: string, amount: string) => void
}) {
  return (
    <>
      <RecoveryBanner kind="unsafe" balance={props.balance} />
      <div className="wallet-grid">
        <section className="balance-card card">
          <div className="card-header">
            <div>
              <p className="eyebrow">Available balance</p>
              <span>{props.kernelAddress.slice(0, 6)}…{props.kernelAddress.slice(-4)}</span>
            </div>
            <button className="icon-button" onClick={props.onRefresh} title="Refresh balance">
              <RefreshIcon />
            </button>
          </div>
          <div className="balance-value">{formatEther(props.balance)}<span> ETH</span></div>
        </section>
        <SendForm onSend={props.onSend} error={props.error} hash={props.hash} />
      </div>
    </>
  )
}

function SendForm(props: { onSend: (to: string, amount: string) => void; error: string | null; hash: `0x${string}` | null }) {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  return (
    <section className="send-card card">
      <div className="card-header">
        <div>
          <p className="eyebrow">Send</p>
          <h2>Native ETH</h2>
        </div>
        <span className="asset-token">ETH</span>
      </div>
      <div className="field">
        <label htmlFor="recovery-recipient">Recipient</label>
        <input id="recovery-recipient" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x1234…" autoComplete="off" spellCheck="false" />
      </div>
      <div className="field amount-field">
        <label htmlFor="recovery-amount">Amount</label>
        <div className="amount-input">
          <input id="recovery-amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" />
          <span>ETH</span>
        </div>
      </div>
      <button className="primary-button" disabled={!to.trim() || !amount.trim()} onClick={() => props.onSend(to.trim(), amount.trim())}>
        Send
      </button>
      {props.error && <div className="alert compact" role="alert"><strong>Send needs attention</strong><span>{props.error}</span></div>}
      {props.hash && <div className="receipt" role="status"><span className="receipt-dot" />UserOperation confirmed <code>{props.hash.slice(0, 10)}…</code></div>}
    </section>
  )
}

createRoot(document.getElementById('root')!).render(<RecoveryEntry />)
