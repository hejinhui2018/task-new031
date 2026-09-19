import { describe, expect, it } from 'vitest'
import {
  formatOffset,
  formatTimecode,
  mapProgramToSource,
  mapSourceToProgram,
  offsetAt,
  parseTimecode,
  upsertAnchor,
  validateAnchors,
} from '../calibration'
import { consoleReducer, createInitialState, type ConsoleAction } from '../consoleReducer'
import { loadAnchors, loadPlayhead, saveAnchors, savePlayhead } from '../persistence'
import { calibratedSegments, segmentAtProgramTime, sortedSegments } from '../selectors'
import type { CalibrationAnchor, ConsoleState, SubtitleEvent } from '../types'

/** 构造一条带源入点/出点的机器事件 */
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

const anchor = (seq: number, srcAt: number, programAt: number): CalibrationAnchor => ({
  seq,
  srcAt,
  programAt,
})

describe('分段线性映射：插值与外推', () => {
  it('两个锚点之间线性插值，锚点处精确命中', () => {
    const anchors = [anchor(101, 0, 1000), anchor(102, 10000, 12000)]
    expect(mapSourceToProgram(anchors, 0)).toBe(1000)
    expect(mapSourceToProgram(anchors, 10000)).toBe(12000)
    // 中点：源 5000 → 节目 1000 + 0.5 × 11000 = 6500
    expect(mapSourceToProgram(anchors, 5000)).toBe(6500)
  })

  it('范围外沿最近一段外推', () => {
    const anchors = [anchor(101, 10000, 20000), anchor(102, 20000, 23000)]
    // 两个锚点只有一段（斜率 0.3），首末外推都沿它：
    // 早于首锚点 5000ms → 节目时间早 5000 × 0.3 = 1500ms
    expect(mapSourceToProgram(anchors, 5000)).toBe(18500)
    // 晚于末锚点 10000ms → 节目时间晚 10000 × 0.3 = 3000ms
    expect(mapSourceToProgram(anchors, 30000)).toBe(26000)
  })

  it('三个锚点形成不同斜率的分段，偏移随时间变化（非固定偏差）', () => {
    const anchors = [anchor(101, 0, 0), anchor(102, 10000, 12000), anchor(103, 20000, 14000)]
    expect(mapSourceToProgram(anchors, 5000)).toBe(6000) // 第一段斜率 1.2
    expect(mapSourceToProgram(anchors, 15000)).toBe(13000) // 第二段斜率 0.2
    expect(mapSourceToProgram(anchors, -5000)).toBe(-6000) // 首段外推（斜率 1.2）
    expect(mapSourceToProgram(anchors, 30000)).toBe(16000) // 末段外推（斜率 0.2）
    // 漂移 = 偏移随时间变化：前段 +1000ms，后段 -2000ms
    expect(offsetAt(anchors, 5000)).toBe(1000)
    expect(offsetAt(anchors, 15000)).toBe(-2000)
  })

  it('单锚点退化为整体平移，零锚点为恒等映射', () => {
    expect(mapSourceToProgram([anchor(101, 5000, 8000)], 1000)).toBe(4000)
    expect(mapSourceToProgram([], 1234)).toBe(1234)
    expect(offsetAt([], 1234)).toBe(0)
  })

  it('节目时间可反查源时间（映射互逆）', () => {
    const anchors = [anchor(101, 0, 0), anchor(102, 10000, 12000), anchor(103, 20000, 14000)]
    for (const src of [0, 5000, 15000, 25000]) {
      expect(mapProgramToSource(anchors, mapSourceToProgram(anchors, src))).toBeCloseTo(src, 6)
    }
  })
})

describe('非法锚点校验', () => {
  it('节目时间未严格递增：指出冲突的两个片段', () => {
    const issues = validateAnchors([anchor(101, 0, 1000), anchor(102, 1000, 1000)])
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('节目时间')
    expect(issues[0].message).toContain('#101')
    expect(issues[0].message).toContain('#102')
  })

  it('源时间相同也算非法', () => {
    const issues = validateAnchors([anchor(101, 2000, 0), anchor(102, 2000, 1000)])
    expect(issues.some((i) => i.message.includes('源时间'))).toBe(true)
  })

  it('同一序号绑定多个锚点被拒绝', () => {
    const issues = validateAnchors([anchor(101, 0, 0), anchor(101, 1000, 2000)])
    expect(issues.some((i) => i.message.includes('#101'))).toBe(true)
  })

  it('合法方案通过校验；upsert 同序号替换而非复制', () => {
    expect(validateAnchors([anchor(101, 0, 0), anchor(102, 1000, 1500)])).toEqual([])
    const updated = upsertAnchor(
      [anchor(101, 0, 0), anchor(102, 1000, 1500)],
      anchor(101, 0, 300),
    )
    expect(updated).toHaveLength(2)
    expect(updated.find((a) => a.seq === 101)?.programAt).toBe(300)
  })
})

