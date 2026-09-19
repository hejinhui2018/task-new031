import { anchorPoints, formatSec, validateAnchorPoints } from './calibration'
import type {
  CalibrationAnchor,
  Conflict,
  ConsoleState,
  LogKind,
  SubtitleEvent,
  SubtitleSegment,
} from './types'

/**
 * 控制台状态机：纯函数，不读时钟、不含随机性。
 * 相同的初始状态 + 相同的动作序列 => 完全相同的结果（可稳定重放）。
 */

export type ConsoleAction =
  | { type: 'ingest'; event: SubtitleEvent; receivedAt: number | null }
  | { type: 'edit'; seq: number; text: string }
  | { type: 'toggle-lock'; seq: number }
  | { type: 'resolve-conflict'; seq: number; choice: 'keep' | 'accept' }
  | { type: 'upsert-anchor'; seq: number; programAt: number }
  | { type: 'remove-anchor'; seq: number }
  | { type: 'clear-anchors' }
  | { type: 'set-playhead'; at: number }
  | { type: 'restore-calibration'; anchors: CalibrationAnchor[]; playheadMs: number }
  | { type: 'reset' }

export function createInitialState(): ConsoleState {
  return {
    segments: {},
    seenEventIds: {},
    conflicts: [],
    log: [],
    nextLogId: 1,
    anchors: [],
    calibrationError: null,
    playheadMs: 0,
  }
}

/** 事件流最多保留的条数，防止长时间运行无限增长 */
const MAX_LOG_ENTRIES = 200

function withLog(
  state: ConsoleState,
  kind: LogKind,
  seq: number | null,
  at: number | null,
  message: string,
): ConsoleState {
  const entry = { id: state.nextLogId, kind, seq, at, message }
  return {
    ...state,
    log: [...state.log, entry].slice(-MAX_LOG_ENTRIES),
    nextLogId: state.nextLogId + 1,
  }
}

