import type { CalibrationAnchor, SubtitleSegment } from './types'

/**
 * 节目时钟漂移校准：纯函数模块。
 *
 * 锚点把“片段 #seq 的源入点”映射到“节目时钟时间码”。校准映射为：
 * - 锚点之间：分段线性插值；
 * - 锚点范围之外：沿最近一段（首段或末段）的斜率外推。
 *
 * 合法方案要求源时间与节目时间都严格递增；校验函数会指出具体的冲突位置。
 * 本模块不读时钟、不含随机性，与 reducer 一样可稳定重放。
 */

/** 一个锚点解析后的坐标：源时间取自片段当前的源入点（随修订自动更新） */
export interface AnchorPoint {
  seq: number
  /** 源时间（字幕机时钟，毫秒）= 片段当前源入点 */
  sourceAt: number
  /** 节目时间（节目时钟，毫秒），运营录入 */
  programAt: number
}

/** 一处非法锚点冲突：涉及相邻两个锚点，field 指明哪一侧时间未严格递增 */
export interface AnchorConflict {
  seqA: number
  seqB: number
  field: 'source' | 'program'
  message: string
}

/** 毫秒 → “+12.5s” 形式的秒数文案 */
export function formatSec(ms: number): string {
  return `+${(ms / 1000).toFixed(1)}s`
}

/** 毫秒 → 带符号的偏移文案，如 “+0.90s” / “-1.20s” */
export function formatOffset(ms: number): string {
  const sign = ms >= 0 ? '+' : '-'
  return `${sign}${(Math.abs(ms) / 1000).toFixed(2)}s`
}

/**
 * 把锚点与片段联结为坐标点，按源时间升序。
 * 片段尚未到达（如重放后等待补齐）的锚点处于“休眠”状态，不参与映射与校验；
 * 片段到达或修订后，其源入点变化会自动反映到映射中。
 */
export function anchorPoints(
  anchors: CalibrationAnchor[],
  segments: Record<number, SubtitleSegment>,
): AnchorPoint[] {
  return anchors
    .filter((anchor) => segments[anchor.seq])
    .map((anchor) => ({
      seq: anchor.seq,
      sourceAt: segments[anchor.seq].sourceIn,
      programAt: anchor.programAt,
    }))
    .sort((a, b) => a.sourceAt - b.sourceAt)
}

/**
 * 校验锚点序列：源时间与节目时间都必须严格递增。
 * 返回全部冲突（空数组 = 合法），每条冲突都指出相邻两个锚点的序号与数值。
 */
export function validateAnchorPoints(points: AnchorPoint[]): AnchorConflict[] {
  const conflicts: AnchorConflict[] = []
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]
    const cur = points[i]
    if (cur.sourceAt <= prev.sourceAt) {
      conflicts.push({
        seqA: prev.seq,
        seqB: cur.seq,
        field: 'source',
        message:
          `锚点 #${cur.seq} 的源时间 ${formatSec(cur.sourceAt)} 未严格晚于 ` +
          `#${prev.seq} 的 ${formatSec(prev.sourceAt)}`,
      })
    }
    if (cur.programAt <= prev.programAt) {
      conflicts.push({
        seqA: prev.seq,
        seqB: cur.seq,
        field: 'program',
        message:
          `锚点 #${cur.seq} 的节目时间 ${formatSec(cur.programAt)} 未严格晚于 ` +
          `#${prev.seq} 的 ${formatSec(prev.programAt)}`,
      })
    }
  }
  return conflicts
}

/**
 * 源时间 → 节目时间的分段线性映射。
 *
 * - 少于 2 个锚点时返回 null（校准未启用，调用方按源时间原样展示）；
 * - 锚点之间线性插值；
 * - 范围之外沿最近一段的斜率外推（首段向前、末段向后）。
 *
 * 输入点集必须先通过 validateAnchorPoints 校验（源时间严格递增保证斜率有定义）。
 */
export function mapSourceToProgram(points: AnchorPoint[], sourceAt: number): number | null {
  const n = points.length
  if (n < 2) return null

  const first = points[0]
  const last = points[n - 1]

  if (sourceAt <= first.sourceAt) {
    // 首段外推（含第一个锚点本身）
    const second = points[1]
    const slope = (second.programAt - first.programAt) / (second.sourceAt - first.sourceAt)
    return first.programAt + (sourceAt - first.sourceAt) * slope
  }
  if (sourceAt >= last.sourceAt) {
    // 末段外推（含最后一个锚点本身）
    const prev = points[n - 2]
    const slope = (last.programAt - prev.programAt) / (last.sourceAt - prev.sourceAt)
    return last.programAt + (sourceAt - last.sourceAt) * slope
  }
  // 锚点之间：找到所在分段做线性插值
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    if (sourceAt >= a.sourceAt && sourceAt <= b.sourceAt) {
      const t = (sourceAt - a.sourceAt) / (b.sourceAt - a.sourceAt)
      return a.programAt + t * (b.programAt - a.programAt)
    }
  }
  return last.programAt // 不可达：上面的分支已覆盖全域
}

/** 当前偏移：校准后节目时间 − 源时间；未启用校准时为 null */
export function driftOffsetAt(points: AnchorPoint[], sourceAt: number): number | null {
  const mapped = mapSourceToProgram(points, sourceAt)
  return mapped === null ? null : mapped - sourceAt
}
