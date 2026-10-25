// Non-modal license card. It never covers history, settings, or export.
import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import type { LicenseDialogModel, LicenseSnapshot } from '../../../license/types'

const f = window.flowa

export function RemainingBadge({ label }: { label: string }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', padding: '4px 9px', borderRadius: 999,
        background: 'var(--card-bg)', boxShadow: 'inset 0 0 0 0.5px var(--divider)',
        fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)'
      }}
    >
      {label}
    </div>
  )
}

export function LicenseDialogCard({ dialog }: { dialog: LicenseDialogModel }) {
  const [key, setKey] = useState('')
  const needsKey = dialog.kind === 'key-entry' || dialog.kind === 'reactivate'
  return (
    <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, lineHeight: 1.45 }}>{dialog.body}</div>
      {dialog.error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{dialog.error}</div>}
      {needsKey && (
        <input
          className="plain-input muted-field"
          aria-label={dialog.primaryLabel ?? 'License key'}
          value={key}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && key.trim()) void f.action('licenseActivate', key)
          }}
          style={{ fontSize: 13, padding: '6px 8px' }}
        />
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {dialog.primaryLabel && dialog.kind === 'daily-cap' && (
          <button className="btn-bordered" onClick={() => void f.action('licenseOpenPurchase')}>
            {dialog.primaryLabel}
          </button>
        )}
        {dialog.primaryLabel && needsKey && (
          <button className="btn-bordered" disabled={!key.trim()} onClick={() => void f.action('licenseActivate', key)}>
            {dialog.primaryLabel}
          </button>
        )}
        {dialog.secondaryLabel && (
          <button className="btn-bordered" onClick={() => void f.action('licenseOpenKeyEntry')}>
            {dialog.secondaryLabel}
          </button>
        )}
        {dialog.linkUrl && (
          <button className="btn-bordered" onClick={() => void f.action('licenseOpenPortal')}>
            {dialog.linkUrl}
          </button>
        )}
        <button className="btn-bordered" onClick={() => void f.action('licenseDismiss')}>
          OK
        </button>
      </div>
    </div>
  )
}

export function LicenseSettingsRow({ license }: { license: LicenseSnapshot }) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <KeyRound size={14} strokeWidth={2} color="var(--text-tertiary)" style={{ width: 16, flex: 'none' }} />
        <span style={{ fontSize: 13 }}>License</span>
        <div style={{ flex: 1, minWidth: 8 }} />
        {license.keyHint && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{license.keyHint}</span>}
        <button className="btn-bordered" onClick={() => setOpen((v) => !v)}>
          {license.canDeactivate ? 'Change' : 'Enter key'}
        </button>
      </div>
      {license.quietNote && <div style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--text-tertiary)', paddingLeft: 28 }}>{license.quietNote}</div>}
      {open && (
        <div style={{ display: 'flex', gap: 8, paddingLeft: 28 }}>
          <input
            className="plain-input muted-field"
            aria-label="License key"
            value={key}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setKey(e.target.value)}
            style={{ flex: 1, fontSize: 13, padding: '6px 8px' }}
          />
          <button
            className="btn-bordered"
            disabled={!key.trim()}
            onClick={() => {
              void f.action('licenseActivate', key)
              setKey('')
            }}
          >
            Activate
          </button>
          {license.canDeactivate && (
            <button className="btn-bordered" onClick={() => void f.action('licenseDeactivate')}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  )
}
