import { useState } from 'react'
import { formatOffset, formatSec, mapSourceToProgram, type AnchorPoint } from '../calibration'
import type { ConsoleAction } from '../consoleReducer'
import { CALIBRATION_HINT } from '../scenario'
import {
  activeAnchorPoints,
  calibratedTimeline,
  calibrationActive,
  previewDomain,
  segmentAtProgramTime,
  sortedSegments,
} from '../selectors'
import type { ConsoleState } from '../types'

interface CalibrationPanelProps {
  state: ConsoleState
  dispatch: (action: ConsoleAction) => void
}

/**
 * 时钟漂移校准面板：
 * - 锚点管理（按序号绑定，录入节目时间码，非法输入被拒绝并指出冲突位置）；
 * - 校准对照表（原始时间 / 校准时间 / 当前偏移）；
 * - 漂移曲线（偏移随源时间变化，锚点间分段线性、范围外沿最近段外推）；
 * - 可拖动播放头，预览校准后的字幕切换。
 */
export function CalibrationPanel({ state, dispatch }: CalibrationPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const points = activeAnchorPoints(state)
  const active = calibrationActive(state)
  const dormantCount = state.anchors.length - points.length

  return (
    <section className="calibration-panel" aria-label="时钟漂移校准">
      <header className="cal-header">
        <h2>
          <span aria-hidden="true">🎯</span> 时钟漂移校准
        </h2>
        <span className={`cal-status ${active ? 'cal-status--on' : 'cal-status--off'}`}>
          {active
            ? `✅ 校准已启用（${points.length} 个锚点生效）`
            : `⚠️ 校准未启用：至少两个锚点，还需 ${Math.max(0, 2 - points.length)} 个`}
          {dormantCount > 0 ? ` · ${dormantCount} 个锚点休眠中（等待片段到达）` : ''}
        </span>
        <button type="button" className="cal-toggle" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? '展开 ▾' : '收起 ▴'}
        </button>
      </header>

      {!collapsed && (
        <>
          {state.calibrationError && (
            <div className="cal-error" role="alert">
              <span aria-hidden="true">⛔</span> 非法锚点被拒绝（保留当前校准方案）：
              {state.calibrationError}
            </div>
          )}

          <div className="cal-body">
            <div className="cal-col cal-col--anchors">
              <h3>校准锚点（{state.anchors.length}）</h3>
              {state.anchors.length === 0 ? (
                <p className="muted">尚无锚点。从下方选择已确认片段并录入节目时间码。</p>
              ) : (
                <ul className="anchor-list">
                  {[...state.anchors]
                    .sort((a, b) => a.seq - b.seq)
                    .map((anchor) => (
                      <AnchorRow
                        key={`${anchor.seq}:${anchor.programAt}`}
                        seq={anchor.seq}
                        programAt={anchor.programAt}
                        sourceAt={state.segments[anchor.seq]?.sourceIn ?? null}
                        dispatch={dispatch}
                      />
                    ))}
                </ul>
              )}
              <AddAnchorForm state={state} dispatch={dispatch} />
              {state.anchors.length > 0 && (
                <button
                  type="button"
                  className="cal-clear"
                  onClick={() => dispatch({ type: 'clear-anchors' })}
                >
                  🗑 清除全部锚点
                </button>
              )}
            </div>

            <div className="cal-col cal-col--curve">
              <h3>漂移曲线（偏移 = 校准时间 − 源时间）</h3>
              <DriftChart points={points} />
            </div>

            <div className="cal-col cal-col--table">
              <h3>校准对照表</h3>
              <CalibrationTable state={state} />
            </div>
          </div>

          <PlayheadPreview state={state} dispatch={dispatch} />

          <p className="hint">
            {CALIBRATION_HINT}
            <br />
            💾 校准方案与播放头位置保存在浏览器本地，刷新后自动恢复；重放场景不会清除校准。
          </p>
        </>
      )}
    </section>
  )
}

/* ===== 锚点行：查看源时间、修改节目时间、移除 ===== */