describe('校准方案在 reducer 中的行为', () => {
  function stateWithTwoSegments(): ConsoleState {
    return feed(createInitialState(), [
      ev('e101', 101, 1, '一', 'create', 0, 2400),
      ev('e102', 102, 1, '二', 'create', 2400, 4800),
    ])
  }

  it('合法方案被接受并按源时间排序存储', () => {
    let s = stateWithTwoSegments()
    s = consoleReducer(s, {
      type: 'set-anchors',
      anchors: [anchor(102, 2400, 5000), anchor(101, 0, 1000)],
    })
    expect(s.anchors.map((a) => a.seq)).toEqual([101, 102])
    expect(s.log.some((l) => l.kind === 'calibration')).toBe(true)
  })

  it('非法方案不能覆盖当前有效方案，日志说明冲突位置', () => {
    let s = stateWithTwoSegments()
    s = consoleReducer(s, {
      type: 'set-anchors',
      anchors: [anchor(101, 0, 1000), anchor(102, 2400, 5000)],
    })
    const valid = s.anchors
    // 节目时间倒挂：#101 → 6000 晚于 #102 → 5000
    s = consoleReducer(s, {
      type: 'set-anchors',
      anchors: [anchor(101, 0, 6000), anchor(102, 2400, 5000)],
    })
    expect(s.anchors).toEqual(valid) // 当前有效方案原样保留
    const log = s.log.find((l) => l.kind === 'calibration' && l.message.includes('未通过校验'))
    expect(log).toBeDefined()
    expect(log!.message).toContain('#101')
    expect(log!.message).toContain('#102')
  })

  it('remove-anchor 移除指定序号的锚点', () => {
    let s = stateWithTwoSegments()
    s = consoleReducer(s, {
      type: 'set-anchors',
      anchors: [anchor(101, 0, 1000), anchor(102, 2400, 5000)],
    })
    s = consoleReducer(s, { type: 'remove-anchor', seq: 101 })
    expect(s.anchors.map((a) => a.seq)).toEqual([102])
  })

  it('reset 保留校准方案（属于控制台配置），事件数据清零', () => {
    let s = stateWithTwoSegments()
    s = consoleReducer(s, {
      type: 'set-anchors',
      anchors: [anchor(101, 0, 1000), anchor(102, 2400, 5000)],
    })
    s = consoleReducer(s, { type: 'reset' })
    expect(s.segments).toEqual({})
    expect(s.log).toEqual([])
    expect(s.anchors).toHaveLength(2)
  })
})

describe('锚点身份保持', () => {
  it('同一片段收到更高版本修订后锚点保留，映射不变', () => {
    let s = feed(createInitialState(), [
      ev('e101', 101, 1, '一', 'create', 0, 2400),
      ev('e102', 102, 1, '二', 'create', 2400, 4800),
    ])
    s = consoleReducer(s, {
      type: 'set-anchors',
      anchors: [anchor(101, 0, 1000), anchor(102, 2400, 5000)],
    })
    s = consoleReducer(s, ingest(ev('e102v2', 102, 2, '二（修订）', 'revision', 2400, 4800), 10000))

    expect(s.segments[102].version).toBe(2)
    expect(s.segments[102].text).toBe('二（修订）')
    expect(s.anchors).toHaveLength(2) // 锚点按字幕序号绑定，修订不影响
    expect(mapSourceToProgram(s.anchors, 2400)).toBe(5000)
  })

  it('重复事件不产生锚点副本，也不产生片段副本', () => {
    let s = feed(createInitialState(), [ev('e101', 101, 1, '一', 'create', 0, 2400)])
    s = consoleReducer(s, { type: 'set-anchors', anchors: [anchor(101, 0, 1000)] })
    s = consoleReducer(s, ingest(ev('e101', 101, 1, '一', 'create', 0, 2400))) // 同事件重发
    expect(sortedSegments(s)).toHaveLength(1)
    expect(s.anchors).toHaveLength(1)
    expect(s.log.some((l) => l.kind === 'duplicate')).toBe(true)
  })
})

