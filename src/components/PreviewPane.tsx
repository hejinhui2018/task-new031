import type { SubtitleSegment } from '../types'

interface PreviewPaneProps {
  onAir: SubtitleSegment | null
  blockingGap: number | null
  upcoming: SubtitleSegment[]
}

/** 直播预览：模拟播出监视器，展示当前播出字幕与被缺口阻塞的待播队列。 */
export function PreviewPane({ onAir, blockingGap, upcoming }: PreviewPaneProps) {
  return (
    <section className="pane preview-pane" aria-label="直播预览">
      <h2>
        <span aria-hidden="true">📺</span> 直播预览
      </h2>
      <div className="monitor">
        {onAir ? (
          <>
            <div className="monitor-top">
              <span className="onair-tag">
                <span className="live-dot" aria-hidden="true" /> ON AIR · 播出中
              </span>
              <span className="monitor-seq">
                #{onAir.seq} · v{onAir.version} · {onAir.origin === 'manual' ? '✍️ 人工' : '🤖 机器'}
                {onAir.locked ? ' · 🔒 已锁定' : ''}
              </span>
            </div>
            <p className="monitor-text">{onAir.text}</p>
          </>
        ) : (
          <p className="monitor-idle">信号待机 — 尚未收到可播出的字幕</p>
        )}
      </div>

      {blockingGap !== null && (
        <div className="alert-strip" role="alert">
          <span aria-hidden="true">⚠️</span> 播出中断风险：#{blockingGap} 缺失
          {upcoming.length > 0 ? `，${upcoming.length} 条已到达片段被阻塞` : ''}
        </div>
      )}

      <div className="upcoming">
        <h3>待播队列（{upcoming.length}）</h3>
        {upcoming.length === 0 ? (
          <p className="muted">暂无待播片段</p>
        ) : (
          <ul>
            {upcoming.map((seg) => (
              <li key={seg.seq}>
                <span className="seq">#{seg.seq}</span>
                <span className="upcoming-text">{seg.text}</span>
                {blockingGap !== null && (
                  <span className="chip chip--warn">⏸ 等待 #{blockingGap} 补齐</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
