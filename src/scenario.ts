import type { ScheduledEvent } from './types'

/**
 * 内置的“网络抖动”演练场景。
 *
 * 事件序列（逻辑时间固定，可稳定重放）：
 *   +0.0s  #101 新字幕（源时间 0.0s–4.0s）
 *   +1.5s  #103 新字幕（源时间 8.0s–12.0s，#102 尚未到达，时间线出现缺口）
 *   +3.0s  #103 重复推送（同一事件 ID，应被去重）
 *   +4.5s  #102 晚到（源时间 4.0s–8.0s，应自动补回缺口）
 *  +10.0s  #102 的机器修订 v2（源时间不变；若已锁定则转入人工裁决）
 *
 * 修订故意留足 5.5 秒间隔，方便运营在修订到达前暂停、编辑并锁定 #102。
 * 源入点/出点是字幕机时钟上的播出窗口，供漂移校准使用。
 */
export const SCENARIO_TITLE = '网络抖动演练：乱序 · 重复 · 晚到 · 修订'

export const SCENARIO: ScheduledEvent[] = [
  {
    at: 0,
    event: {
      id: 'evt-101-v1',
      seq: 101,
      version: 1,
      kind: 'create',
      text: '各位观众晚上好，欢迎收看晚间新闻直播。',
      sourceIn: 0,
      sourceOut: 4000,
    },
  },
  {
    at: 1500,
    event: {
      id: 'evt-103-v1',
      seq: 103,
      version: 1,
      kind: 'create',
      text: '首先来看今天的主要新闻摘要。',
      sourceIn: 8000,
      sourceOut: 12000,
    },
  },
  {
    at: 3000,
    event: {
      id: 'evt-103-v1',
      seq: 103,
      version: 1,
      kind: 'create',
      text: '首先来看今天的主要新闻摘要。',
      sourceIn: 8000,
      sourceOut: 12000,
    },
  },
  {
    at: 4500,
    event: {
      id: 'evt-102-v1',
      seq: 102,
      version: 1,
      kind: 'create',
      text: '现在是北京时间晚上八点整。',
      sourceIn: 4000,
      sourceOut: 8000,
    },
  },
  {
    at: 10000,
    event: {
      id: 'evt-102-v2',
      seq: 102,
      version: 2,
      kind: 'revision',
      text: '现在是北京时间晚上八点零五分。',
      sourceIn: 4000,
      sourceOut: 8000,
    },
  },
]

export const SCENARIO_HINT =
  '场景：#101 → #103 → #103（重复）→ #102（晚到）→ #102 的机器修订 v2。' +
  '提示：在 #102 补齐后点击「⏸ 暂停」，修改并锁定 #102，再继续播放，即可观察锁定冲突的人工裁决流程。'

export const CALIBRATION_HINT =
  '字幕机时钟会逐渐偏离节目时钟。为至少两个已确认片段录入节目时间码作为锚点，' +
  '系统在锚点间分段线性映射、范围外沿最近一段外推。' +
  '示例：把 #101 锚定到 0.0s、#103 锚定到 12.9s，即可看到漂移曲线与后段外推效果。'
