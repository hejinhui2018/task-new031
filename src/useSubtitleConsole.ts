import { useEffect, useReducer, useRef } from 'react'
import { consoleReducer, createInitialState } from './consoleReducer'
import { loadAnchors, saveAnchors } from './persistence'
import { Player } from './player'
import { SCENARIO } from './scenario'

/** 把纯函数 reducer 与播放器装配成 React 可用的整体。 */
export function useSubtitleConsole() {
  const [state, dispatch] = useReducer(consoleReducer, undefined, () => {
    // 启动时从浏览器本地恢复上次的校准方案；
    // 数据损坏或未通过校验时 reducer 会拒绝并保留空方案，不会污染状态。
    const saved = loadAnchors()
    const base = createInitialState()
    return saved.length > 0
      ? consoleReducer(base, { type: 'set-anchors', anchors: saved })
      : base
  })
  const playerRef = useRef<Player | null>(null)
  if (playerRef.current === null) {
    playerRef.current = new Player(SCENARIO, dispatch)
  }
  const [, bump] = useReducer((x: number) => x + 1, 0)

  useEffect(() => {
    const player = playerRef.current!
    const unsubscribe = player.subscribe(bump)
    return () => {
      unsubscribe()
      player.dispose()
    }
  }, [])

  // 校准方案变化时同步到浏览器本地（播放头位置由校准面板自行保存）
  useEffect(() => {
    saveAnchors(state.anchors)
  }, [state.anchors])

  return { state, dispatch, player: playerRef.current }
}
