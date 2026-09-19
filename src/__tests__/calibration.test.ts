import { describe, expect, it } from 'vitest'
import {
  anchorPoints,
  driftOffsetAt,
  mapSourceToProgram,
  validateAnchorPoints,
  type AnchorPoint,
} from '../calibration'
import { consoleReducer, createInitialState } from '../consoleReducer'
import {
  calibratedTimeline,
  calibrationActive,
  previewDomain,
  segmentAtProgramTime,
} from '../selectors'
import type { ConsoleState, SubtitleEvent } from '../types'

/** 构造一条带源时间的机器事件 */
function segEvent(
  seq: number,
  sourceIn: number,
  sourceOut: number,
  version = 1,
  text = `片段${seq}`,
): SubtitleEvent {
  return {
    id: `e${seq}v${version}`,
    seq,
    version,
    kind: version > 1 ? 'revision' : 'create',
    text,
    sourceIn,
    sourceOut,
  }
}

function ingest(state: ConsoleState, event: SubtitleEvent, receivedAt: number | null = null) {
  return consoleReducer(state, { type: 'ingest', event, receivedAt })
}

function anchor(state: ConsoleState, seq: number, programAt: number) {
  return consoleReducer(state, { type: 'upsert-anchor', seq, programAt })
}

/** 三条连续片段：#101 源 0–4s，#102 源 4–8s，#103 源 8–12s */
function baseState(): ConsoleState {
  let s = createInitialState()
  s = ingest(s, segEvent(101, 0, 4000), 0)
  s = ingest(s, segEvent(102, 4000, 8000), 100)
  s = ingest(s, segEvent(103, 8000, 12000), 200)
  return s
}

const P = (seq: number, sourceAt: number, programAt: number): AnchorPoint => ({
  seq,
  sourceAt,
  programAt,
})

describe('分段线性映射与外推', () => {
  it('两个锚点之间线性插值', () => {
    const points = [P(101, 0, 1000), P(103, 10000, 13000)] // 斜率 1.2
    expect(mapSourceToProgram(points, 0)).toBe(1000)
    expect(mapSourceToProgram(points, 10000)).toBe(13000)
    expect(mapSourceToProgram(points, 5000)).toBe(7000) // 1000 + 5000×1.2
  })

  it('范围外沿最近一段外推：首段向前、末段向后', () => {
    const points = [P(101, 0, 1000), P(103, 10000, 13000)] // 斜率 1.2
    expect(mapSourceToProgram(points, -2000)).toBe(-1400) // 1000 + (−2000)×1.2
    expect(mapSourceToProgram(points, 15000)).toBe(19000) // 13000 + 5000×1.2
  })

  it('多个锚点分段斜率各自独立，且在锚点处连续', () => {
    const points = [P(101, 0, 0), P(102, 4000, 5000), P(103, 8000, 9000)]
    // 第一段斜率 1.25，第二段斜率 1.0
    expect(mapSourceToProgram(points, 2000)).toBe(2500)
    expect(mapSourceToProgram(points, 6000)).toBe(7000)
    // 锚点处两段结果一致（连续）
    expect(mapSourceToProgram(points, 4000)).toBe(5000)
    expect(mapSourceToProgram(points, 8000)).toBe(9000)
    // 外推沿首段 / 末段斜率
    expect(mapSourceToProgram(points, -1000)).toBe(-1250)
    expect(mapSourceToProgram(points, 10000)).toBe(11000)
  })

  it('少于两个锚点时校准未启用（返回 null）', () => {
    expect(mapSourceToProgram([], 1000)).toBeNull()
    expect(mapSourceToProgram([P(101, 0, 1000)], 1000)).toBeNull()
  })

  it('driftOffsetAt 返回“校准时间 − 源时间”的当前偏移', () => {
    const points = [P(101, 0, 1000), P(103, 10000, 13000)]
    expect(driftOffsetAt(points, 0)).toBe(1000)
    expect(driftOffsetAt(points, 10000)).toBe(3000) // 漂移随源时间增大
    expect(driftOffsetAt([], 0)).toBeNull()
  })

  it('anchorPoints 联结片段源入点、按源时间排序并跳过休眠锚点', () => {
    const state = baseState()
    const points = anchorPoints(
      [
        { seq: 103, programAt: 13000 },
        { seq: 101, programAt: 0 },
        { seq: 199, programAt: 99999 }, // 片段未到达 → 休眠
      ],
      state.segments,
    )
    expect(points).toEqual([P(101, 0, 0), P(103, 8000, 13000)])
  })
})

