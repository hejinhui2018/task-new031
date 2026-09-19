import { describe, expect, it } from 'vitest'
import { consoleReducer, createInitialState, type ConsoleAction } from '../consoleReducer'
import { SCENARIO } from '../scenario'
import { gaps, onAirSeq, sortedSegments } from '../selectors'
import type { ConsoleState, SubtitleEvent } from '../types'

/** 构造一条机器事件（默认按序号生成确定性的源入点/出点） */
function ev(
  id: string,
  seq: number,
  version: number,
  text: string,
  kind: 'create' | 'revision' = 'create',
  srcIn = seq * 1000,
  srcOut = seq * 1000 + 2000,
): SubtitleEvent {
  return { id, seq, version, kind, text, srcIn, srcOut }
}

function ingest(event: SubtitleEvent, receivedAt: number | null = null): ConsoleAction {
  return { type: 'ingest', event, receivedAt }
}

function feed(state: ConsoleState, events: SubtitleEvent[]): ConsoleState {
  return events.reduce((s, e) => consoleReducer(s, ingest(e)), state)
}

/** 按场景脚本的逻辑时间完整跑一遍 */
function runScenario(): ConsoleState {
  return SCENARIO.reduce(
    (s, item) => consoleReducer(s, { type: 'ingest', event: item.event, receivedAt: item.at }),
    createInitialState(),
  )
}

describe('乱序补齐', () => {
  it('乱序到达留下明显空位，晚到片段自动补回', () => {
    let s = createInitialState()
    s = consoleReducer(s, ingest(ev('e101', 101, 1, '一'), 0))
    s = consoleReducer(s, ingest(ev('e103', 103, 1, '三'), 1500))

    // 103 先于 102 到达：时间线上 102 位置是缺口，播出不能越过缺口
    expect(sortedSegments(s).map((seg) => seg.seq)).toEqual([101, 103])
    expect(gaps(s)).toEqual([102])
    expect(onAirSeq(s)).toBe(101)

    // 晚到的 102 自动补回缺口，播出推进到 103
    s = consoleReducer(s, ingest(ev('e102', 102, 1, '二'), 4500))
    expect(sortedSegments(s).map((seg) => seg.seq)).toEqual([101, 102, 103])
    expect(gaps(s)).toEqual([])
    expect(onAirSeq(s)).toBe(103)

    const backfillLogs = s.log.filter((entry) => entry.kind === 'backfilled')
    expect(backfillLogs).toHaveLength(1)
    expect(backfillLogs[0].seq).toBe(102)
  })
})

describe('重复去重', () => {
  it('同一事件重复到达不会生成两条字幕', () => {
    const first = ev('e103', 103, 1, '三')
    const resent = ev('e103', 103, 1, '三') // 网络重发，事件 ID 相同
    const s = feed(createInitialState(), [ev('e101', 101, 1, '一'), first, resent])

    expect(sortedSegments(s)).toHaveLength(2)
    expect(s.log.filter((entry) => entry.kind === 'duplicate')).toHaveLength(1)
    expect(s.log.find((entry) => entry.kind === 'duplicate')?.seq).toBe(103)
  })

  it('不同事件 ID 但内容完全相同的重复同样被忽略', () => {
    const s = feed(createInitialState(), [
      ev('e103a', 103, 1, '三'),
      ev('e103b', 103, 1, '三'), // 内容级重复
    ])

    expect(sortedSegments(s)).toHaveLength(1)
    expect(s.segments[103].text).toBe('三')
    expect(s.log.filter((entry) => entry.kind === 'duplicate')).toHaveLength(1)
  })
})

describe('版本更新', () => {
  it('未锁定片段直接应用机器修订', () => {
    let s = feed(createInitialState(), [ev('e101v1', 101, 1, '旧文本')])
    s = consoleReducer(s, ingest(ev('e101v2', 101, 2, '新文本', 'revision'), 9000))

    expect(s.segments[101].text).toBe('新文本')
    expect(s.segments[101].version).toBe(2)
    expect(s.log.some((entry) => entry.kind === 'revised' && entry.seq === 101)).toBe(true)
  })

  it('过期版本被忽略，不会回退内容', () => {
    let s = feed(createInitialState(), [ev('e101v1', 101, 1, '旧文本'), ev('e101v2', 101, 2, '新文本', 'revision')])
    s = consoleReducer(s, ingest(ev('e101v1b', 101, 1, '更旧的文本', 'revision')))

    expect(s.segments[101].version).toBe(2)
    expect(s.segments[101].text).toBe('新文本')
    expect(s.log.some((entry) => entry.kind === 'stale')).toBe(true)
  })
})