export function consoleReducer(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case 'reset':
      // 重放清空事件流状态，回到一尘不染的初始状态；
      // 但校准锚点与播放头是会话级设置（描述时钟关系，与事件流无关），重放时保留。
      return {
        ...createInitialState(),
        anchors: state.anchors,
        playheadMs: state.playheadMs,
      }

    case 'ingest':
      return ingest(state, action.event, action.receivedAt)

    case 'edit': {
      const seg = state.segments[action.seq]
      if (!seg || seg.locked) return state // 锁定片段不可直接编辑，需先解锁
      const text = action.text.trim()
      if (!text || text === seg.text) return state
      const next: SubtitleSegment = { ...seg, text, origin: 'manual' }
      const s = { ...state, segments: { ...state.segments, [action.seq]: next } }
      return withLog(s, 'manual', action.seq, null, `人工修改 #${action.seq}：「${text}」`)
    }

    case 'toggle-lock': {
      const seg = state.segments[action.seq]
      if (!seg) return state
      const locked = !seg.locked
      const s = {
        ...state,
        segments: { ...state.segments, [action.seq]: { ...seg, locked } },
      }
      return withLog(
        s,
        'lock',
        action.seq,
        null,
        locked
          ? `已锁定 #${action.seq}，后续机器修订将转入人工裁决`
          : `已解锁 #${action.seq}，机器修订将直接应用`,
      )
    }

    case 'resolve-conflict': {
      const conflict = state.conflicts.find((c) => c.seq === action.seq)
      if (!conflict) return state
      const seg = state.segments[action.seq]
      const conflicts = state.conflicts.filter((c) => c.seq !== action.seq)
      if (action.choice === 'keep') {
        // 保留人工版本：片段原样不动，仅丢弃这条机器修订
        const s = { ...state, conflicts }
        return withLog(
          s,
          'resolved',
          action.seq,
          null,
          `保留人工版本，忽略机器修订 v${conflict.incomingVersion}（#${action.seq}）`,
        )
      }
      // 接受机器版本：应用新内容与源时间并解除锁定，片段交还给机器流
      if (!seg) return { ...state, conflicts }
      const next: SubtitleSegment = {
        ...seg,
        text: conflict.incomingText,
        version: conflict.incomingVersion,
        sourceIn: conflict.incomingSourceIn,
        sourceOut: conflict.incomingSourceOut,
        origin: 'machine',
        locked: false,
      }
      const s = { ...state, conflicts, segments: { ...state.segments, [action.seq]: next } }
      return withLog(
        s,
        'resolved',
        action.seq,
        null,
        `接受机器修订 v${conflict.incomingVersion}（#${action.seq}），片段解除锁定`,
      )
    }

    case 'upsert-anchor': {
      const seg = state.segments[action.seq]
      if (!seg) {
        return rejectCalibration(
          state,
          action.seq,
          `片段 #${action.seq} 尚未到达，无法作为锚点`,
        )
      }
      if (!Number.isFinite(action.programAt) || action.programAt < 0) {
        return rejectCalibration(
          state,
          action.seq,
          `节目时间码无效（必须是不小于 0 的毫秒数）：${String(action.programAt)}`,
        )
      }
      // 同序号只保留一条锚点：重复设置视为更新，绝不产生副本
      const candidate: CalibrationAnchor[] = [
        ...state.anchors.filter((a) => a.seq !== action.seq),
        { seq: action.seq, programAt: action.programAt },
      ]
      // 校验合并后的完整方案（休眠锚点不参与）；非法时保留当前有效方案
      const conflicts = validateAnchorPoints(anchorPoints(candidate, state.segments))
      if (conflicts.length > 0) {
        return rejectCalibration(
          state,
          action.seq,
          conflicts.map((c) => c.message).join('；'),
        )
      }
      const s: ConsoleState = { ...state, anchors: candidate, calibrationError: null }
      return withLog(
        s,
        'calibration',
        action.seq,
        null,
        `校准锚点已更新：#${action.seq} → 节目时间 ${formatSec(action.programAt)}` +
          `（当前共 ${candidate.length} 个锚点）`,
      )
    }

    case 'remove-anchor': {
      if (!state.anchors.some((a) => a.seq === action.seq)) return state
      const anchors = state.anchors.filter((a) => a.seq !== action.seq)
      const s: ConsoleState = { ...state, anchors, calibrationError: null }
      return withLog(
        s,
        'calibration',
        action.seq,
        null,
        `已移除校准锚点 #${action.seq}（剩余 ${anchors.length} 个）`,
      )
    }

    case 'clear-anchors': {
      if (state.anchors.length === 0) return state
      const s: ConsoleState = { ...state, anchors: [], calibrationError: null }
      return withLog(s, 'calibration', null, null, '已清除全部校准锚点，校准映射停用')
    }

    case 'set-playhead': {
      if (!Number.isFinite(action.at)) return state
      const playheadMs = Math.max(0, action.at)
      if (playheadMs === state.playheadMs) return state
      // 播放头拖动是高频预览操作，不写入事件流
      return { ...state, playheadMs }
    }

    case 'restore-calibration': {
      // 启动时从浏览器本地恢复。数据在保存时已通过校验，这里只做形状清洗：
      // 过滤非法条目、按序号去重（同序号后者覆盖前者），休眠锚点原样保留。
      const bySeq = new Map<number, number>()
      for (const anchor of action.anchors) {
        if (
          anchor &&
          Number.isInteger(anchor.seq) &&
          Number.isFinite(anchor.programAt) &&
          anchor.programAt >= 0
        ) {
          bySeq.set(anchor.seq, anchor.programAt)
        }
      }
      const anchors: CalibrationAnchor[] = [...bySeq.entries()].map(([seq, programAt]) => ({
        seq,
        programAt,
      }))
      const playheadMs =
        Number.isFinite(action.playheadMs) && action.playheadMs >= 0 ? action.playheadMs : 0
      // 幂等：StrictMode 双挂载或重复恢复相同数据时不产生额外日志
      const sameAnchors =
        anchors.length === state.anchors.length &&
        anchors.every(
          (a) => state.anchors.some((b) => b.seq === a.seq && b.programAt === a.programAt),
        )
      if (sameAnchors && playheadMs === state.playheadMs) return state
      const s: ConsoleState = { ...state, anchors, playheadMs, calibrationError: null }
      if (anchors.length === 0) return s
      return withLog(
        s,
        'calibration',
        null,
        null,
        `已从浏览器本地恢复校准方案（${anchors.length} 个锚点）`,
      )
    }
  }
}

/** 非法锚点：保留当前有效方案，仅记录拒绝原因（含冲突位置） */
function rejectCalibration(state: ConsoleState, seq: number, reason: string): ConsoleState {
  const s: ConsoleState = { ...state, calibrationError: reason }
  return withLog(s, 'calibration', seq, null, `非法锚点被拒绝（保留当前校准方案）：${reason}`)
}

