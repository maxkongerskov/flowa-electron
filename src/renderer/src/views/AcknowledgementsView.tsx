// Port of Flowa/Sections/AcknowledgementsView.swift (data-driven licence sheet).
import { acknowledgements } from '@shared/acknowledgements'

export function AcknowledgementsView({ onClose }: { onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div style={{ display: 'flex', alignItems: 'center', padding: '22px 22px 18px' }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Acknowledgements</span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ fontSize: 13, fontWeight: 500, color: 'var(--accent)' }}>Done</button>
        </div>
        <div className="hairline" />
        <div className="scroll" style={{ flex: 1, padding: 22, display: 'flex', flexDirection: 'column', gap: 16, userSelect: 'text' }}>
          {acknowledgements.map((entry, i) => (
            <div key={entry.name} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {i > 0 && <div className="hairline" />}
              <div style={{ fontSize: 13, fontWeight: 600 }}>{entry.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{entry.notice}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
