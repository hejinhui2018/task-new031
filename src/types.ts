/**
 * 领域模型：字幕事件、字幕片段、冲突、事件日志。
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
}

/** 一条待裁决冲突：锁定片段收到了更新的机器版本 */
export interface Conflict {
  seq: number
  /** 冲突发生瞬间的人工内容快照（用于日志与兜底展示） */
  manualText: string
  manualVersion: number
  incomingText: string
  incomingVersion: number
  receivedAt: number | null
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

export interface LogEntry {
  id: number
  kind: LogKind
  seq: number | null
  /** 逻辑时间；人工操作为 null（界面显示“手动”） */
  at: number | null
  message: string
}

/** 控制台全部状态。纯数据、可深比较，reset 后必须与初始状态完全一致。 */
export interface ConsoleState {
  segments: Record<number, SubtitleSegment>
  /** 已见过的事件 ID 集合，用于事件级去重 */
  seenEventIds: Record<string, true>
  conflicts: Conflict[]
  log: LogEntry[]
  nextLogId: number
}
