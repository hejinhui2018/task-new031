import type { CalibrationAnchor } from './types'

/**
 * 浏览器本地持久化：校准方案（锚点）与播放头位置。
 * 在无 localStorage 的环境（如 Node 测试）下安全降级为无操作。
 */

const ANCHORS_KEY = 'subtitle-qc:calibration-anchors:v1'
const PLAYHEAD_KEY = 'subtitle-qc:playhead-ms:v1'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // 隐私模式等场景下访问 localStorage 可能抛错
  }
}

function isAnchor(value: unknown): value is CalibrationAnchor {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.seq === 'number' &&
    typeof v.srcAt === 'number' &&
    typeof v.programAt === 'number'
  )
}

/** 读取本地保存的校准锚点；数据损坏或不存在时返回空数组 */
export function loadAnchors(): CalibrationAnchor[] {
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(ANCHORS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isAnchor)
  } catch {
    return []
  }
}

export function saveAnchors(anchors: CalibrationAnchor[]): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(ANCHORS_KEY, JSON.stringify(anchors))
  } catch {
    // 配额不足等写入失败：静默降级，不影响控制台使用
  }
}

/** 读取本地保存的播放头位置（节目时间，毫秒）；不存在返回 null */
export function loadPlayhead(): number | null {
  const store = storage()
  if (!store) return null
  const raw = store.getItem(PLAYHEAD_KEY)
  if (raw === null) return null
  const ms = Number(raw)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

export function savePlayhead(ms: number): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(PLAYHEAD_KEY, String(ms))
  } catch {
    // 同上：写入失败静默降级
  }
}