interface AnchorRowProps {
  seq: number
  programAt: number
  /** 片段当前源入点；片段未到达（休眠）时为 null */
  sourceAt: number | null
  dispatch: (action: ConsoleAction) => void
}

function AnchorRow({ seq, programAt, sourceAt, dispatch }: AnchorRowProps) {
  const [draft, setDraft] = useState((programAt / 1000).toFixed(1))
  const parsed = Number(draft)
  const valid = draft.trim() !== '' && Number.isFinite(parsed) && parsed >= 0
  const changed = valid && Math.round(parsed * 1000) !== programAt

  return (
    <li className="anchor-row">
      <span className="seq">#{seq}</span>
      <span className="anchor-src">
        {sourceAt === null ? '💤 片段未到达' : `源 ${formatSec(sourceAt)}`}
      </span>
      <label className="anchor-input">
        节目
        <input
          value={draft}
          inputMode="decimal"
          aria-label={`锚点 #${seq} 的节目时间（秒）`}
          onChange={(e) => setDraft(e.target.value)}
        />
        s
      </label>
      <button
        type="button"
        disabled={!changed}
        title={valid ? '更新该锚点的节目时间' : '请输入不小于 0 的秒数'}
        onClick={() => dispatch({ type: 'upsert-anchor', seq, programAt: Math.round(parsed * 1000) })}
      >
        更新
      </button>
      <button
        type="button"
        aria-label={`移除锚点 #${seq}`}
        onClick={() => dispatch({ type: 'remove-anchor', seq })}
      >
        ✕
      </button>
    </li>
  )
}

/* ===== 新增锚点表单 ===== */

function AddAnchorForm({ state, dispatch }: CalibrationPanelProps) {
  const [seqChoice, setSeqChoice] = useState('')
  const [programInput, setProgramInput] = useState('')
  const anchored = new Set(state.anchors.map((a) => a.seq))
  const candidates = sortedSegments(state).filter((seg) => !anchored.has(seg.seq))
  const parsed = Number(programInput)
  const valid =
    seqChoice !== '' && programInput.trim() !== '' && Number.isFinite(parsed) && parsed >= 0

  const submit = () => {
    if (!valid) return
    dispatch({ type: 'upsert-anchor', seq: Number(seqChoice), programAt: Math.round(parsed * 1000) })
    setSeqChoice('')
    setProgramInput('')
  }

  return (
    <form
      className="anchor-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <select
        value={seqChoice}
        aria-label="选择要锚定的片段"
        onChange={(e) => setSeqChoice(e.target.value)}
      >
        <option value="">选择片段…</option>
        {candidates.map((seg) => (
          <option key={seg.seq} value={seg.seq}>
            #{seg.seq}（源 {formatSec(seg.sourceIn)}）
          </option>
        ))}
      </select>
      <input
        value={programInput}
        inputMode="decimal"
        placeholder="节目时间（秒）"
        aria-label="节目时间（秒）"
        onChange={(e) => setProgramInput(e.target.value)}
      />
      <button type="submit" className="btn-primary" disabled={!valid}>
        ⚓ 添加锚点
      </button>
    </form>
  )
}

/* ===== 校准对照表：原始时间 / 校准时间 / 当前偏移 ===== */