function ingest(
  state: ConsoleState,
  event: SubtitleEvent,
  receivedAt: number | null,
): ConsoleState {
  // 1) 事件级去重：同一事件 ID 只处理一次
  if (state.seenEventIds[event.id]) {
    return withLog(
      state,
      'duplicate',
      event.seq,
      receivedAt,
      `重复事件 ${event.id}（#${event.seq} v${event.version}）已忽略，未生成新字幕`,
    )
  }
  const seenEventIds = { ...state.seenEventIds, [event.id]: true as const }
  const existing = state.segments[event.seq]

  // 2) 全新片段：直接落位；若序号小于已收到的最大序号，说明是晚到补齐
  if (!existing) {
    const seg: SubtitleSegment = {
      seq: event.seq,
      text: event.text,
      version: event.version,
      origin: 'machine',
      locked: false,
      sourceIn: event.sourceIn,
      sourceOut: event.sourceOut,
    }
    const keys = Object.keys(state.segments)
    const maxSeq = keys.length > 0 ? Math.max(...keys.map(Number)) : null
    const isBackfill = maxSeq !== null && event.seq < maxSeq
    let s: ConsoleState = {
      ...state,
      seenEventIds,
      segments: { ...state.segments, [event.seq]: seg },
    }
    s = withLog(s, 'received', event.seq, receivedAt, `接收 #${event.seq} v${event.version}：「${event.text}」`)
    if (isBackfill) {
      s = withLog(s, 'backfilled', event.seq, receivedAt, `晚到片段 #${event.seq} 已自动补回缺口`)
    }
    return s
  }

  const s0: ConsoleState = { ...state, seenEventIds }

  // 3) 已有片段：按版本号裁决
  if (event.version < existing.version) {
    return withLog(
      s0,
      'stale',
      event.seq,
      receivedAt,
      `过期版本 v${event.version}（当前 v${existing.version}）已忽略（#${event.seq}）`,
    )
  }
  if (event.version === existing.version) {
    if (event.text === existing.text) {
      // 内容级去重：不同事件 ID 但内容完全相同
      return withLog(s0, 'duplicate', event.seq, receivedAt, `重复内容 #${event.seq} v${event.version}，已忽略`)
    }
    return withLog(
      s0,
      'stale',
      event.seq,
      receivedAt,
      `同版本 v${event.version} 内容不一致，保留现有内容（#${event.seq}）`,
    )
  }

  // 4) 更新的机器版本
  if (existing.locked) {
    // 锁定片段：绝不静默覆盖，登记冲突等待人工裁决（同一片段只保留最新一条待裁决）
    const conflict: Conflict = {
      seq: event.seq,
      manualText: existing.text,
      manualVersion: existing.version,
      incomingText: event.text,
      incomingVersion: event.version,
      incomingSourceIn: event.sourceIn,
      incomingSourceOut: event.sourceOut,
      receivedAt,
    }
    const conflicts = [...state.conflicts.filter((c) => c.seq !== event.seq), conflict]
    const s = { ...s0, conflicts }
    return withLog(
      s,
      'conflict',
      event.seq,
      receivedAt,
      `#${event.seq} 已锁定，机器修订 v${event.version} 未覆盖人工内容，转入人工裁决`,
    )
  }

  // 未锁定：直接应用修订（含源时间）；若该片段曾有悬而未决的冲突，旧冲突随之失效
  const hadManualText = existing.origin === 'manual'
  const droppedConflict = state.conflicts.some((c) => c.seq === event.seq)
  const conflicts = state.conflicts.filter((c) => c.seq !== event.seq)
  const next: SubtitleSegment = {
    ...existing,
    text: event.text,
    version: event.version,
    sourceIn: event.sourceIn,
    sourceOut: event.sourceOut,
    origin: 'machine',
  }
  const s = { ...s0, conflicts, segments: { ...state.segments, [event.seq]: next } }
  const notes = [
    hadManualText ? '覆盖了未锁定的人工修改' : '',
    droppedConflict ? '旧的待裁决冲突已失效' : '',
  ]
    .filter(Boolean)
    .join('，')
  return withLog(
    s,
    'revised',
    event.seq,
    receivedAt,
    `机器修订 v${event.version} 已应用（#${event.seq}）${notes ? `，${notes}` : ''}`,
  )
}
