interface HeaderProps {
  segmentCount: number
  gapCount: number
  duplicateCount: number
  conflictCount: number
  lockedCount: number
  anchorCount: number
}

/** 顶栏：台标、LIVE 标识与关键指标。所有指标均为 图标+文字+数字，不依赖颜色区分。 */
export function Header(props: HeaderProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-icon" aria-hidden="true">📡</span>
        <div>
          <h1>字幕校对台</h1>
          <p>Live Subtitle QC Console</p>
        </div>
      </div>
      <div className="live-badge">
        <span className="live-dot" aria-hidden="true" />
        LIVE · 直播中
      </div>
      <div className="stats">
        <span className="stat">
          <span aria-hidden="true">🧾</span> 片段 <strong>{props.segmentCount}</strong>
        </span>
        <span className={`stat${props.gapCount > 0 ? ' stat--warn' : ''}`}>
          <span aria-hidden="true">🕳️</span> 缺口 <strong>{props.gapCount}</strong>
        </span>
        <span className={`stat${props.duplicateCount > 0 ? ' stat--warn' : ''}`}>
          <span aria-hidden="true">🔁</span> 重复 <strong>{props.duplicateCount}</strong>
        </span>
        <span className={`stat${props.conflictCount > 0 ? ' stat--danger' : ''}`}>
          <span aria-hidden="true">⚖️</span> 待裁决冲突 <strong>{props.conflictCount}</strong>
        </span>
        <span className={`stat${props.lockedCount > 0 ? ' stat--manual' : ''}`}>
          <span aria-hidden="true">🔒</span> 锁定 <strong>{props.lockedCount}</strong>
        </span>
        <span className={`stat${props.anchorCount >= 2 ? ' stat--ok' : ''}`}>
          <span aria-hidden="true">⚓</span> 锚点 <strong>{props.anchorCount}</strong>
        </span>
      </div>
    </header>
  )
}
