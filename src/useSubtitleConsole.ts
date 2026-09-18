import { useEffect, useReducer, useRef } from 'react'
import { consoleReducer, createInitialState } from './consoleReducer'
import { Player } from './player'
import { SCENARIO } from './scenario'

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

  return { state, dispatch, player: playerRef.current }
}
