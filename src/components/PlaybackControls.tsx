import type { Player, PlayerStatus } from '../player'
import { SCENARIO_HINT } from '../scenario'

const SPEEDS = [0.5, 1, 2, 4]

const STATUS_LABEL: Record<PlayerStatus, string> = {
  idle: '待机',
  playing: '播放中',
  paused: '已暂停',
  finished: '已完成',
}

/** 播放控制条：播放 / 暂停 / 单步 / 倍速 / 重放 + 进度与场景提示。 */
export function PlaybackControls({ player }: { player: Player }) {
  const status = player.status
  const next = player.nextEvent
  const progress = player.totalCount === 0 ? 0 : player.deliveredCount / player.totalCount

  return (
    <footer className="controls">
      <div className="controls-row">
        <div className="btn-group" role="group" aria-label="播放控制">
          <button
            type="button"
            onClick={() => player.play()}
            disabled={status === 'playing' || status === 'finished'}
          >
            ▶ 播放
          </button>
          <button type="button" onClick={() => player.pause()} disabled={status !== 'playing'}>
            ⏸ 暂停
          </button>
          <button
            type="button"
            onClick={() => player.step()}
            disabled={status === 'playing' || status === 'finished'}
          >
            ⏭ 单步
          </button>
          <button type="button" onClick={() => player.replay()}>
            ↺ 重放
          </button>
        </div>

        <div className="btn-group" role="group" aria-label="倍速">
          <span className="group-label">倍速</span>
          {SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              className={player.speed === speed ? 'active' : ''}
              aria-pressed={player.speed === speed}
              onClick={() => player.setSpeed(speed)}
            >
              {speed}×
            </button>
          ))}
        </div>

        <div className="progress">
          <span>
            状态：<strong>{STATUS_LABEL[status]}</strong>
          </span>
          <span>
            事件 {player.deliveredCount}/{player.totalCount}
          </span>
          <div
            className="bar"
            role="progressbar"
            aria-valuenow={player.deliveredCount}
            aria-valuemin={0}
            aria-valuemax={player.totalCount}
            aria-label="场景播放进度"
          >
            <div className="bar-fill" style={{ width: `${progress * 100}%` }} />
          </div>
          {next && status !== 'finished' && (
            <span className="next">
              下一事件：+{(next.at / 1000).toFixed(1)}s · #{next.event.seq}{' '}
              {next.event.kind === 'revision' ? `修订 v${next.event.version}` : '新字幕'}
            </span>
          )}
        </div>
      </div>
      <p className="hint">{SCENARIO_HINT}</p>
    </footer>
  )
}