describe('非法锚点校验', () => {
  it('源时间或节目时间未严格递增时，校验指出冲突位置', () => {
    // #102 节目时间倒退（5000 → 4000），#103 源时间与 #102 重复（均为 4000）
    const conflicts = validateAnchorPoints([P(101, 0, 5000), P(102, 4000, 4000), P(103, 4000, 9000)])
    expect(conflicts).toHaveLength(2)
    const program = conflicts.find((c) => c.field === 'program')
    const source = conflicts.find((c) => c.field === 'source')
    expect(program?.seqA).toBe(101)
    expect(program?.seqB).toBe(102)
    expect(program?.message).toContain('#102')
    expect(program?.message).toContain('#101')
    expect(source?.seqA).toBe(102)
    expect(source?.seqB).toBe(103)
  })

  it('节目时间未严格递增：非法锚点被拒绝，当前有效方案不被覆盖', () => {
    let s = baseState()
    s = anchor(s, 101, 0)
    s = anchor(s, 102, 5000)
    const before = s.anchors

    s = anchor(s, 103, 5000) // 与 #102 相等，非严格递增

    // 当前有效方案原样保留
    expect(s.anchors).toEqual(before)
    expect(s.anchors).toHaveLength(2)
    // 说明冲突位置：涉及 #103 与 #102
    expect(s.calibrationError).toContain('#103')
    expect(s.calibrationError).toContain('#102')
    expect(s.calibrationError).toContain('节目时间')
    // 事件流留下拒绝记录
    const log = s.log.filter((e) => e.kind === 'calibration')
    expect(log.some((e) => e.message.includes('非法锚点被拒绝'))).toBe(true)
    // 校准映射仍按旧方案工作
    expect(mapSourceToProgram(anchorPoints(s.anchors, s.segments), 4000)).toBe(5000)
  })

  it('节目时间倒退同样被拒绝', () => {
    let s = baseState()
    s = anchor(s, 101, 0)
    s = anchor(s, 102, 5000)
    s = anchor(s, 103, 3000) // 早于 #102 的节目时间
    expect(s.anchors).toHaveLength(2)
    expect(s.calibrationError).toContain('#103')
  })

  it('源时间重复（两条片段源入点相同）被拒绝', () => {
    let s = baseState()
    s = ingest(s, segEvent(104, 8000, 12000, 1), 300) // 与 #103 源入点相同
    s = anchor(s, 103, 9000)
    s = anchor(s, 104, 10000)
    expect(s.anchors).toHaveLength(1)
    expect(s.calibrationError).toContain('源时间')
    expect(s.calibrationError).toContain('#104')
    expect(s.calibrationError).toContain('#103')
  })

  it('锚定尚未到达的片段被拒绝', () => {
    let s = baseState()
    s = anchor(s, 199, 1000)
    expect(s.anchors).toHaveLength(0)
    expect(s.calibrationError).toContain('#199')
    expect(s.calibrationError).toContain('尚未到达')
  })

  it('非法节目时间码（负数 / 非数值）被拒绝', () => {
    let s = baseState()
    s = anchor(s, 101, -500)
    expect(s.anchors).toHaveLength(0)
    expect(s.calibrationError).toContain('无效')
    s = anchor(s, 101, Number.NaN)
    expect(s.anchors).toHaveLength(0)
    expect(s.calibrationError).toContain('无效')
  })

  it('拒绝后录入合法锚点：方案生效且错误清除', () => {
    let s = baseState()
    s = anchor(s, 101, 0)
    s = anchor(s, 102, 5000)
    s = anchor(s, 103, 5000) // 非法，被拒绝
    expect(s.calibrationError).not.toBeNull()

    s = anchor(s, 103, 9000) // 修正
    expect(s.calibrationError).toBeNull()
    expect(s.anchors).toHaveLength(3)
    expect(calibrationActive(s)).toBe(true)
  })

  it('同一序号重复设置只更新锚点，不产生副本', () => {
    let s = baseState()
    s = anchor(s, 101, 0)
    s = anchor(s, 101, 500)
    expect(s.anchors).toHaveLength(1)
    expect(s.anchors[0]).toEqual({ seq: 101, programAt: 500 })
  })

  it('移除与清空锚点', () => {
    let s = baseState()
    s = anchor(s, 101, 0)
    s = anchor(s, 103, 13000)
    expect(calibrationActive(s)).toBe(true)

    s = consoleReducer(s, { type: 'remove-anchor', seq: 101 })
    expect(s.anchors).toEqual([{ seq: 103, programAt: 13000 }])
    expect(calibrationActive(s)).toBe(false) // 单锚点不足以启用

    s = anchor(s, 101, 0)
    s = consoleReducer(s, { type: 'clear-anchors' })
    expect(s.anchors).toEqual([])
    expect(calibrationActive(s)).toBe(false)
  })
})

