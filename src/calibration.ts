import type { CalibrationAnchor } from './types'

/**
 * 节目时钟漂移校准：把字幕机源时钟映射到导播台节目时钟。
 *
 * 映射规则：
 *  - 锚点之间分段线性插值；
 *  - 范围外沿最近一段（首段 / 末段）的斜率外推；
 *  - 只有 1 个锚点时退化为整体平移（恒定偏移）；
 *  - 0 个锚点时为恒等映射。
 *
 * 合法方案要求源时间与节目时间都严格递增——这样映射函数单调，
 * 校准不会把字幕顺序打乱。全部为纯函数，不读时钟、不含随机性。
 */

/** 锚点校验发现的一处冲突；index 为按源时间排序后的位置（-1 表示与排序无关） */
export interface AnchorIssue {
  index: number
  seq: number
  message: string
}

/** 按源时间升序（源时间相同再按序号，保证冲突定位稳定） */
export function sortAnchors(anchors: CalibrationAnchor[]): CalibrationAnchor[] {
  return [...anchors].sort((a, b) => a.srcAt - b.srcAt || a.seq - b.seq)
}

/** 新增或更新锚点：同一字幕序号只保留一个（替换而非复制），返回按源时间排序的新列表 */
export function upsertAnchor(
  anchors: CalibrationAnchor[],
  anchor: CalibrationAnchor,
): CalibrationAnchor[] {
  return sortAnchors([...anchors.filter((a) => a.seq !== anchor.seq), anchor])
}

/**
 * 校验锚点列表：时间码必须是非负数值，同一序号只能绑定一个锚点，
 * 且源时间与节目时间都必须严格递增。
 * 返回全部冲突（空数组 = 合法），每条冲突都指出涉及的片段序号与位置。
 */
export function validateAnchors(anchors: CalibrationAnchor[]): AnchorIssue[] {
  const issues: AnchorIssue[] = []
  const seenSeqs = new Set<number>()
  anchors.forEach((anchor, index) => {
    if (
      !Number.isFinite(anchor.srcAt) ||
      !Number.isFinite(anchor.programAt) ||
      anchor.srcAt < 0 ||
      anchor.programAt < 0
    ) {
      issues.push({
        index,
        seq: anchor.seq,
        message: `#${anchor.seq} 的时间码非法：必须是非负数值`,
      })
    }
    if (seenSeqs.has(anchor.seq)) {
      issues.push({
        index,
        seq: anchor.seq,
        message: `#${anchor.seq} 绑定了多个锚点，同一字幕序号只能有一个`,
      })
    }
    seenSeqs.add(anchor.seq)
  })
  const sorted = sortAnchors(anchors)
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]
    const curr = sorted[i]
    if (curr.srcAt <= prev.srcAt) {
      issues.push({
        index: i,
        seq: curr.seq,
        message:
          `源时间未严格递增：#${curr.seq}（${formatTimecode(curr.srcAt)}）` +
          `与 #${prev.seq}（${formatTimecode(prev.srcAt)}）冲突`,
      })
    }
    if (curr.programAt <= prev.programAt) {
      issues.push({
        index: i,
        seq: curr.seq,
        message:
          `节目时间未严格递增：#${curr.seq}（${formatTimecode(curr.programAt)}）` +
          `不晚于 #${prev.seq}（${formatTimecode(prev.programAt)}）`,
      })
    }
  }
  return issues
}

/**
 * 源时钟 → 节目时钟：分段线性映射。
 * 前提：anchors 已通过 validateAnchors 校验（本模块对非法输入不做额外防御，
 * 调用方——reducer 与面板——都先校验再使用）。
 */
export function mapSourceToProgram(anchors: CalibrationAnchor[], srcAt: number): number {
  const sorted = sortAnchors(anchors)
  if (sorted.length === 0) return srcAt
  if (sorted.length === 1) {
    const only = sorted[0]
    return srcAt + (only.programAt - only.srcAt)
  }
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (srcAt <= first.srcAt) return lerp(sorted[0], sorted[1], srcAt) // 首段外推
  if (srcAt >= last.srcAt) return lerp(sorted[sorted.length - 2], sorted[sorted.length - 1], srcAt) // 末段外推
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (srcAt >= a.srcAt && srcAt <= b.srcAt) return lerp(a, b, srcAt)
  }
  return srcAt // 不可达：sorted 已覆盖整个数轴
}

/** 节目时钟 → 源时钟：mapSourceToProgram 的逆映射（合法方案下严格单调，可逆） */
export function mapProgramToSource(anchors: CalibrationAnchor[], programAt: number): number {
  const sorted = sortAnchors(anchors)
  if (sorted.length === 0) return programAt
  if (sorted.length === 1) {
    const only = sorted[0]
    return programAt - (only.programAt - only.srcAt)
  }
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (programAt <= first.programAt) return invert(sorted[0], sorted[1], programAt)
  if (programAt >= last.programAt) {
    return invert(sorted[sorted.length - 2], sorted[sorted.length - 1], programAt)
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (programAt >= a.programAt && programAt <= b.programAt) return invert(a, b, programAt)
  }
  return programAt // 不可达
}

/** 当前偏移：节目时间 − 源时间（毫秒）。漂移即“偏移随时间变化” */
export function offsetAt(anchors: CalibrationAnchor[], srcAt: number): number {
  return mapSourceToProgram(anchors, srcAt) - srcAt
}

function lerp(a: CalibrationAnchor, b: CalibrationAnchor, srcAt: number): number {
  const ratio = (srcAt - a.srcAt) / (b.srcAt - a.srcAt)
  return a.programAt + ratio * (b.programAt - a.programAt)
}

function invert(a: CalibrationAnchor, b: CalibrationAnchor, programAt: number): number {
  const ratio = (programAt - a.programAt) / (b.programAt - a.programAt)
  return a.srcAt + ratio * (b.srcAt - a.srcAt)
}

/**
 * 解析运营录入的节目时间码：支持「秒」（75.5）与「分:秒」（01:15.5）两种写法。
 * 非法输入返回 null。
 */
export function parseTimecode(input: string): number | null {
  const text = input.trim()
  if (!text) return null
  const match = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(text)
  if (!match) return null
  const minutes = match[1] ? Number(match[1]) : 0
  const seconds = Number(match[2])
  if (match[1] && seconds >= 60) return null // 分:秒写法下秒位不能超过 59
  const ms = (minutes * 60 + seconds) * 1000
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

/** 格式化为 mm:ss.t（如 01:15.5），负值带前导负号 */
export function formatTimecode(ms: number): string {
  const sign = ms < 0 ? '-' : ''
  const abs = Math.abs(ms)
  const totalSeconds = abs / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - minutes * 60
  return `${sign}${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`
}

/** 偏移量展示：+2.5s / -1.2s / ±0.0s */
export function formatOffset(ms: number): string {
  const sign = ms > 0 ? '+' : ms < 0 ? '-' : '±'
  return `${sign}${(Math.abs(ms) / 1000).toFixed(1)}s`
}