describe('锁定冲突', () => {
  function lockedManual102(): ConsoleState {
    let s = feed(createInitialState(), [ev('e102v1', 102, 1, '机器原文')])
    s = consoleReducer(s, { type: 'edit', seq: 102, text: '人工修正稿' })
    s = consoleReducer(s, { type: 'toggle-lock', seq: 102 })
    return s
  }

  it('锁定后机器修订不静默覆盖，转为待裁决冲突', () => {
    let s = lockedManual102()
    s = consoleReducer(s, ingest(ev('e102v2', 102, 2, '机器修订稿', 'revision'), 10000))

    // 人工内容原样保留
    expect(s.segments[102].text).toBe('人工修正稿')
    expect(s.segments[102].version).toBe(1)
    expect(s.segments[102].locked).toBe(true)

    // 冲突登记在案
    expect(s.conflicts).toHaveLength(1)
    expect(s.conflicts[0]).toMatchObject({
      seq: 102,
      manualText: '人工修正稿',
      incomingText: '机器修订稿',
      incomingVersion: 2,
    })
    expect(s.log.some((entry) => entry.kind === 'conflict')).toBe(true)
  })

  it('锁定状态下不能直接编辑', () => {
    let s = lockedManual102()
    s = consoleReducer(s, { type: 'edit', seq: 102, text: '试图改写' })
    expect(s.segments[102].text).toBe('人工修正稿')
  })

  it('裁决「保留人工版本」：维持人工内容与锁定', () => {
    let s = lockedManual102()
    s = consoleReducer(s, ingest(ev('e102v2', 102, 2, '机器修订稿', 'revision')))
    s = consoleReducer(s, { type: 'resolve-conflict', seq: 102, choice: 'keep' })

    expect(s.conflicts).toHaveLength(0)
    expect(s.segments[102].text).toBe('人工修正稿')
    expect(s.segments[102].version).toBe(1)
    expect(s.segments[102].locked).toBe(true)
    expect(s.log.some((entry) => entry.kind === 'resolved')).toBe(true)
  })

  it('裁决「接受机器修订」：应用新版本并解除锁定', () => {
    let s = lockedManual102()
    s = consoleReducer(s, ingest(ev('e102v2', 102, 2, '机器修订稿', 'revision')))
    s = consoleReducer(s, { type: 'resolve-conflict', seq: 102, choice: 'accept' })

    expect(s.conflicts).toHaveLength(0)
    expect(s.segments[102].text).toBe('机器修订稿')
    expect(s.segments[102].version).toBe(2)
    expect(s.segments[102].locked).toBe(false)
    expect(s.segments[102].origin).toBe('machine')
  })
})

describe('无残留重放', () => {
  it('reset 后状态与全新初始状态完全一致', () => {
    // 先制造一轮“脏”状态：片段、缺口、去重记录、人工修改、锁定、冲突、日志
    let s = createInitialState()
    for (const item of SCENARIO.slice(0, 4)) {
      s = consoleReducer(s, { type: 'ingest', event: item.event, receivedAt: item.at })
    }
    s = consoleReducer(s, { type: 'edit', seq: 102, text: '人工版本' })
    s = consoleReducer(s, { type: 'toggle-lock', seq: 102 })
    s = consoleReducer(s, { type: 'ingest', event: SCENARIO[4].event, receivedAt: SCENARIO[4].at })
    expect(s.conflicts).toHaveLength(1)
    s = consoleReducer(s, { type: 'resolve-conflict', seq: 102, choice: 'keep' })
    expect(s.log.length).toBeGreaterThan(0)

    const reset = consoleReducer(s, { type: 'reset' })
    expect(reset).toEqual(createInitialState())
  })

  it('相同操作序列重放两次，结果逐位相同', () => {
    const runA = runScenario()
    const runB = runScenario()
    expect(runA).toEqual(runB)
  })

  it('完整场景端到端：补齐、去重、修订各发生一次，终态正确', () => {
    const s = runScenario()

    expect(sortedSegments(s).map((seg) => seg.seq)).toEqual([101, 102, 103])
    expect(gaps(s)).toEqual([])
    expect(onAirSeq(s)).toBe(103)
    // 未锁定时，#102 的修订 v2 直接应用
    expect(s.segments[102].version).toBe(2)
    expect(s.segments[102].text).toBe('现在是北京时间晚上八点零五分。')
    expect(s.conflicts).toHaveLength(0)

    expect(s.log.filter((entry) => entry.kind === 'duplicate')).toHaveLength(1)
    expect(s.log.filter((entry) => entry.kind === 'backfilled')).toHaveLength(1)
    expect(s.log.filter((entry) => entry.kind === 'revised')).toHaveLength(1)
  })
})
