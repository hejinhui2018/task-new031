import { useState } from 'react'
import { formatTimecode } from '../calibration'
import type { ConsoleAction } from '../consoleReducer'
import type { ConsoleState, SubtitleSegment } from '../types'
import { calibratedSegments, seqRange, type CalibratedSegment } from '../selectors'

interface TimelinePaneProps {
  state: ConsoleState
  onAirSeq: number | null
  dispatch: (action: ConsoleAction) => void
}

/** 字幕时间线：按序号排列，缺口占位、可编辑、可锁定。 */
export function TimelinePane({ state, onAirSeq, dispatch }: TimelinePaneProps) {
  const rows = seqRange(state)
  // 有校准方案时，每行额外展示校准后的节目时间（晚到补齐会自动重算）
  const calibBySeq = new Map(
    (state.anchors.length > 0 ? calibratedSegments(state) : []).map(
      (c) => [c.seg.seq, c] as const,
    ),
  )
  return (
    <section className="pane timeline-pane" aria-label="字幕时间线">
      <h2>
        <span aria-hidden="true">🧾</span> 字幕时间线
      </h2>
      {rows.length === 0 ? (
        <p className="muted">尚未收到字幕。点击下方「▶ 播放」开始接收事件流。</p>
      ) : (
        <ul className="timeline">
          {rows.map((seq) => {
            const seg = state.segments[seq]
            if (!seg) return <GapRow key={seq} seq={seq} />
            return (
              <SegmentRow
                key={seq}
                seg={seg}
                isOnAir={seq === onAirSeq}
                hasConflict={state.conflicts.some((c) => c.seq === seq)}
                calib={calibBySeq.get(seq) ?? null}
                dispatch={dispatch}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}

function GapRow({ seq }: { seq: number }) {
  return (
    <li className="row gap-row" aria-label={`#${seq} 缺口`}>
      <span className="seq">#{seq}</span>
      <span className="gap-label">
        <span aria-hidden="true">⚠️</span> 缺口 · 片段缺失，等待晚到补齐
      </span>
    </li>
  )
}

interface SegmentRowProps {
  seg: SubtitleSegment
  isOnAir: boolean
  hasConflict: boolean
  calib: CalibratedSegment | null
  dispatch: (action: ConsoleAction) => void
}

function SegmentRow({ seg, isOnAir, hasConflict, calib, dispatch }: SegmentRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(seg.text)

  const save = () => {
    dispatch({ type: 'edit', seq: seg.seq, text: draft })
    setEditing(false)
  }

  const rowClass = [
    'row',
    'seg-row',
    isOnAir ? 'seg-row--onair' : '',
    seg.locked ? 'seg-row--locked' : '',
    hasConflict ? 'seg-row--conflict' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li className={rowClass}>
      <div className="row-head">
        <span className="seq">#{seg.seq}</span>
        <span className="chip">v{seg.version}</span>
        <span className={`chip ${seg.origin === 'manual' ? 'chip--manual' : ''}`}>
          {seg.origin === 'manual' ? '✍️ 人工' : '🤖 机器'}
        </span>
        <span className="chip chip--time" title="字幕机源时钟入点–出点">
          ⏱ 源 {formatTimecode(seg.srcIn)}–{formatTimecode(seg.srcOut)}
        </span>
        {calib && (
          <span className="chip chip--calib" title="校准后的节目时间入点–出点">
            → 节目 {formatTimecode(calib.progIn)}–{formatTimecode(calib.progOut)}
          </span>
        )}
        {isOnAir && <span className="chip chip--live">▶ 播出中</span>}
        {seg.locked && <span className="chip chip--locked">🔒 已锁定</span>}
        {hasConflict && <span className="chip chip--danger">⚠️ 冲突待裁决</span>}
        <span className="row-actions">
          {!editing && (
            <button
              type="button"
              onClick={() => {
                setDraft(seg.text)
                setEditing(true)
              }}
              disabled={seg.locked}
              title={seg.locked ? '已锁定的片段不能直接修改，请先解锁' : '修改这条字幕'}
            >
              ✏️ 修改
            </button>
          )}
          <button type="button" onClick={() => dispatch({ type: 'toggle-lock', seq: seg.seq })}>
            {seg.locked ? '🔓 解锁' : '🔒 锁定'}
          </button>
        </span>
      </div>
      {editing ? (
        <div className="editor">
          <textarea
            value={draft}
            rows={2}
            aria-label={`编辑 #${seg.seq} 字幕文本`}
            onChange={(e) => setDraft(e.target.value)}
          />
          <span className="editor-actions">
            <button type="button" className="btn-primary" onClick={save} disabled={!draft.trim()}>
              保存
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
          </span>
        </div>
      ) : (
        <p className="seg-text">{seg.text}</p>
      )}
    </li>
  )
}