describe('校准后预览', () => {
  /** 源时钟相对节目时钟逐渐走快：#101 对齐 0，#103 源入点 4800 对应节目 5000 */
  function calibratedState(): ConsoleState {
    const s = feed(createInitialState(), [
      ev('e101', 101, 1, '一', 'create', 0, 2400),
      ev('e102', 102, 1, '二', 'create', 2400, 4800),
      ev('e103', 103, 1, '三', 'create', 4800, 7200),
    ])
    return consoleReducer(s, {
      type: 'set-anchors',
      anchors: [anchor(101, 0, 0), anchor(103, 4800, 5000)],
    })
  }

  it('片段的校准入点/出点按分段线性映射计算', () => {
    const s = calibratedState()
    const calib = calibratedSegments(s)
    expect(calib.map((c) => [c.seg.seq, c.progIn, c.progOut])).toEqual([
      [101, 0, 2500],
      [102, 2500, 5000],
      [103, 5000, 7500],
    ])
    expect(calib[1].offsetMs).toBeCloseTo(100, 6) // #102 源入点处节目比源慢 100ms
  })

  it('播放头命中校准区间返回对应片段，间隙与界外返回 null', () => {
    const s = calibratedState()
    expect(segmentAtProgramTime(s, 2600)?.seg.seq).toBe(102)
    expect(segmentAtProgramTime(s, 5000)?.seg.seq).toBe(103) // 区间左闭右开
    expect(segmentAtProgramTime(s, 8000)).toBeNull() // 超出最后出点
  })

  it('晚到补齐后校准时间线与预览自动重算', () => {
    let s = feed(createInitialState(), [
      ev('e101', 101, 1, '一', 'create', 0, 2400),
      ev('e103', 103, 1, '三', 'create', 4800, 7200),
    ])
    s = consoleReducer(s, {
      type: 'set-anchors',
      anchors: [anchor(101, 0, 0), anchor(103, 4800, 5000)],
    })
    expect(calibratedSegments(s).map((c) => c.seg.seq)).toEqual([101, 103])
    expect(segmentAtProgramTime(s, 2600)).toBeNull() // #102 尚未到达

    s = consoleReducer(s, ingest(ev('e102', 102, 1, '二', 'create', 2400, 4800), 4500))
    expect(calibratedSegments(s).map((c) => c.seg.seq)).toEqual([101, 102, 103])
    expect(segmentAtProgramTime(s, 2600)?.seg.seq).toBe(102) // 补齐后立即可预览
  })
})

describe('时间码解析与格式化', () => {
  it('支持秒与分:秒两种写法', () => {
    expect(parseTimecode('75.5')).toBe(75500)
    expect(parseTimecode('01:15.5')).toBe(75500)
    expect(parseTimecode('90')).toBe(90000)
    expect(parseTimecode(' 4.5 ')).toBe(4500)
  })

  it('拒绝非法输入', () => {
    expect(parseTimecode('')).toBeNull()
    expect(parseTimecode('abc')).toBeNull()
    expect(parseTimecode('1:75')).toBeNull() // 分:秒写法下秒位不能超过 59
    expect(parseTimecode('-5')).toBeNull()
  })

  it('格式化时间码与偏移量', () => {
    expect(formatTimecode(75500)).toBe('01:15.5')
    expect(formatTimecode(4900)).toBe('00:04.9')
    expect(formatOffset(2500)).toBe('+2.5s')
    expect(formatOffset(-1200)).toBe('-1.2s')
    expect(formatOffset(0)).toBe('±0.0s')
  })
})

describe('浏览器本地保存', () => {
  it('无 localStorage 环境下读写安全降级', () => {
    expect(loadAnchors()).toEqual([])
    expect(loadPlayhead()).toBeNull()
    expect(() => saveAnchors([anchor(101, 0, 0)])).not.toThrow()
    expect(() => savePlayhead(1234)).not.toThrow()
  })
})
