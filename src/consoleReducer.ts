import type {
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
  | { type: 'reset' }

export function createInitialState(): ConsoleState {
  return {
    segments: {},
    seenEventIds: {},
    conflicts: [],
    log: [],
    nextLogId: 1,
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
      // 重放必须回到一尘不染的初始状态，不留任何上一轮的痕迹
      return createInitialState()

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
      // 接受机器版本：应用新内容并解除锁定，片段交还给机器流
      if (!seg) return { ...state, conflicts }
      const next: SubtitleSegment = {
        ...seg,
        text: conflict.incomingText,
        version: conflict.incomingVersion,
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
  }
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

  // 未锁定：直接应用修订；若该片段曾有悬而未决的冲突，旧冲突随之失效
  const hadManualText = existing.origin === 'manual'
  const droppedConflict = state.conflicts.some((c) => c.seq === event.seq)
  const conflicts = state.conflicts.filter((c) => c.seq !== event.seq)
  const next: SubtitleSegment = {
    ...existing,
    text: event.text,
    version: event.version,
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