function CalibrationTable({ state }: { state: ConsoleState }) {
  const windows = calibratedTimeline(state)
  const anchored = new Set(state.anchors.map((a) => a.seq))
  if (windows.length === 0) {
    return <p className="muted">暂无片段。播放场景后，这里列出每条的原始与校准时间。</p>
  }
  return (
    <>
      {!windows[0].calibrated && (
        <p className="muted">校准未启用，校准时间暂按源时间展示。</p>
      )}
      <table className="cal-table">
        <thead>
          <tr>
            <th>片段</th>
            <th>源入点</th>
            <th>源出点</th>
            <th>校准入点</th>
            <th>校准出点</th>
            <th>当前偏移</th>
          </tr>
        </thead>
        <tbody>
          {windows.map((win) => (
            <tr key={win.seg.seq} className={anchored.has(win.seg.seq) ? 'is-anchor' : ''}>
              <td>
                <span className="seq">#{win.seg.seq}</span>
                {anchored.has(win.seg.seq) ? ' ⚓' : ''}
              </td>
              <td>{formatSec(win.seg.sourceIn)}</td>
              <td>{formatSec(win.seg.sourceOut)}</td>
              <td>{formatSec(win.programIn)}</td>
              <td>{formatSec(win.programOut)}</td>
              <td className={win.offset === 0 ? '' : 'has-drift'}>{formatOffset(win.offset)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/* ===== 漂移曲线（SVG） ===== */

const CHART = { w: 640, h: 220, ml: 52, mr: 16, mt: 16, mb: 32 }

function DriftChart({ points }: { points: AnchorPoint[] }) {
  const first = points[0]
  const last = points[points.length - 1]
  const span = points.length >= 2 ? last.sourceAt - first.sourceAt : 0
  // 少于两个锚点，或（极端情况下修订导致）源时间跨度为零时无法绘制
  if (points.length < 2 || span <= 0) {
    return (
      <div className="drift-empty">
        <p className="muted">
          添加至少两个锚点后，这里绘制漂移曲线：锚点间分段线性连接，范围外沿最近一段虚线外推。
        </p>
      </div>
    )
  }
  const x0 = first.sourceAt - span * 0.4
  const x1 = last.sourceAt + span * 0.4
  const offsetOf = (sourceAt: number) => mapSourceToProgram(points, sourceAt)! - sourceAt
  const edgeLo = offsetOf(x0)
  const edgeHi = offsetOf(x1)
  const offsets = points.map((p) => p.programAt - p.sourceAt)
  const pad = Math.max((Math.max(0, ...offsets, edgeLo, edgeHi) - Math.min(0, ...offsets, edgeLo, edgeHi)) * 0.15, 100)
  const yMin = Math.min(0, ...offsets, edgeLo, edgeHi) - pad
  const yMax = Math.max(0, ...offsets, edgeLo, edgeHi) + pad

  const plotW = CHART.w - CHART.ml - CHART.mr
  const plotH = CHART.h - CHART.mt - CHART.mb
  const sx = (x: number) => CHART.ml + ((x - x0) / (x1 - x0)) * plotW
  const sy = (y: number) => CHART.mt + (1 - (y - yMin) / (yMax - yMin)) * plotH

  const mainPath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.sourceAt).toFixed(1)},${sy(p.programAt - p.sourceAt).toFixed(1)}`)
    .join(' ')
  const midSource = (first.sourceAt + last.sourceAt) / 2

  return (
    <svg
      className="drift-chart"
      viewBox={`0 0 ${CHART.w} ${CHART.h}`}
      role="img"
      aria-label="漂移曲线：偏移随源时间变化"
    >
      <rect x={CHART.ml} y={CHART.mt} width={plotW} height={plotH} className="drift-frame" />
      {/* 零偏移基准线 */}
      <line x1={sx(x0)} y1={sy(0)} x2={sx(x1)} y2={sy(0)} className="drift-zero" />
      {/* 外推尾段（虚线） */}
      <line
        x1={sx(x0)}
        y1={sy(edgeLo)}
        x2={sx(first.sourceAt)}
        y2={sy(first.programAt - first.sourceAt)}
        className="drift-tail"
      />
      <line
        x1={sx(last.sourceAt)}
        y1={sy(last.programAt - last.sourceAt)}
        x2={sx(x1)}
        y2={sy(edgeHi)}
        className="drift-tail"
      />
      {/* 锚点间分段线性主线 */}
      <path d={mainPath} className="drift-main" />
      {/* 锚点 */}
      {points.map((p) => (
        <g key={p.seq}>
          <circle cx={sx(p.sourceAt)} cy={sy(p.programAt - p.sourceAt)} r={4.5} className="drift-dot" />
          <text x={sx(p.sourceAt) + 7} y={sy(p.programAt - p.sourceAt) - 7} className="drift-label">
            #{p.seq}
          </text>
        </g>
      ))}
      {/* 坐标轴刻度 */}
      <text x={sx(first.sourceAt)} y={CHART.h - 12} className="drift-tick" textAnchor="middle">
        {formatSec(first.sourceAt)}
      </text>
      <text x={sx(midSource)} y={CHART.h - 12} className="drift-tick" textAnchor="middle">
        {formatSec(midSource)}
      </text>
      <text x={sx(last.sourceAt)} y={CHART.h - 12} className="drift-tick" textAnchor="middle">
        {formatSec(last.sourceAt)}
      </text>
      <text x={CHART.ml - 6} y={sy(yMax - pad * 0.4) + 4} className="drift-tick" textAnchor="end">
        {formatOffset(yMax - pad)}
      </text>
      <text x={CHART.ml - 6} y={sy(0) + 4} className="drift-tick" textAnchor="end">
        ±0.00s
      </text>
      <text x={CHART.ml - 6} y={sy(yMin + pad * 0.4) + 4} className="drift-tick" textAnchor="end">
        {formatOffset(yMin + pad)}
      </text>
      <text x={CHART.w - CHART.mr} y={CHART.h - 12} className="drift-axis" textAnchor="end">
        源时间 →
      </text>
      <text x={CHART.ml} y={CHART.mt - 5} className="drift-axis">
        偏移 ↑
      </text>
    </svg>
  )
}

/* ===== 播放头预览：拖动查看校准后的字幕切换 ===== */

function PlayheadPreview({ state, dispatch }: CalibrationPanelProps) {
  const domain = previewDomain(state)
  if (!domain) {
    return (
      <div className="cal-preview">
        <h3>校准预览（播放头）</h3>
        <p className="muted">暂无片段。播放场景后，拖动播放头即可预览校准后的字幕切换。</p>
      </div>
    )
  }
  const windows = calibratedTimeline(state)
  const padMs = Math.max((domain.max - domain.min) * 0.08, 500)
  const lo = Math.max(0, domain.min - padMs)
  const hi = domain.max + padMs
  const playhead = Math.min(Math.max(state.playheadMs, lo), hi)
  const hit = segmentAtProgramTime(state, playhead)
  const pct = (t: number) => ((t - lo) / (hi - lo)) * 100

  return (
    <div className="cal-preview">
      <h3>校准预览（播放头）</h3>
      <div className="playhead-row">
        <span className="playhead-time">节目时间 {formatSec(playhead)}</span>
        <input
          type="range"
          min={lo}
          max={hi}
          step={50}
          value={playhead}
          aria-label="校准预览播放头（节目时间）"
          onChange={(e) => dispatch({ type: 'set-playhead', at: Number(e.target.value) })}
        />
      </div>
      <div className="play-strip" aria-hidden="true">
        {windows.map((win) => (
          <div
            key={win.seg.seq}
            className={`play-block${hit?.seg.seq === win.seg.seq ? ' play-block--hit' : ''}`}
            style={{ left: `${pct(win.programIn)}%`, width: `${pct(win.programOut) - pct(win.programIn)}%` }}
          >
            #{win.seg.seq}
          </div>
        ))}
        <div className="play-marker" style={{ left: `${pct(playhead)}%` }} />
      </div>
      <p className="play-readout">
        {hit ? (
          <>
            ▶ 播出 <span className="seq">#{hit.seg.seq}</span>「{hit.seg.text}」
            <span className="muted">
              {' '}
              · 校准窗口 {formatSec(hit.programIn)}–{formatSec(hit.programOut)} · 偏移{' '}
              {formatOffset(hit.offset)}
            </span>
          </>
        ) : (
          '该时刻无字幕播出'
        )}
        {!windows[0].calibrated && <span className="muted">（校准未启用，按源时间预览）</span>}
      </p>
    </div>
  )
}