describe('修订身份保持', () => {
  it('未锁定片段应用更高版本修订后，锚点保留并跟随新的源入点', () => {
    let s = baseState()
    s = anchor(s, 101, 0)
    s = anchor(s, 102, 5000)

    // 机器修订 v2：文本与源时间都有调整（源入点 4000 → 4500）
    s = ingest(s, segEvent(102, 4500, 8500, 2, '片段102修订'), 10000)

    // 锚点按序号绑定，修订后仍然保留、不产生副本
    expect(s.anchors).toHaveLength(2)
    expect(s.anchors.filter((a) => a.seq === 102)).toHaveLength(1)
    // 锚点的源时间自动跟随片段当前源入点，映射随之重算
    const points = anchorPoints(s.anchors, s.segments)
    expect(points).toContainEqual(P(102, 4500, 5000))
    expect(mapSourceToProgram(points, 4500)).toBe(5000)
  })

  it('重复事件（同 ID 或同内容）不产生锚点副本，校准方案不变', () => {
    let s = baseState()
    s = anchor(s, 101, 0)
    s = anchor(s, 103, 13000)
    const anchorsBefore = s.anchors

    // 同一事件 ID 重发
    s = ingest(s, segEvent(101, 0, 4000), 5000)
    expect(s.anchors).toBe(anchorsBefore) // 状态分支未触碰锚点（同一引用）
    expect(s.log.some((e) => e.kind === 'duplicate')).toBe(true)

    // 不同事件 ID 但内容完全相同
    s = ingest(s, { ...segEvent(103, 8000, 12000), id: 'e103-dup' }, 6000)
    expect(s.anchors).toBe(anchorsBefore)
    expect(s.anchors).toHaveLength(2)
  })

  it('锁定片段的修订冲突与裁决不丢锚点，「接受机器」后跟随新源时间', () => {
    let s = baseState()
    s = anchor(s, 101, 0)
    s = anchor(s, 102, 5000)
    s = consoleReducer(s, { type: 'toggle-lock', seq: 102 })

    // 锁定后修订到达 → 转入裁决，锚点原样保留
    s = ingest(s, segEvent(102, 4500, 8500, 2, '片段102修订'), 10000)
    expect(s.conflicts).toHaveLength(1)
    expect(s.anchors).toHaveLength(2)
    expect(s.segments[102].sourceIn).toBe(4000) // 人工内容未被覆盖

    // 裁决「接受机器」：源时间更新，锚点跟随
    s = consoleReducer(s, { type: 'resolve-conflict', seq: 102, choice: 'accept' })
    expect(s.anchors).toHaveLength(2)
    expect(s.segments[102].sourceIn).toBe(4500)
    const points = anchorPoints(s.anchors, s.segments)
    expect(points).toContainEqual(P(102, 4500, 5000))
    expect(mapSourceToProgram(points, 4500)).toBe(5000)
  })
})

