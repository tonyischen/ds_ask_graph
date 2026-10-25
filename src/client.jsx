import React from 'react'
import flowStyles from '@xyflow/react/dist/style.css'
import styles from './styles.css'
import { GraphPanel } from './ui.jsx'

export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace']

export function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshAskGraph = 'true'
    style.textContent = `${flowStyles}\n${styles}`
    document.head.append(style)
    return () => style.remove()
  })

  // Render inside the conversation as a View tab ("提问图谱"), right beside
  // 对话 / 轨迹 / 上下文 / 看板, so the entry sits in the conversation toolbar
  // instead of the sidebar.
  //
  // The services are captured once, at apply time. Reading `ctx.workspaces`
  // (and friends) during render is not a stable identity: a fresh facade per
  // read made GraphPanel's capture effect re-run on every render, which
  // restarted CaptureManager, which set state, which rendered again — an
  // unbounded mount loop that also flooded the shared session store (the
  // sidebar's own Slot entry died on React's maximum update depth).
  const services = {
    sessions: ctx.sessions,
    workspaces: ctx.workspaces,
    uiWorkspace: ctx.uiWorkspace,
  }

  const GraphView = (props) => <GraphPanel {...props} {...services} />

  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'ask-graph',
        order: 25,
        label: () => '提问图谱',
      },
      GraphView,
    ),
  )
}
