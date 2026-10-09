// Port of Flowa/Sections/Banners.swift.
import { OctagonAlert, TriangleAlert, X } from 'lucide-react'

export type BannerSeverity = 'warning' | 'danger'

export function StatusBanner(props: {
  severity: BannerSeverity
  title?: string | null
  detail: string
  actionTitle?: string
  action?: () => void
  onDismiss?: () => void
}) {
  const tint = props.severity === 'warning' ? 'var(--warning)' : 'var(--danger)'
  const Icon = props.severity === 'warning' ? TriangleAlert : OctagonAlert
  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, padding: 10, borderRadius: 8,
        background: `color-mix(in srgb, ${tint} 10%, transparent)`,
        boxShadow: `inset 0 0 0 0.5px color-mix(in srgb, ${tint} 30%, transparent)`
      }}
    >
      <Icon size={13} fill={tint} stroke="var(--page-bg)" strokeWidth={2.2} style={{ marginTop: 1, flex: 'none' }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {props.title && <div style={{ fontSize: 12, fontWeight: 500 }}>{props.title}</div>}
        <div style={{ fontSize: props.title ? 11 : 12, color: props.title ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
          {props.detail}
        </div>
      </div>
      {props.actionTitle && props.action && (
        <button className="btn-bordered" onClick={props.action} style={{ alignSelf: 'center' }}>
          {props.actionTitle}
        </button>
      )}
      {props.onDismiss && (
        <button className="icon-btn" title="Dismiss" onClick={props.onDismiss} style={{ width: 18, height: 18, color: 'var(--text-tertiary)' }}>
          <X size={11} strokeWidth={3} />
        </button>
      )}
    </div>
  )
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return <StatusBanner severity="danger" detail={message} onDismiss={onDismiss} />
}

export function PermissionBanner(p: { title: string; detail: string; actionTitle: string; action: () => void }) {
  return <StatusBanner severity="warning" {...p} />
}

export function ConflictBanner({ behavior, onFix }: { behavior: string; onFix: () => void }) {
  return (
    <StatusBanner
      severity="warning"
      title="Apple's Fn key handler is active"
      detail={`Currently set to "${behavior}". Set "Press \uD83C\uDF10 key to" to Do Nothing in Keyboard settings.`}
      actionTitle="Open"
      action={onFix}
    />
  )
}
