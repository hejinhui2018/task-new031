import { anchorPoints, mapSourceToProgram, type AnchorPoint } from './calibration'
import type { ConsoleState, SubtitleSegment } from './types'

/** 派生数据选择器：全部由状态计算，不额外存储，保证 reset 后无残留。 */

export function sortedSegments(state: ConsoleState): SubtitleSegment[] {
  return Object.values(state.segments).sort((a, b) => a.seq - b.seq)
}

/** 从最小到最大序号的完整序号序列（含缺口位置） */
export function seqRange(state: ConsoleState): number[] {
  const keys = Object.keys(state.segments).map(Number)
  if (keys.length === 0) return []
  const min = Math.min(...keys)
  const max = Math.max(...keys)
  const out: number[] = []
  for (let seq = min; seq <= max; seq += 1) out.push(seq)
  return out
}

/** 缺口：已收到范围内缺失的序号 */
export function gaps(state: ConsoleState): number[] {
  return seqRange(state).filter((seq) => !state.segments[seq])
}

/**
 * 当前播出序号：从最小序号起连续完整的最长前缀的末尾。
 * 缺口之后的片段即使已到达也不能播出（内容不连贯）。
 */
export function onAirSeq(state: ConsoleState): number | null {
  const keys = Object.keys(state.segments).map(Number)
  if (keys.length === 0) return null
  let cursor = Math.min(...keys)
  while (state.segments[cursor]) cursor += 1
  return cursor - 1
}

export function onAirSegment(state: ConsoleState): SubtitleSegment | null {
  const seq = onAirSeq(state)
  return seq === null ? null : state.segments[seq]
}

/** 已到达但被缺口阻塞、排在播出序号之后的片段 */
export function upcomingSegments(state: ConsoleState): SubtitleSegment[] {
  const onAir = onAirSeq(state)
  if (onAir === null) return []
  return sortedSegments(state).filter((seg) => seg.seq > onAir)
}

/** 第一个阻塞播出的缺口（紧跟在播出序号之后），无缺口时为 null */
export function firstBlockingGap(state: ConsoleState): number | null {
  const list = gaps(state)
  return list.length > 0 ? list[0] : null
}

export function lockedCount(state: ConsoleState): number {
  return Object.values(state.segments).filter((seg) => seg.locked).length
}

export function duplicateCount(state: ConsoleState): number {
  return state.log.filter((entry) => entry.kind === 'duplicate').length
}

/* ===== 漂移校准派生数据 ===== */

/** 当前生效的锚点坐标（已联结片段、按源时间升序；休眠锚点除外） */
export function activeAnchorPoints(state: ConsoleState): AnchorPoint[] {
  return anchorPoints(state.anchors, state.segments)
}

/** 校准是否已启用（至少两个有效锚点） */
export function calibrationActive(state: ConsoleState): boolean {
  return activeAnchorPoints(state).length >= 2
}

/** 一条片段的校准后播出窗口 */
export interface CalibratedWindow {
  seg: SubtitleSegment
  /** 校准入点（节目时钟，毫秒）；未启用校准时等于源入点 */
  programIn: number
  /** 校准出点（节目时钟，毫秒）；未启用校准时等于源出点 */
  programOut: number
  /** 当前偏移 = 校准入点 − 源入点（未启用校准时为 0） */
  offset: number
  /** 是否处于已校准状态（false 时节目时间按源时间原样展示） */
  calibrated: boolean
}

/**
 * 校准后的时间线：每条片段的原始窗口、校准窗口与当前偏移。
 * 全部由 (anchors, segments) 派生——晚到补齐、机器修订、锚点增删都会自动重算。
 */
export function calibratedTimeline(state: ConsoleState): CalibratedWindow[] {
  const points = activeAnchorPoints(state)
  return sortedSegments(state).map((seg) => {
    const programIn = mapSourceToProgram(points, seg.sourceIn)
    const programOut = mapSourceToProgram(points, seg.sourceOut)
    if (programIn === null || programOut === null) {
      return { seg, programIn: seg.sourceIn, programOut: seg.sourceOut, offset: 0, calibrated: false }
    }
    return {
      seg,
      programIn,
      programOut,
      offset: programIn - seg.sourceIn,
      calibrated: true,
    }
  })
}

/**
 * 播放头命中：节目时间 programAt 落在哪条片段的校准窗口内（左闭右开）。
 * 未到达的片段没有窗口；晚到补齐后其窗口自动出现。
 */
export function segmentAtProgramTime(
  state: ConsoleState,
  programAt: number,
): CalibratedWindow | null {
  const windows = calibratedTimeline(state)
  for (const win of windows) {
    if (programAt >= win.programIn && programAt < win.programOut) return win
  }
  return null
}

/** 播放头预览的取值域：[最小校准入点, 最大校准出点]，无片段时为 null */
export function previewDomain(state: ConsoleState): { min: number; max: number } | null {
  const windows = calibratedTimeline(state)
  if (windows.length === 0) return null
  const min = Math.min(...windows.map((w) => w.programIn))
  const max = Math.max(...windows.map((w) => w.programOut))
  return { min, max }
}
