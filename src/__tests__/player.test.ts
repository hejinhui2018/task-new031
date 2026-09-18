import { describe, expect, it } from 'vitest'
import { consoleReducer, createInitialState, type ConsoleAction } from '../consoleReducer'
import { Player } from '../player'
import { SCENARIO } from '../scenario'

/**
 * 用可手动推进的调度器与时钟驱动播放器，
 * 不依赖真实定时器，测试完全同步、确定。
 */
function makeHarness() {
  let state = createInitialState()
  let pending: { fn: () => void; ms: number } | null = null
  let now = 0
  const actions: ConsoleAction[] = []

  const player = new Player(
    SCENARIO,
    (action: ConsoleAction) => {
      actions.push(action)
      state = consoleReducer(state, action)
    },
    (fn, ms) => {
      pending = { fn, ms }
      return () => {
        pending = null
      }
    },
    () => now,
  )

  return {
    player,
    actions,
    getState: () => state,
    scheduledDelay: () => pending?.ms ?? null,
    setNow: (ms: number) => {
      now = ms
    },
    /** 触发当前排定的定时器（即“时间到了，投递下一事件”） */
    fireTimer: () => {
      const timer = pending
      pending = null
      if (!timer) throw new Error('没有已排定的定时器')
      timer.fn()
    },
  }
}

describe('播放器', () => {
  it('按场景时间表依次投递全部事件后完成', () => {
    const h = makeHarness()
    h.player.play()
    expect(h.player.status).toBe('playing')
    expect(h.scheduledDelay()).toBe(0) // 首个事件 at=0，立即投递

    for (let i = 0; i < SCENARIO.length; i += 1) {
      h.fireTimer()
    }

    expect(h.player.status).toBe('finished')
    expect(h.player.deliveredCount).toBe(SCENARIO.length)
    expect(Object.keys(h.getState().segments).map(Number).sort()).toEqual([101, 102, 103])
    // 全部 5 个事件按场景逻辑时间依次投递（含重复事件与修订）
    const ingestAts = h.actions
      .filter((a): a is Extract<ConsoleAction, { type: 'ingest' }> => a.type === 'ingest')
      .map((a) => a.receivedAt)
    expect(ingestAts).toEqual([0, 1500, 3000, 4500, 10000])
  })

  it('暂停结算剩余时间，倍速影响后续排程', () => {
    const h = makeHarness()
    h.player.play()
    h.fireTimer() // 投递 #101，下一事件在 +1500ms

    h.setNow(600)
    h.player.pause() // 已流逝 600ms（1×），剩余逻辑时间 900ms
    expect(h.player.status).toBe('paused')

    h.player.setSpeed(3)
    h.player.play()
    expect(h.scheduledDelay()).toBe(300) // 900 / 3

    h.fireTimer()
    expect(h.player.deliveredCount).toBe(2)
  })

  it('单步逐条投递，与播放混用时间隔仍然正确', () => {
    const h = makeHarness()
    h.player.step() // #101
    h.player.step() // #103
    expect(h.player.deliveredCount).toBe(2)
    expect(h.player.status).toBe('idle')

    h.player.play()
    // 下一条是重复的 #103（at=3000），距上一条（at=1500）间隔 1500ms
    expect(h.scheduledDelay()).toBe(1500)

    h.fireTimer()
    h.fireTimer()
    h.fireTimer()
    expect(h.player.status).toBe('finished')
    expect(h.player.deliveredCount).toBe(5)
  })

  it('重放：先重置到干净状态，再从头投递，两轮结果一致', () => {
    const h = makeHarness()
    h.player.play()
    for (let i = 0; i < SCENARIO.length; i += 1) h.fireTimer()
    const firstRun = h.getState()
    expect(firstRun.log.length).toBeGreaterThan(0)

    h.player.replay()
    // 重放立即重置并重新排程首个事件
    expect(h.actions.some((a) => a.type === 'reset')).toBe(true)
    expect(h.player.status).toBe('playing')
    expect(h.player.deliveredCount).toBe(0)
    expect(h.scheduledDelay()).toBe(0)

    for (let i = 0; i < SCENARIO.length; i += 1) h.fireTimer()
    expect(h.player.status).toBe('finished')

    // 第二轮终态与第一轮逐位相同 —— 上一轮不留任何残留
    expect(h.getState()).toEqual(firstRun)
  })
})
