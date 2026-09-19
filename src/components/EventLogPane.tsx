import type { LogEntry, LogKind } from '../types'

const KIND_META: Record<LogKind, { icon: string; label: string; className: string }> = {
  received: { icon: '📥', label: '接收', className: 'log--info' },
  backfilled: { icon: '🧩', label: '补齐', className: 'log--ok' },
  duplicate: { icon: '🔁', label: '重复', className: 'log--warn' },
  stale: { icon: '🗑️', label: '过期', className: 'log--muted' },
  revised: { icon: '✏️', label: '修订', className: 'log--info' },
  conflict: { icon: '⚠️', label: '冲突', className: 'log--danger' },
  manual: { icon: '✍️', label: '人工修改', className: 'log--manual' },
  lock: { icon: '🔒', label: '锁定', className: 'log--manual' },
  resolved: { icon: '✅', label: '裁决', className: 'log--ok' },
  calibration: { icon: '🎯', label: '校准', className: 'log--cal' },
}

/** 事件流：所有接收与裁决动作的审计记录，最新在最上。 */
export function EventLogPane({ log }: { log: LogEntry[] }) {
  const entries = [...log].reverse()
  return (
    <section className="pane log-pane" aria-label="事件流">
      <h2>
        <span aria-hidden="true">📜</span> 事件流
      </h2>
      {entries.length === 0 ? (
        <p className="muted">事件流为空。播放场景后，接收、重复、补齐、冲突等事件都会记录在这里。</p>
      ) : (
        <ul className="log" aria-live="polite">
          {entries.map((entry) => {
            const meta = KIND_META[entry.kind]
            return (
              <li key={entry.id} className={`log-entry ${meta.className}`}>
                <span className="log-icon" aria-hidden="true">
                  {meta.icon}
                </span>
                <span className="log-body">
                  <span className="log-head">
                    <strong>{meta.label}</strong>
                    {entry.seq !== null && <span className="seq">#{entry.seq}</span>}
                    <time>{entry.at !== null ? `+${(entry.at / 1000).toFixed(1)}s` : '手动'}</time>
                  </span>
                  <span className="log-msg">{entry.message}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
