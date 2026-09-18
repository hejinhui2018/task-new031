import type { ConsoleAction } from '../consoleReducer'
import type { ConsoleState } from '../types'

interface ConflictPanelProps {
  state: ConsoleState
  dispatch: (action: ConsoleAction) => void
}

/** 待裁决冲突面板：锁定片段收到机器修订时出现，人工二选一。 */
export function ConflictPanel({ state, dispatch }: ConflictPanelProps) {
  if (state.conflicts.length === 0) return null
  return (
    <section className="conflict-panel" role="alert" aria-label="待裁决冲突">
      <h2>
        <span aria-hidden="true">⚠️</span> 待裁决冲突（{state.conflicts.length}）—
        已锁定片段收到机器修订，未自动覆盖，等待人工选择
      </h2>
      <div className="conflict-list">
        {state.conflicts.map((conflict) => {
          const seg = state.segments[conflict.seq]
          return (
            <article className="conflict-card" key={conflict.seq}>
              <header>
                <span className="seq">#{conflict.seq}</span>
                <span className="chip chip--locked">🔒 人工 v{seg?.version ?? conflict.manualVersion}</span>
                <span className="vs">VS</span>
                <span className="chip chip--danger">🤖 机器 v{conflict.incomingVersion}</span>
                {conflict.receivedAt !== null && (
                  <span className="muted">修订到达于 +{(conflict.receivedAt / 1000).toFixed(1)}s</span>
                )}
              </header>
              <div className="conflict-cols">
                <div className="col col--manual">
                  <h3>✍️ 人工版本（当前播出）</h3>
                  <p>{seg?.text ?? conflict.manualText}</p>
                </div>
                <div className="col col--machine">
                  <h3>🤖 机器修订（待应用）</h3>
                  <p>{conflict.incomingText}</p>
                </div>
              </div>
              <div className="conflict-actions">
                <button
                  type="button"
                  className="btn btn--keep"
                  onClick={() => dispatch({ type: 'resolve-conflict', seq: conflict.seq, choice: 'keep' })}
                >
                  ✋ 保留人工版本
                </button>
                <button
                  type="button"
                  className="btn btn--accept"
                  onClick={() => dispatch({ type: 'resolve-conflict', seq: conflict.seq, choice: 'accept' })}
                >
                  🤖 接受机器修订
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
