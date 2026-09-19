import { useState } from 'react'
import type { ConsoleAction } from '../consoleReducer'
import type { CalibrationAnchor, ConsoleState } from '../types'
import {
  formatOffset,
  formatTimecode,
  mapProgramToSource,
  mapSourceToProgram,
  parseTimecode,
  upsertAnchor,
  validateAnchors,
} from '../calibration'
import {
  calibratedSegments,
  segmentAtProgramTime,
  sortedSegments,
  type CalibratedSegment,
} from '../selectors'
import { loadPlayhead, savePlayhead } from '../persistence'

interface CalibrationPanelProps {
  state: ConsoleState
  dispatch: (action: ConsoleAction) => void
}

/**
 * 节目时钟漂移校准面板：
 * 锚点管理（按字幕序号绑定）、原始/校准时间对照、当前偏移、
 * 漂移曲线，以及可拖动播放头的校准后字幕预览。
 */
export function CalibrationPanel({ state, dispatch }: CalibrationPanelProps) {
  const segments = sortedSegments(state)
  const calibrated = calibratedSegments(state)
  const [seqChoice, setSeqChoice] = useState<number | ''>('')
  const [timecode, setTimecode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [playheadMs, setPlayheadMs] = useState<number>(() => loadPlayhead() ?? 0)

  const chosenSegment = seqChoice === '' ? undefined : state.segments[seqChoice]
  const anchoredSeqs = new Set(state.anchors.map((a) => a.seq))

  const submitAnchor = () => {
    if (!chosenSegment) {
      setError('请先选择一条已到达的字幕片段')
      return
    }
    const programAt = parseTimecode(timecode)
    if (programAt === null) {
      setError(`「${timecode}」不是合法时间码，支持「秒」（75.5）或「分:秒」（01:15.5）`)
      return
    }
    const candidate = upsertAnchor(state.anchors, {
      seq: chosenSegment.seq,
      srcAt: chosenSegment.srcIn,
      programAt,
    })
    // 非法锚点不能覆盖当前有效方案：先在本地校验并指出冲突位置，不派发动作
    const issues = validateAnchors(candidate)
    if (issues.length > 0) {
      setError(`锚点未保存，当前方案保持不变：${issues.map((i) => i.message).join('；')}`)
      return
    }
    dispatch({ type: 'set-anchors', anchors: candidate })
    setError(null)
    setTimecode('')
  }

  const movePlayhead = (ms: number) => {
    setPlayheadMs(ms)
    savePlayhead(ms) // 播放头位置保存在浏览器本地
  }

  const progMax = Math.max(
    10000,
    ...calibrated.map((c) => c.progOut),
    ...state.anchors.map((a) => a.programAt),
    Math.ceil(playheadMs),
  )
  const active = segmentAtProgramTime(state, playheadMs)
  const playheadOffset = playheadMs - mapProgramToSource(state.anchors, playheadMs)

  return (
    <section className="pane calibration-panel" aria-label="节目时钟漂移校准">
      <h2>
        <span aria-hidden="true">⏱️</span> 节目时钟漂移校准
      </h2>
      <div className="calibration-grid">
        <div className="calib-col">
          <h3>校准锚点（{state.anchors.length}）</h3>
          {state.anchors.length === 0 ? (
            <p className="muted">
              尚无锚点。从下方选择已到达的片段并录入节目时间码，至少 2 个锚点即可拟合漂移。
            </p>
          ) : (
            <ul className="anchor-list">
              {state.anchors.map((a) => (
                <li key={a.seq}>
                  <span className="seq">#{a.seq}</span>
                  <span>源 {formatTimecode(a.srcAt)}</span>
                  <span aria-hidden="true">→</span>
                  <span>节目 {formatTimecode(a.programAt)}</span>
                  <span className="chip">{formatOffset(a.programAt - a.srcAt)}</span>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'remove-anchor', seq: a.seq })}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="anchor-form">
            <select
              value={chosenSegment ? chosenSegment.seq : ''}
              onChange={(e) =>
                setSeqChoice(e.target.value === '' ? '' : Number(e.target.value))
              }
              aria-label="选择校准片段"
            >
              <option value="">选择已到达片段…</option>
              {segments.map((seg) => (
                <option key={seg.seq} value={seg.seq}>
                  #{seg.seq} · 源入 {formatTimecode(seg.srcIn)}
                  {anchoredSeqs.has(seg.seq) ? '（已锚定，保存将更新）' : ''}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={timecode}
              placeholder="节目时间码，如 01:15.5"
              aria-label="节目时间码"
              onChange={(e) => setTimecode(e.target.value)}
            />
            <button
              type="button"
              className="btn-primary"
              onClick={submitAnchor}
              disabled={segments.length === 0}
            >
              保存锚点
            </button>
          </div>
          {error && (
            <p className="calib-error" role="alert">
              {error}
            </p>
          )}
          <p className="muted calib-note">
            锚点按字幕序号绑定：片段收到更高版本修订后锚点保留，重复事件不会产生副本；
            源时间与节目时间都必须严格递增，非法输入不会覆盖当前有效方案。
          </p>
        </div>

        <div className="calib-col">
          <h3>片段时间对照</h3>
          {calibrated.length === 0 ? (
            <p className="muted">尚未收到字幕。</p>
          ) : (
            <table className="calib-table">
              <thead>
                <tr>
                  <th>片段</th>
                  <th>原始（源时钟）</th>
                  <th>校准（节目时钟）</th>
                  <th>当前偏移</th>
                </tr>
              </thead>
              <tbody>
                {calibrated.map((c) => (
                  <tr key={c.seg.seq}>
                    <td className="seq">#{c.seg.seq}</td>
                    <td>
                      {formatTimecode(c.seg.srcIn)}–{formatTimecode(c.seg.srcOut)}
                    </td>
                    <td>
                      {formatTimecode(c.progIn)}–{formatTimecode(c.progOut)}
                    </td>
                    <td>{formatOffset(c.offsetMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3>漂移曲线</h3>
          <DriftChart anchors={state.anchors} calibrated={calibrated} playheadMs={playheadMs} />
        </div>

        <div className="calib-col">
          <h3>播放头预览</h3>
          <input
            type="range"
            className="playhead-slider"
            min={0}
            max={progMax}
            step={100}
            value={playheadMs}
            onChange={(e) => movePlayhead(Number(e.target.value))}
            aria-label="节目时间播放头"
          />
          <div className="playhead-meta">
            <span>
              节目时间 <strong>{formatTimecode(playheadMs)}</strong>
            </span>
            <span>
              当前偏移 <strong>{formatOffset(playheadOffset)}</strong>
            </span>
          </div>
          <div className="monitor playhead-monitor">
            {active ? (
              <>
                <div className="monitor-top">
                  <span className="onair-tag">
                    <span className="live-dot" aria-hidden="true" /> 校准预览
                  </span>
                  <span className="monitor-seq">
                    #{active.seg.seq} · 校准 {formatTimecode(active.progIn)}–
                    {formatTimecode(active.progOut)}
                  </span>
                </div>
                <p className="monitor-text">{active.seg.text}</p>
              </>
            ) : (
              <p className="monitor-idle">该节目时刻无字幕</p>
            )}
          </div>
          <p className="muted calib-note">
            拖动播放头，按校准后的节目时间预览字幕切换。校准方案与播放头位置保存在浏览器本地。
          </p>
        </div>
      </div>
    </section>
  )
}

interface DriftChartProps {
  anchors: CalibrationAnchor[]
  calibrated: CalibratedSegment[]
  playheadMs: number
}

/**
 * 漂移曲线：横轴为节目时间，纵轴为偏移（节目 − 源）。
 * 偏移是分段线性函数，折线精确经过每个锚点；竖线为当前播放头。
 */
function DriftChart({ anchors, calibrated, playheadMs }: DriftChartProps) {
  if (anchors.length === 0) {
    return <p className="muted">添加锚点后，这里会绘制偏移随节目时间变化的折线。</p>
  }
  const srcs = [
    ...anchors.map((a) => a.srcAt),
    ...calibrated.flatMap((c) => [c.seg.srcIn, c.seg.srcOut]),
  ]
  const lo = Math.min(...srcs)
  const hi = Math.max(...srcs)
  const pad = Math.max((hi - lo) * 0.08, 500)
  // 采样点：定义域两端 + 每个锚点（分段线性 → 折线经过这些点即精确）
  const samples = [lo - pad, ...anchors.map((a) => a.srcAt), hi + pad]
  const points = samples.map((srcAt) => {
    const program = mapSourceToProgram(anchors, srcAt)
    return { program, offset: program - srcAt }
  })

  let x0 = Math.min(...points.map((p) => p.program), playheadMs)
  let x1 = Math.max(...points.map((p) => p.program), playheadMs)
  if (x1 - x0 < 1) x1 = x0 + 1
  let y0 = Math.min(...points.map((p) => p.offset))
  let y1 = Math.max(...points.map((p) => p.offset))
  if (y1 - y0 < 200) {
    const mid = (y0 + y1) / 2
    y0 = mid - 100
    y1 = mid + 100
  }

  const W = 640
  const H = 180
  const PL = 56
  const PR = 14
  const PT = 12
  const PB = 26
  const sx = (program: number) => PL + ((program - x0) / (x1 - x0)) * (W - PL - PR)
  const sy = (offset: number) => H - PB - ((offset - y0) / (y1 - y0)) * (H - PT - PB)
  const polyline = points.map((p) => `${sx(p.program).toFixed(1)},${sy(p.offset).toFixed(1)}`).join(' ')

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="drift-chart"
        role="img"
        aria-label="漂移曲线：偏移随节目时间变化"
      >
        {y0 <= 0 && y1 >= 0 && (
          <line x1={PL} x2={W - PR} y1={sy(0)} y2={sy(0)} className="drift-zero" />
        )}
        <polyline points={polyline} className="drift-line" />
        {anchors.map((a) => (
          <circle
            key={a.seq}
            cx={sx(a.programAt)}
            cy={sy(a.programAt - a.srcAt)}
            r={4.5}
            className="drift-anchor"
          >
            <title>
              #{a.seq} · 节目 {formatTimecode(a.programAt)} · 偏移{' '}
              {formatOffset(a.programAt - a.srcAt)}
            </title>
          </circle>
        ))}
        {playheadMs >= x0 && playheadMs <= x1 && (
          <line
            x1={sx(playheadMs)}
            x2={sx(playheadMs)}
            y1={PT}
            y2={H - PB}
            className="drift-playhead"
          />
        )}
        <text x={PL} y={H - 8} className="drift-tick">
          {formatTimecode(x0)}
        </text>
        <text x={W - PR} y={H - 8} textAnchor="end" className="drift-tick">
          {formatTimecode(x1)}
        </text>
        <text x={6} y={sy(y1) + 4} className="drift-tick">
          {formatOffset(y1)}
        </text>
        <text x={6} y={sy(y0) + 4} className="drift-tick">
          {formatOffset(y0)}
        </text>
      </svg>
      <p className="muted calib-note">
        横轴：节目时间 · 纵轴：偏移（节目 − 源）· 圆点：锚点 · 竖线：播放头
      </p>
    </div>
  )
}
