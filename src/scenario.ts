import type { ScheduledEvent } from './types'

/**
 * 内置的“网络抖动”演练场景。
 *
 * 事件序列（逻辑时间固定，可稳定重放）：
 *   +0.0s  #101 新字幕
 *   +1.5s  #103 新字幕（#102 尚未到达，时间线出现缺口）
 *   +3.0s  #103 重复推送（同一事件 ID，应被去重）
 *   +4.5s  #102 晚到（应自动补回缺口）
 *  +10.0s  #102 的机器修订 v2（若已锁定则转入人工裁决）
 *
 * 修订故意留足 5.5 秒间隔，方便运营在修订到达前暂停、编辑并锁定 #102。
 *
 * 每条字幕都携带字幕机源时钟上的入点/出点（srcIn/srcOut，毫秒）：
 * 源时钟上每条字幕占 2.4s 的连续槽位（#101: 0–2400，#102: 2400–4800，
 * #103: 4800–7200），与到达顺序无关——乱序是网络抖动，不是源时钟错乱。
 * 运营可在校准面板把这些源时间码对齐到节目时间码，拟合源时钟漂移。
 */
export const SCENARIO_TITLE = '网络抖动演练：乱序 · 重复 · 晚到 · 修订'

export const SCENARIO: ScheduledEvent[] = [
  {
    at: 0,
    event: { id: 'evt-101-v1', seq: 101, version: 1, kind: 'create', text: '各位观众晚上好，欢迎收看晚间新闻直播。', srcIn: 0, srcOut: 2400 },
  },
  {
    at: 1500,
    event: { id: 'evt-103-v1', seq: 103, version: 1, kind: 'create', text: '首先来看今天的主要新闻摘要。', srcIn: 4800, srcOut: 7200 },
  },
  {
    at: 3000,
    event: { id: 'evt-103-v1', seq: 103, version: 1, kind: 'create', text: '首先来看今天的主要新闻摘要。', srcIn: 4800, srcOut: 7200 },
  },
  {
    at: 4500,
    event: { id: 'evt-102-v1', seq: 102, version: 1, kind: 'create', text: '现在是北京时间晚上八点整。', srcIn: 2400, srcOut: 4800 },
  },
  {
    at: 10000,
    event: { id: 'evt-102-v2', seq: 102, version: 2, kind: 'revision', text: '现在是北京时间晚上八点零五分。', srcIn: 2400, srcOut: 4800 },
  },
]

export const SCENARIO_HINT =
  '场景：#101 → #103 → #103（重复）→ #102（晚到）→ #102 的机器修订 v2。' +
  '提示：在 #102 补齐后点击「⏸ 暂停」，修改并锁定 #102，再继续播放，即可观察锁定冲突的人工裁决流程。' +
  '新增：在「时钟漂移校准」面板为至少两条字幕录入节目时间码，即可看到漂移曲线，并拖动播放头预览校准后的字幕切换。'
