/**
 * 领域模型：字幕事件、字幕片段、冲突、校准锚点、事件日志。
 *
 * 所有时间均为“逻辑时间”（相对场景开始的毫秒数），由事件/动作携带，
 * 状态层本身从不读取时钟，保证可稳定重放。
 */

/** 机器侧推送的事件类型：新字幕 / 修订 */
export type EventKind = 'create' | 'revision'

/** 机器推送的一条字幕事件 */
export interface SubtitleEvent {
  /** 事件唯一 ID，用于去重（网络重发时 ID 不变） */
  id: string
  /** 字幕序号，时间线按它排序 */
  seq: number
  /** 内容版本号，单调递增 */
  version: number
  kind: EventKind
  text: string
  /** 源入点：字幕机时钟上本条字幕的开始时刻（毫秒） */
  sourceIn: number
  /** 源出点：字幕机时钟上本条字幕的结束时刻（毫秒） */
  sourceOut: number
}

/** 场景脚本中的一条：在 at 毫秒时投递 event */
export interface ScheduledEvent {
  at: number
  event: SubtitleEvent
}

export type SegmentOrigin = 'machine' | 'manual'

/** 时间线上的一条字幕片段 */
export interface SubtitleSegment {
  seq: number
  text: string
  version: number
  /** 当前内容的来源：机器推送 or 人工修改 */
  origin: SegmentOrigin
  /** 锁定后机器修订不再静默覆盖，转入人工裁决 */
  locked: boolean
  /** 源入点（字幕机时钟，毫秒），随机器修订更新 */
  sourceIn: number
  /** 源出点（字幕机时钟，毫秒），随机器修订更新 */
  sourceOut: number
}

/** 一条待裁决冲突：锁定片段收到了更新的机器版本 */
export interface Conflict {
  seq: number
  /** 冲突发生瞬间的人工内容快照（用于日志与兜底展示） */
  manualText: string
  manualVersion: number
  incomingText: string
  incomingVersion: number
  /** 机器修订携带的源入点（裁决「接受机器」时一并应用） */
  incomingSourceIn: number
  /** 机器修订携带的源出点 */
  incomingSourceOut: number
  receivedAt: number | null
}

/**
 * 校准锚点：运营确认“片段 #seq 实际播出在节目时间的 programAt 毫秒”。
 *
 * 锚点按字幕序号绑定，不随事件 ID 或版本变化：
 * - 同一片段收到更高版本修订后锚点保留，源时间自动跟随片段当前的源入点；
 * - 重复事件不会产生第二个锚点（同序号只保留一条）。
 */
export interface CalibrationAnchor {
  seq: number
  /** 节目时钟时间码（毫秒），由运营录入 */
  programAt: number
}

export type LogKind =
  | 'received' // 正常接收新片段
  | 'backfilled' // 晚到片段补回缺口
  | 'duplicate' // 重复事件/重复内容，已忽略
  | 'stale' // 过期或矛盾的版本，已忽略
  | 'revised' // 机器修订已直接应用
  | 'conflict' // 锁定片段收到修订，转入人工裁决
  | 'manual' // 人工修改
  | 'lock' // 锁定 / 解锁
  | 'resolved' // 冲突已裁决
  | 'calibration' // 校准锚点更新 / 非法锚点被拒绝

export interface LogEntry {
  id: number
  kind: LogKind
  seq: number | null
  /** 逻辑时间；人工操作为 null（界面显示“手动”） */
  at: number | null
  message: string
}

/**
 * 控制台全部状态。纯数据、可深比较。
 *
 * 其中 anchors / playheadMs 是“会话级”设置：它们描述的是字幕机时钟与
 * 节目时钟的关系以及运营正在查看的预览位置，与事件流内容无关——
 * 因此 reset（重放）会清空事件流状态，但保留这两项（并持久化到浏览器本地）。
 */
export interface ConsoleState {
  segments: Record<number, SubtitleSegment>
  /** 已见过的事件 ID 集合，用于事件级去重 */
  seenEventIds: Record<string, true>
  conflicts: Conflict[]
  log: LogEntry[]
  nextLogId: number
  /** 校准锚点（按序号绑定；源时间由片段当前源入点派生，不冗余存储） */
  anchors: CalibrationAnchor[]
  /** 最近一次非法锚点被拒绝的原因（含冲突位置）；成功操作后清除 */
  calibrationError: string | null
  /** 校准预览播放头位置（节目时间轴，毫秒） */
  playheadMs: number
}