describe('校准后预览', () => {
  /** 锚定 #101→0s、#103→13s（斜率 1.625）的状态 */
  function calibratedState(): ConsoleState {
    let s = baseState()
    s = anchor(s, 101, 0)
    s = anchor(s, 103, 13000)
    return s
  }

  it('calibratedTimeline 给出每条的校准窗口与当前偏移', () => {
    const windows = calibratedTimeline(calibratedState())
    expect(windows).toHaveLength(3)
    expect(windows.every((w) => w.calibrated)).toBe(true)
    expect(windows[0]).toMatchObject({ programIn: 0, programOut: 6500, offset: 0 })
    expect(windows[1]).toMatchObject({ programIn: 6500, programOut: 13000, offset: 2500 })
    expect(windows[2]).toMatchObject({ programIn: 13000, programOut: 19500, offset: 5000 })
  })

  it('播放头命中：窗口内返回对应片段（左闭右开），窗口外返回 null', () => {
    const s = calibratedState()
    expect(segmentAtProgramTime(s, 0)?.seg.seq).toBe(101)
    expect(segmentAtProgramTime(s, 6499)?.seg.seq).toBe(101)
    expect(segmentAtProgramTime(s, 6500)?.seg.seq).toBe(102) // 边界归属后一条
    expect(segmentAtProgramTime(s, 13000)?.seg.seq).toBe(103)
    expect(segmentAtProgramTime(s, 19500)).toBeNull() // 超出最后出点
    expect(segmentAtProgramTime(s, 999999)).toBeNull()
  })

  it('晚到补齐后，校准时间线与预览自动重算', () => {
    // 乱序：#101、#103 先到，#102 缺口
    let s = createInitialState()
    s = ingest(s, segEvent(101, 0, 4000), 0)
    s = ingest(s, segEvent(103, 8000, 12000), 100)
    s = anchor(s, 101, 0)
    s = anchor(s, 103, 13000)

    // #102 未到达：其校准窗口不存在，播放头落在该时段无字幕
    expect(calibratedTimeline(s)).toHaveLength(2)
    expect(segmentAtProgramTime(s, 7000)).toBeNull()
    expect(previewDomain(s)).toEqual({ min: 0, max: 19500 })

    // 晚到补齐：窗口出现，播放头命中 #102
    s = ingest(s, segEvent(102, 4000, 8000), 5000)
    expect(calibratedTimeline(s)).toHaveLength(3)
    const hit = segmentAtProgramTime(s, 7000)
    expect(hit?.seg.seq).toBe(102)
    expect(hit?.programIn).toBe(6500)
  })

  it('未启用校准时按源时间预览，偏移为 0', () => {
    const s = baseState() // 无锚点
    const windows = calibratedTimeline(s)
    expect(windows.every((w) => !w.calibrated && w.offset === 0)).toBe(true)
    expect(windows[1]).toMatchObject({ programIn: 4000, programOut: 8000 })
    expect(segmentAtProgramTime(s, 5000)?.seg.seq).toBe(102)
  })
})

describe('会话级状态：播放头与本地恢复', () => {
  it('set-playhead 更新播放头并钳制到非负', () => {
    let s = createInitialState()
    s = consoleReducer(s, { type: 'set-playhead', at: 12345 })
    expect(s.playheadMs).toBe(12345)
    s = consoleReducer(s, { type: 'set-playhead', at: -100 })
    expect(s.playheadMs).toBe(0)
  })

  it('reset 清空事件流状态，但保留校准锚点与播放头', () => {
    let s = baseState()
    s = anchor(s, 101, 0)
    s = anchor(s, 103, 13000)
    s = consoleReducer(s, { type: 'set-playhead', at: 7000 })
    expect(s.log.length).toBeGreaterThan(0)

    s = consoleReducer(s, { type: 'reset' })
    expect(s.segments).toEqual({})
    expect(s.log).toEqual([])
    expect(s.conflicts).toEqual([])
    expect(s.anchors).toEqual([
      { seq: 101, programAt: 0 },
      { seq: 103, programAt: 13000 },
    ])
    expect(s.playheadMs).toBe(7000)
    expect(s.calibrationError).toBeNull()
  })

  it('restore-calibration 恢复本地方案：清洗非法条目、按序号去重、幂等', () => {
    let s = createInitialState()
    s = consoleReducer(s, {
      type: 'restore-calibration',
      anchors: [
        { seq: 101, programAt: 0 },
        { seq: 103, programAt: 13000 },
        { seq: 103, programAt: 12900 }, // 同序号后者覆盖前者
        { seq: Number.NaN, programAt: 1 }, // 非法条目被过滤
        { seq: 105, programAt: -1 }, // 非法条目被过滤
      ],
      playheadMs: 4200,
    })
    expect(s.anchors).toEqual([
      { seq: 101, programAt: 0 },
      { seq: 103, programAt: 12900 },
    ])
    expect(s.playheadMs).toBe(4200)
    expect(s.log.some((e) => e.kind === 'calibration' && e.message.includes('恢复'))).toBe(true)

    // 相同数据重复恢复：状态原样返回（幂等，不重复记日志）
    const again = consoleReducer(s, {
      type: 'restore-calibration',
      anchors: s.anchors,
      playheadMs: s.playheadMs,
    })
    expect(again).toBe(s)
  })
})
