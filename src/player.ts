import type { ConsoleAction } from './consoleReducer'
import type { ScheduledEvent } from './types'

/**
 * 场景播放器：按逻辑时间表把事件投递进 reducer。
 *
 * 调度器与时钟均可注入——生产环境用 setTimeout / Date.now，
 * 测试用手动时钟同步驱动，因此播放行为本身也是可测试、可重放的。
 */

export type PlayerStatus = 'idle' | 'playing' | 'paused' | 'finished'

export type CancelTimer = () => void
export type Scheduler = (fn: () => void, delayMs: number) => CancelTimer
export type Clock = () => number

const defaultScheduler: Scheduler = (fn, delayMs) => {
  const timer = setTimeout(fn, delayMs)
  return () => clearTimeout(timer)
}

export class Player {
  private cursor = 0
  private delivered = 0
  private _status: PlayerStatus = 'idle'
  private _speed = 1
  private cancelTimer: CancelTimer | null = null
  private timerStartedAt = 0
  /** 距下一事件剩余的“逻辑毫秒”（场景时间轴上的距离，与倍速无关） */
  private remainingLogicalMs = 0
  private listeners = new Set<() => void>()

  constructor(
    private readonly scenario: ScheduledEvent[],
    private readonly dispatch: (action: ConsoleAction) => void,
    private readonly scheduler: Scheduler = defaultScheduler,
    private readonly now: Clock = () => Date.now(),
  ) {}

  get status(): PlayerStatus {
    return this._status
  }

  get speed(): number {
    return this._speed
  }

  get deliveredCount(): number {
    return this.delivered
  }

  get totalCount(): number {
    return this.scenario.length
  }

  get nextEvent(): ScheduledEvent | null {
    return this.scenario[this.cursor] ?? null
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  play(): void {
    if (this._status === 'playing' || this._status === 'finished') return
    if (this.cursor >= this.scenario.length) {
      this._status = 'finished'
      this.emit()
      return
    }
    // 只有全新一轮（尚未投递任何事件）才用首个事件的绝对时间作为等待；
    // 暂停/单步之后 remainingLogicalMs 已被正确维护，不能覆盖。
    if (this.delivered === 0) {
      this.remainingLogicalMs = this.scenario[this.cursor].at
    }
    this._status = 'playing'
    this.armTimer()
    this.emit()
  }

  pause(): void {
    if (this._status !== 'playing') return
    this.settleRemaining()
    this._status = 'paused'
    this.emit()
  }

  /** 单步：立即投递下一事件（仅在非播放状态可用） */
  step(): void {
    if (this._status === 'playing' || this._status === 'finished') return
    if (this.cursor >= this.scenario.length) return
    this.deliver()
    this.emit()
  }

  setSpeed(speed: number): void {
    if (speed <= 0) return
    if (this._status === 'playing') this.settleRemaining() // 先按旧倍速结算
    this._speed = speed
    if (this._status === 'playing') this.armTimer() // 再按新倍速重新排程
    this.emit()
  }

  /** 重放：重置控制台状态并从头开始播放，保证每一轮都从干净状态出发 */
  replay(): void {
    this.cancelPendingTimer()
    this.cursor = 0
    this.delivered = 0
    this.remainingLogicalMs = 0
    this._status = 'idle'
    this.dispatch({ type: 'reset' })
    this.play()
  }

  dispose(): void {
    this.cancelPendingTimer()
    this.listeners.clear()
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener())
  }

  /** 取消定时器，并把已流逝的时间折算成逻辑毫秒从剩余时间里扣除 */
  private settleRemaining(): void {
    if (!this.cancelTimer) return
    this.cancelTimer()
    this.cancelTimer = null
    const elapsedRealMs = this.now() - this.timerStartedAt
    this.remainingLogicalMs = Math.max(0, this.remainingLogicalMs - elapsedRealMs * this._speed)
  }

  private cancelPendingTimer(): void {
    if (this.cancelTimer) {
      this.cancelTimer()
      this.cancelTimer = null
    }
  }

  private armTimer(): void {
    const realDelayMs = this.remainingLogicalMs / this._speed
    this.timerStartedAt = this.now()
    this.cancelTimer = this.scheduler(() => this.fire(), realDelayMs)
  }

  private fire(): void {
    this.cancelTimer = null
    this.deliver()
    if (this._status === 'playing' && this.cursor < this.scenario.length) {
      this.armTimer()
    }
    this.emit()
  }

  private deliver(): void {
    const item = this.scenario[this.cursor]
    if (!item) return
    this.dispatch({ type: 'ingest', event: item.event, receivedAt: item.at })
    this.delivered += 1
    this.cursor += 1
    const next = this.scenario[this.cursor]
    if (next) {
      this.remainingLogicalMs = next.at - item.at
    } else {
      this.remainingLogicalMs = 0
      this._status = 'finished'
    }
  }
}
