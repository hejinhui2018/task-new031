import { useEffect, useReducer, useRef } from 'react'
import { consoleReducer, createInitialState } from './consoleReducer'
import { Player } from './player'
import { SCENARIO } from './scenario'
import type { CalibrationAnchor } from './types'

/** 校准方案与播放头位置的本地持久化键 */
const STORAGE_KEY = 'subtitle-qc-console:calibration:v1'

interface PersistedCalibration {
  anchors?: CalibrationAnchor[]
  playheadMs?: number
}

/** 把纯函数 reducer 与播放器装配成 React 可用的整体。 */
export function useSubtitleConsole() {
  const [state, dispatch] = useReducer(consoleReducer, undefined, createInitialState)
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

  // 启动时从浏览器本地恢复校准方案与播放头（数据损坏时静默忽略）
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const data = JSON.parse(raw) as PersistedCalibration
      dispatch({
        type: 'restore-calibration',
        anchors: Array.isArray(data.anchors) ? data.anchors : [],
        playheadMs: typeof data.playheadMs === 'number' ? data.playheadMs : 0,
      })
    } catch {
      // 本地数据不可读/已损坏：按无校准方案继续
    }
  }, [])

  // 校准方案或播放头变化时写入浏览器本地（存储不可用时静默降级）
  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ anchors: state.anchors, playheadMs: state.playheadMs }),
      )
    } catch {
      // 隐私模式等场景下 localStorage 可能不可用，不影响功能
    }
  }, [state.anchors, state.playheadMs])

  return { state, dispatch, player: playerRef.current }
}
