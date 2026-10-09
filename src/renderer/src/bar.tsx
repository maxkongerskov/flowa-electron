// Port of FlowBarContent (Flowa/Hotkey/FloatingPanel.swift): ✕ · 14-bar waveform · ✓.
// This renderer also hosts microphone capture for the whole app.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Check, X } from 'lucide-react'
import { barHeight, pushHistory } from '@shared/audioMath'
import { AudioCapture } from './audio/AudioCapture'
import './bar.css'

const bar = window.flowaBar
const audio = new AudioCapture()
let currentGeneration = 0

bar.onCaptureStart(async (id, req) => {
  currentGeneration = req.generation
  try {
    await audio.start(req.deviceId, req.maxDurationSeconds)
    bar.reply(id, { ok: true })
  } catch (e) {
    bar.reply(id, { ok: false, message: e instanceof Error ? e.message : String(e) })
  }
})

bar.onCaptureStop((id, generation) => {
  const peak = audio.sessionPeakLevel
  const deviceKind = audio.sessionDeviceKind
  const stoppedForMaxDuration = audio.stoppedForMaxDuration
  const samples = generation === currentGeneration ? audio.stop() : new Float32Array(0)
  bar.reply(id, { generation, samples, peak, deviceKind, stoppedForMaxDuration })
})

bar.onCaptureCancel(() => audio.cancel())

const barCount = 14

function FlowBar() {
  const [visible, setVisible] = useState(false)
  const [history, setHistory] = useState<number[]>(() => Array(barCount).fill(0))
  useEffect(() => audio.onLevel((l) => setHistory((h) => pushHistory(h, l))), [])
  useEffect(() => {
    bar.onVisible((_id, v) => {
      setVisible(v)
      if (v) setHistory(Array(barCount).fill(0))
    })
  }, [])
  return (
    <div className={`pill${visible ? ' visible' : ''}`}>
      <button className="circle cancel" onClick={() => bar.cancel()} aria-label="Cancel">
        <X size={10} strokeWidth={3} />
      </button>
      <div className="bars">
        {history.map((lvl, i) => (
          <span key={i} style={{ height: barHeight(lvl) }} />
        ))}
      </div>
      <button className="circle commit" onClick={() => bar.commit()} aria-label="Done">
        <Check size={11} strokeWidth={3.5} />
      </button>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<FlowBar />)
