import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Background,
  Handle,
  MiniMap,
  Panel as FlowPanel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
} from '@xyflow/react'
import {
  applySemanticGroups,
  formatDate,
  formatTime,
  ingestNodes,
  reclusterState,
  stripMarker,
  textOf,
  topicNodes,
  topicSpan,
  truncate,
} from './core.js'
import { dialogGraph, positionPatch, topicGraph } from './graph.js'
import { CaptureManager } from './capture.js'
import { bluepinDownloadName, buildBluepinVault, sanitizeSegment } from './bluepin.js'
import { buildHtmlReport, htmlDownloadName } from './html.js'
import { collectImageSources, resolveImages } from './images.js'
import { buildQuestionSvg, buildTopicSvg } from './svg.js'
import { downloadBlob, zipStore } from './zip.js'
import {
  buildSemanticPrompt,
  isSemanticPrompt,
  MAX_SEMANTIC_NODES,
  parseSemanticGroups,
} from './semantic.js'
import { createSaver, loadState } from './store.js'
import { buildAskPrompt, buildSummaryPrompt, isSummaryPrompt, localSummary, summarizeTopic } from './summary.js'

function useObservable(observable) {
  const [snapshot, setSnapshot] = useState(() => observable?.getSnapshot())
  useEffect(() => {
    if (!observable) return undefined
    setSnapshot(observable.getSnapshot())
    return observable.subscribe(() => setSnapshot(observable.getSnapshot()))
  }, [observable])
  return snapshot
}

const DRAWER_WIDTH_KEY = 'ask-graph:drawer-width'
const DRAWER_DEFAULT = 380
const DRAWER_MIN = 300
const DRAWER_MAX = 900

function readDrawerWidth() {
  try {
    const raw = Number(window.localStorage.getItem(DRAWER_WIDTH_KEY))
    if (!Number.isFinite(raw)) return DRAWER_DEFAULT
    return Math.min(window.innerWidth * 0.8, Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, raw)))
  } catch {
    return DRAWER_DEFAULT
  }
}

function selectedSessionId() {
  // DSH persists the sidebar selection under this key; the Sessions list has no  // `current` field, so reading the persisted selection is the reliable way to
  // know which workspace the user is actually browsing when this panel opens.
  try {
    const raw = window.localStorage.getItem('dsh.sessions.current')
    if (!raw) return undefined
    const saved = JSON.parse(raw)
    if (typeof saved === 'string') return saved
    if (typeof saved?.sessionId === 'string') return saved.sessionId
    if (typeof saved?.value?.sessionId === 'string') return saved.value.sessionId
    return undefined
  } catch {
    return undefined
  }
}

function resolveWorkspaceId(props, workspaces, sessions) {
  if (props.workspaceId) return props.workspaceId
  if (props.workspace?.workspaceId) return props.workspace.workspaceId
  const items = workspaces?.items ?? []
  const selected = props.sessionId || selectedSessionId()
  if (selected) {
    const owner = items.find((item) => item.sessionIds?.includes(selected))
    if (owner) return owner.workspaceId
    const summary = sessions?.byId?.[selected]
    if (summary?.cwd) {
      const match = items.find((item) => item.path === summary.cwd)
      if (match) return match.workspaceId
    }
  }
  const currentId = sessions?.current
  const current = currentId ? sessions.byId?.[currentId] : undefined
  if (current?.cwd) {
    const match = items.find((item) => item.path === current.cwd)
    if (match) return match.workspaceId
  }
  const recent = items.find((item) => item.workspaceId === workspaces?.recentWorkspaceId)
  return recent?.workspaceId ?? items[0]?.workspaceId
}

function Highlight({ text, query }) {
  const value = String(text ?? '')
  const needle = String(query ?? '').trim()
  if (!needle) return value
  const lower = value.toLowerCase()
  const target = needle.toLowerCase()
  const parts = []
  let cursor = 0
  let index = lower.indexOf(target)
  while (index !== -1) {
    if (index > cursor) parts.push(value.slice(cursor, index))
    parts.push(
      <mark key={`${index}-${parts.length}`} className="ag-hit">
        {value.slice(index, index + needle.length)}
      </mark>,
    )
    cursor = index + needle.length
    index = lower.indexOf(target, cursor)
  }
  if (cursor < value.length) parts.push(value.slice(cursor))
  return parts.length > 0 ? parts : value
}

const TopicNode = memo(function TopicNode({ data, selected }) {
  return (
    <div className={`ag-topic${selected ? ' is-selected' : ''}${data.dimmed ? ' is-dimmed' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="ag-topic-head">
        <span className="ag-topic-dot" />
        <span className="ag-topic-title">
          <Highlight text={data.title} query={data.query} />
        </span>
      </div>
      <div className="ag-topic-meta">
        {data.count} 个对话
        {data.span ? ` · ${formatDate(data.span.start)} → ${formatDate(data.span.end)}` : ''}
      </div>
      {data.summary ? (
        <div className="ag-topic-summary">
          <Highlight text={truncate(data.summary, 72)} query={data.query} />
        </div>
      ) : null}
      <div className="ag-topic-foot">点击进入子图</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
})

const DialogNode = memo(function DialogNode({ data, selected }) {
  const statusText = data.status === 'done' ? '已回复' : data.status === 'pending' ? '等待回复' : '无回复'
  return (
    <div
      className={`ag-dialog${selected ? ' is-selected' : ''}${data.dimmed ? ' is-dimmed' : ''}${
        data.status === 'pending' ? ' is-pending' : ''
      }`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="ag-dialog-head">
        <span className={`ag-status ag-status-${data.status}`}>{statusText}</span>
        <span className="ag-dialog-time">{formatTime(data.at)}</span>
      </div>
      <div className="ag-dialog-question">
        <Highlight text={data.question} query={data.query} />
      </div>
      <div className="ag-dialog-answer">
        {data.hasAnswer ? (
          <Highlight text={data.answerPreview} query={data.query} />
        ) : (
          'DSH 尚未回复，回复后自动更新。'
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
})

const nodeTypes = { topic: TopicNode, dialog: DialogNode }

const markdownComponents = {
  a({ children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  },
}

const Markdown = memo(function Markdown({ text }) {
  return (
    <div className="ag-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

function FitOnChange({ viewKey }) {
  const { fitView } = useReactFlow()
  useEffect(() => {
    const timer = setTimeout(() => fitView({ padding: 0.18, duration: 320 }), 60)
    return () => clearTimeout(timer)
  }, [viewKey, fitView])
  return null
}

function FocusOnQuery({ query, ids }) {
  const { fitView } = useReactFlow()
  const idsRef = useRef(ids)
  idsRef.current = ids
  useEffect(() => {
    const text = query.trim()
    if (!text) return undefined
    const timer = setTimeout(() => {
      const focus = idsRef.current
      if (!focus || focus.length === 0) return
      fitView({
        nodes: focus.map((id) => ({ id })),
        padding: 0.3,
        duration: 420,
        maxZoom: 1.15,
      })
    }, 120)
    return () => clearTimeout(timer)
  }, [query, fitView])
  return null
}

function FitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.2 7.2A5 5 0 1 1 4 11.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M2.6 3.4v3.4h3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CanvasControls({ onResetLayout }) {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow()
  const { zoom } = useViewport()
  const frame = () => fitView({ padding: 0.18, duration: 300 })
  return (
    <div className="ag-canvas-controls" role="toolbar" aria-label="画布控制">
      <button type="button" title="放大" aria-label="放大" onClick={() => zoomIn({ duration: 160 })}>
        +
      </button>
      <button type="button" title="缩小" aria-label="缩小" onClick={() => zoomOut({ duration: 160 })}>
        −
      </button>
      <button
        type="button"
        className="ag-zoom"
        title="当前缩放比，点击恢复 100%"
        aria-label={`当前缩放 ${Math.round(zoom * 100)}%`}
        onClick={() => zoomTo(1, { duration: 200 })}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" title="适应窗口" aria-label="适应窗口" onClick={frame}>
        <FitIcon />
      </button>
      <button
        type="button"
        title="重置布局"
        aria-label="重置布局"
        onClick={() => {
          onResetLayout?.()
          setTimeout(frame, 80)
        }}
      >
        <ResetIcon />
      </button>
    </div>
  )
}

/**
 * Explicit pane panning. React Flow normally pans on pane drag, but the DSH
 * host can swallow that gesture; handling the pointer here keeps the blank
 * canvas draggable regardless of host event defaults.
 */
function PanePanHandler({ surfaceRef }) {
  const { getViewport, setViewport } = useReactFlow()
  useEffect(() => {
    const surface = surfaceRef?.current
    if (!surface) return undefined
    let drag = null
    const down = (event) => {
      if (event.button !== 0 || !surface.isConnected) return
      const rect = surface.getBoundingClientRect()
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        return
      }
      if (
        event.target.closest?.(
          '.react-flow__node, .react-flow__edge, .react-flow__panel, .react-flow__minimap, .react-flow__controls, .ag-modal-mask, .ag-toast',
        )
      ) {
        return
      }
      drag = { x: event.clientX, y: event.clientY, viewport: getViewport() }
      event.preventDefault()
    }
    const move = (event) => {
      if (!drag) return
      event.preventDefault()
      setViewport({
        ...drag.viewport,
        x: drag.viewport.x + event.clientX - drag.x,
        y: drag.viewport.y + event.clientY - drag.y,
      })
    }
    const up = () => {
      drag = null
    }
    // Capture phase on window: the host/React Flow may stop propagation on the
    // pane, so a listener on the canvas itself never sees the pointerdown.
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
    }
  }, [surfaceRef, getViewport, setViewport])
  return null
}

function SummaryDialog({ title, text, busy, onChange, onClose, onSave }) {
  return (
    <div className="ag-modal-mask" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="ag-modal" role="dialog" aria-label="专题总结">
        <div className="ag-modal-head">
          <strong>专题总结 · {title}</strong>
          <span className="ag-modal-hint">{busy ? 'DSH 正在生成…' : '可编辑后保存'}</span>
        </div>
        <textarea className="ag-modal-text" value={text} onChange={(event) => onChange(event.target.value)} />
        <div className="ag-modal-foot">
          <button type="button" className="ag-btn" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="ag-btn ag-btn-primary" onClick={onSave} disabled={busy || !text.trim()}>
            保存到专题
          </button>
        </div>
      </div>
    </div>
  )
}

function SemanticDialog({ preview, onClose, onApply }) {
  const { groups, missing, beforeCount, afterCount, nodeCount } = preview
  return (
    <div className="ag-modal-mask" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="ag-modal ag-semantic-modal" role="dialog" aria-label="智能整理预览">
        <div className="ag-modal-head">
          <strong>智能整理预览</strong>
          <span className="ag-modal-hint">DSH 已按功能语义分组</span>
        </div>
        <div className="ag-semantic-body">
          <p>
            覆盖 {nodeCount - missing.length} / {nodeCount} 个自动节点 · 专题数量 {beforeCount} → {afterCount}
          </p>
          {missing.length > 0 ? (
            <p className="ag-modal-note">有 {missing.length} 个节点未被模型覆盖，将放入「待归类」。</p>
          ) : null}
          <ul className="ag-semantic-list">
            {groups.map((group, index) => (
              <li key={`${group.title}-${index}`}>
                <div className="ag-semantic-title">
                  <strong>{group.title}</strong>
                  <span>{group.nodeIds.length} 个问题</span>
                </div>
                {group.summary ? <p>{truncate(group.summary, 140)}</p> : null}
              </li>
            ))}
          </ul>
          <p className="ag-modal-note">手工移动过的节点保持不变；应用后可点「撤销整理」恢复。</p>
        </div>
        <div className="ag-modal-foot">
          <button type="button" className="ag-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ag-btn ag-btn-primary" onClick={onApply}>
            应用语义分组
          </button>
        </div>
      </div>
    </div>
  )
}

function ReclusterDialog({ diff, onClose, onApply }) {
  return (
    <div className="ag-modal-mask" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="ag-modal" role="dialog" aria-label="整理专题">
        <div className="ag-modal-head">
          <strong>按内容重新整理专题</strong>
          <span className="ag-modal-hint">先预览，确认后应用</span>
        </div>
        <div className="ag-recluster-body">
          <p>按问题与回复的相似度重新归类；同一功能隔几天、几周再问，仍会回到原专题。</p>
          <ul>
            <li>
              专题数量：{diff.beforeCount} → {diff.afterCount}
            </li>
            <li>移动的对话节点：{diff.moved}</li>
            <li>
              新增专题 {diff.added} 个，合并/移除 {diff.removed} 个
            </li>
          </ul>
          <p className="ag-modal-note">手工移动过的节点会保持原专题，不会被自动整理改变。整理后可点「撤销整理」恢复。</p>
        </div>
        <div className="ag-modal-foot">
          <button type="button" className="ag-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ag-btn ag-btn-primary" onClick={onApply}>
            确认整理
          </button>
        </div>
      </div>
    </div>
  )
}

export let revealGeneration = 0

function normalizeMatchText(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）【】《》]/g, '')
}

function findQuestionElement(question) {
  const target = normalizeMatchText(question).slice(0, 24)
  if (!target) return null
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || parent.closest('.ag-root')) return NodeFilter.FILTER_REJECT
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_SKIP
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let best
  let textNode
  while ((textNode = walker.nextNode())) {
    const parent = textNode.parentElement
    if (!parent) continue
    const own = normalizeMatchText(textNode.nodeValue)
    const text = normalizeMatchText(parent.textContent)
    if (!own.includes(target) && !text.includes(target)) continue
    if (!best || text.length < best.length) best = { element: parent, length: text.length }
  }
  return best?.element ?? null
}

/** After opening the original session, scroll its question into view and flash it. */
function revealQuestion(question) {
  const generation = ++revealGeneration
  let attempts = 0
  const tick = () => {
    if (generation !== revealGeneration) return
    if (attempts++ > 30) return
    const element = findQuestionElement(question)
    if (!element) {
      window.setTimeout(tick, 300)
      return
    }
    const previous = {
      outline: element.style.outline,
      outlineOffset: element.style.outlineOffset,
      borderRadius: element.style.borderRadius,
      transition: element.style.transition,
    }
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element.style.transition = 'outline-color 160ms ease'
    element.style.outline = '2px solid #3b82f6'
    element.style.outlineOffset = '4px'
    element.style.borderRadius = '10px'
    window.setTimeout(() => {
      element.style.outline = previous.outline
      element.style.outlineOffset = previous.outlineOffset
      element.style.borderRadius = previous.borderRadius
      element.style.transition = previous.transition
    }, 2600)
  }
  // The conversation mounts after the panel unmounts; wait one paint cycle.
  window.setTimeout(tick, 400)
}

export function GraphPanel(props) {
  const { sessions, workspaces, uiWorkspace, openView } = props
  const workspaceState = useObservable(workspaces?.list)
  const sessionState = useObservable(sessions?.list)
  const workspaceId = resolveWorkspaceId(props, workspaceState, sessionState)
  const scopeKey = workspaceId ?? 'global'

  const [db, setDb] = useState(() => loadState(scopeKey))
  const [viewTopicId, setViewTopicId] = useState(null)
  const [selectedNodeId, setSelectedNodeId] = useState(null)
  const [query, setQuery] = useState('')
  const [dragPositions, setDragPositions] = useState({})
  const [status, setStatus] = useState({ phase: 'idle', message: '' })
  const [toast, setToast] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [summaryText, setSummaryText] = useState('')
  const [summaryBusy, setSummaryBusy] = useState(false)
  const [reclusterOpen, setReclusterOpen] = useState(false)
  const [undoDb, setUndoDb] = useState(null)
  const [semanticOpen, setSemanticOpen] = useState(false)
  const [semanticBusy, setSemanticBusy] = useState(false)
  const [semanticPreview, setSemanticPreview] = useState(null)
  const [drawerWidth, setDrawerWidth] = useState(readDrawerWidth)
  const [drawerVisible, setDrawerVisible] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const [downloadOpen, setDownloadOpen] = useState(false)

  const dbRef = useRef(db)
  dbRef.current = db
  const canvasRef = useRef(null)
  const downloadRef = useRef(null)
  const sessionStateRef = useRef(sessionState)
  sessionStateRef.current = sessionState
  const pendingRef = useRef(null)
  const summarySessionRef = useRef(undefined)
  const semanticSessionRef = useRef(undefined)
  const saverRef = useRef(createSaver(scopeKey))
  const servicesRef = useRef({ sessions, workspaces })
  servicesRef.current = { sessions, workspaces }

  useEffect(() => {
    setDb(loadState(scopeKey))
    setViewTopicId(null)
    setSelectedNodeId(null)
    setQuery('')
    setDragPositions({})
    pendingRef.current = null
    saverRef.current = createSaver(scopeKey)
  }, [scopeKey])

  useEffect(() => {
    saverRef.current?.(db)
  }, [db])

  useEffect(() => () => saverRef.current?.flush(), [])

  useEffect(() => {
    // The services come from refs, and this effect depends only on the scope:
    // prop identity is not stable across renders, so depending on it restarted
    // CaptureManager on every render (an unbounded mount loop).
    const { sessions: sessionService, workspaces: workspaceService } = servicesRef.current
    if (!sessionService || !workspaceService) return undefined
    const manager = new CaptureManager({
      sessions: sessionService,
      workspaces: workspaceService,
      workspaceId,
      onStatus: (next) =>
        setStatus((previous) =>
          previous.phase === next.phase && previous.message === next.message ? previous : next,
        ),
      onNodes: (sessionId, nodes) => {
        const pending = pendingRef.current
        const currentId = sessionStateRef.current?.current
        const fresh = pending && currentId === sessionId && Date.now() - pending.at < 10 * 60_000
        setDb((previous) => {
          const withPending = fresh
            ? { ...previous, pendingTopics: { ...previous.pendingTopics, [sessionId]: pending.topicId } }
            : previous
          return ingestNodes(withPending, nodes)
        })
        if (fresh) pendingRef.current = null
      },
    })
    manager.start()
    return () => {
      manager.stop()
    }
  }, [workspaceId, refreshToken])

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(''), 4200)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!downloadOpen) return undefined
    const close = (event) => {
      if (!downloadRef.current?.contains(event.target)) setDownloadOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setDownloadOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [downloadOpen])

  const viewTopic = viewTopicId ? db.topics.find((topic) => topic.id === viewTopicId) : undefined
  const selectedNode = selectedNodeId ? db.nodes.find((node) => node.id === selectedNodeId) : undefined

  const graph = useMemo(
    () => (viewTopicId ? dialogGraph(db, viewTopicId, db.positions?.[viewTopicId] ?? {}) : topicGraph(db, db.topicPositions ?? {})),
    [db, viewTopicId],
  )

  const matched = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return undefined
    const ids = new Set()
    for (const node of db.nodes) {
      if (`${node.question} ${node.answer}`.toLowerCase().includes(text)) ids.add(node.id)
    }
    return ids
  }, [db.nodes, query])

  const flowNodes = useMemo(() => {
    const text = query.trim().toLowerCase()
    return graph.nodes.map((node) => {
      let dimmed = false
      if (text) {
        if (viewTopicId) {
          dimmed = !matched?.has(node.id)
        } else {
          const topic = db.topics.find((item) => item.id === node.id)
          const nodes = topic ? topicNodes(db, topic.id) : []
          dimmed = !((topic?.title ?? '').toLowerCase().includes(text) || nodes.some((item) => `${item.question} ${item.answer}`.toLowerCase().includes(text)))
        }
      }
      return {
        ...node,
        position: dragPositions[node.id] ?? node.position,
        data: { ...node.data, dimmed, query: text },
      }
    })
  }, [graph.nodes, dragPositions, matched, query, viewTopicId, db])

  const focusIds = useMemo(
    () => flowNodes.filter((node) => !node.data.dimmed).map((node) => node.id),
    [flowNodes],
  )

  const reclusterPreview = useMemo(() => (reclusterOpen ? reclusterState(db) : null), [reclusterOpen, db])
  const reclusterDiff = useMemo(() => {
    if (!reclusterPreview) return null
    const before = new Map(db.nodes.map((node) => [node.id, node.topicId]))
    let moved = 0
    for (const node of reclusterPreview.nodes) if (before.get(node.id) !== node.topicId) moved += 1
    const nextIds = new Set(reclusterPreview.topics.map((topic) => topic.id))
    const oldIds = new Set(db.topics.map((topic) => topic.id))
    return {
      moved,
      added: [...nextIds].filter((id) => !oldIds.has(id)).length,
      removed: [...oldIds].filter((id) => !nextIds.has(id)).length,
      beforeCount: db.topics.length,
      afterCount: reclusterPreview.topics.length,
    }
  }, [reclusterPreview, db])

  const handleNodesChange = useCallback((changes) => {
    const moves = changes.filter((change) => change.type === 'position' && change.position)
    if (moves.length === 0) return
    setDragPositions((previous) => {
      const next = { ...previous }
      for (const change of moves) next[change.id] = change.position
      return next
    })
  }, [])

  const handleNodeDragStop = useCallback(
    (_event, node) => {
      setDb((previous) =>
        viewTopicId
          ? {
              ...previous,
              positions: {
                ...previous.positions,
                [viewTopicId]: positionPatch(previous.positions?.[viewTopicId] ?? {}, node.id, node.position),
              },
            }
          : { ...previous, topicPositions: positionPatch(previous.topicPositions ?? {}, node.id, node.position) },
      )
      setDragPositions((previous) => {
        const next = { ...previous }
        delete next[node.id]
        return next
      })
    },
    [viewTopicId],
  )

  const handleNodeClick = useCallback(
    (_event, node) => {
      if (viewTopicId) {
        setSelectedNodeId(node.id)
        setDrawerVisible(true)
      } else {
        setViewTopicId(node.id)
        setSelectedNodeId(null)
        setQuery('')
      }
    },
    [viewTopicId],
  )

  const handleAsk = useCallback(() => {
    if (!viewTopic) return
    if (!workspaceId) {
      setToast('请先打开一个工作区，再在该专题下提问。')
      return
    }
    pendingRef.current = { topicId: viewTopic.id, at: Date.now() }
    try {
      uiWorkspace.startSession(workspaceId, { prompt: buildAskPrompt(viewTopic) })
      setToast('已打开新会话，发送问题后会自动归入本专题。')
    } catch (error) {
      pendingRef.current = null
      setToast(`打开会话失败：${error?.message ?? error}`)
    }
  }, [viewTopic, workspaceId, uiWorkspace])

  const handleSummarize = useCallback(async () => {
    if (!viewTopic) return
    const target = summarizeTopic(db, viewTopic.id)
    if (!target) {
      setToast('该专题还没有对话节点，暂时无法总结。')
      return
    }
    setSummaryOpen(true)
    setSummaryBusy(true)
    setSummaryText(target.local)
    summarySessionRef.current = undefined
    try {
      if (!workspaceId) throw new Error('当前环境不支持自动总结')
      const sessionId = await createSummarySession(sessions, uiWorkspace, workspaceId)
      if (!sessionId) throw new Error('未能创建总结会话')
      summarySessionRef.current = sessionId
      const reference = sessions.retain(sessionId, { source: 'ask-graph' })
      try {
        await reference.ready
        const source = reference.binding?.eventSource
        const session = reference.binding?.session
        if (!source || !session) throw new Error('总结会话不可用')
        const prompt = buildSummaryPrompt(target.topic, target.nodes)
        const result = await session.prompt([{ type: 'text', text: prompt }], 'queue')
        if (result && result.ok === false) throw new Error(result.error?.message ?? 'DSH 拒绝了总结请求')
        const text = await waitForSummary(source, target.topic.id, 120_000)
        if (!text) throw new Error('等待总结超时')
        setSummaryText(text)
        setDb((previous) => ({
          ...previous,
          topics: previous.topics.map((topic) =>
            topic.id === target.topic.id
              ? { ...topic, summary: text, summaryAt: Date.now(), summarySource: 'ai' }
              : topic,
          ),
        }))
        setToast('AI 总结已完成并保存。')
      } finally {
        try {
          reference.release()
        } catch {
          // already released
        }
      }
    } catch (error) {
      setToast(`AI 总结失败，已保留本地摘要：${error?.message ?? error}`)
    } finally {
      const sessionId = summarySessionRef.current
      if (sessionId) {
        try {
          await uiWorkspace.archiveSession(sessionId, { stopActivity: true })
        } catch {
          // Leaving the session visible is harmless.
        }
      }
      setSummaryBusy(false)
    }
  }, [db, viewTopic, workspaceId, uiWorkspace, sessions])

  const handleSaveSummary = useCallback(() => {
    const text = summaryText.trim()
    if (!viewTopic || !text) return
    setDb((previous) => ({
      ...previous,
      topics: previous.topics.map((topic) =>
        topic.id === viewTopic.id ? { ...topic, summary: text, summaryAt: Date.now(), summarySource: 'local' } : topic,
      ),
    }))
    setSummaryOpen(false)
    setToast('专题总结已保存。')
  }, [summaryText, viewTopic])

  const handleResetLayout = useCallback(() => {
    setDb((previous) =>
      viewTopicId
        ? { ...previous, positions: { ...previous.positions, [viewTopicId]: {} } }
        : { ...previous, topicPositions: {} },
    )
    setDragPositions({})
    setToast('已恢复自动布局。')
  }, [viewTopicId])

  const handleRecluster = useCallback(() => {
    if ((db.nodes ?? []).length === 0) {
      setToast('还没有对话节点，暂时无法整理。')
      return
    }
    setReclusterOpen(true)
  }, [db.nodes])

  const handleApplyRecluster = useCallback(() => {
    if (!reclusterPreview) return
    // Recompute from the latest snapshot so nodes captured while the dialog was
    // open are not dropped when the preview is applied.
    const next = reclusterState(db)
    setUndoDb(db)
    setDb(next)
    setReclusterOpen(false)
    setViewTopicId(null)
    setSelectedNodeId(null)
    setDragPositions({})
    setToast('已按内容重新整理专题；可点「撤销整理」恢复。')
  }, [db, reclusterPreview])

  const handleUndoRecluster = useCallback(() => {
    if (!undoDb) return
    setDb(undoDb)
    setUndoDb(null)
    setViewTopicId(null)
    setSelectedNodeId(null)
    setDragPositions({})
    setToast('已撤销整理。')
  }, [undoDb])

  const handleSemanticOrganize = useCallback(async () => {
    const current = dbRef.current
    const autoNodes = (current.nodes ?? []).filter((node) => node.assignment !== 'manual')
    if (!workspaceId) {
      setToast('请先打开一个工作区，再使用智能整理。')
      return
    }
    if (autoNodes.length < 2) {
      setToast('自动归类的对话节点不足 2 个，暂不需要智能整理。')
      return
    }
    if (autoNodes.length > MAX_SEMANTIC_NODES) {
      setToast(`节点较多（${autoNodes.length} 个），请先用“快速整理”或分批处理。`)
      return
    }
    setSemanticBusy(true)
    setToast('正在让 DSH 阅读上下文并整理专题，约需 30–120 秒…')
    let sessionId
    try {
      sessionId = await createSummarySession(sessions, uiWorkspace, workspaceId)
      if (!sessionId) throw new Error('未能创建整理会话')
      semanticSessionRef.current = sessionId
      const reference = sessions.retain(sessionId, { source: 'ask-graph' })
      try {
        await reference.ready
        const source = reference.binding?.eventSource
        const session = reference.binding?.session
        if (!source || !session) throw new Error('整理会话不可用')
        const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
        const prompt = buildSemanticPrompt(autoNodes, current.topics, token)
        const result = await session.prompt([{ type: 'text', text: prompt }], 'queue')
        if (result && result.ok === false) throw new Error(result.error?.message ?? 'DSH 拒绝了整理请求')
        const reply = await waitForReply(source, (text) => isSemanticPrompt(text, token), 180_000)
        if (!reply) throw new Error('等待模型返回超时')
        const { groups, missing } = parseSemanticGroups(reply, new Set(autoNodes.map((node) => node.id)))
        const next = applySemanticGroups(dbRef.current, groups)
        setSemanticPreview({
          groups,
          missing,
          beforeCount: current.topics.length,
          afterCount: next.topics.length,
          nodeCount: autoNodes.length,
        })
        setSemanticOpen(true)
      } finally {
        try {
          reference.release()
        } catch {
          // already released
        }
      }
    } catch (error) {
      setToast(`智能整理失败：${error?.message ?? error}。可先用“快速整理”。`)
    } finally {
      if (sessionId) {
        try {
          await uiWorkspace.archiveSession(sessionId, { stopActivity: true })
        } catch {
          // Leaving the helper session visible is harmless.
        }
      }
      semanticSessionRef.current = undefined
      setSemanticBusy(false)
    }
  }, [workspaceId, sessions, uiWorkspace])

  const handleApplySemantic = useCallback(() => {
    if (!semanticPreview) return
    const next = applySemanticGroups(dbRef.current, semanticPreview.groups)
    setUndoDb(dbRef.current)
    setDb(next)
    setSemanticOpen(false)
    setSemanticPreview(null)
    setViewTopicId(null)
    setSelectedNodeId(null)
    setDragPositions({})
    setToast('已按语义整理专题；可点「撤销整理」恢复。')
  }, [semanticPreview])

  const handleDownloadBluepin = useCallback(async () => {
    const current = dbRef.current
    setDownloadOpen(false)
    if (!current.nodes?.length) {
      setToast('还没有对话节点，暂时无法导出。')
      return
    }
    setExportBusy(true)
    setExportProgress('正在收集图片…')
    try {
      const workspace = (workspaceState?.items ?? []).find((item) => item.workspaceId === workspaceId)
      const pathName = String(workspace?.path ?? '').split(/[\\/]/).filter(Boolean).pop()
      const workspaceTitle = workspace?.title || pathName || '工作区'
      const sources = collectImageSources(current)
      const resolved = await resolveImages(sources, {
        sessions,
        onProgress: (done, total) => setExportProgress(total ? `下载图片 ${done}/${total}` : '正在生成…'),
      })
      const imageBytes = resolved.assets.reduce((sum, asset) => sum + asset.bytes.length, 0)
      if (imageBytes > 250 * 1024 * 1024) throw new Error('图片总量超过 250MB，已取消导出')
      setExportProgress('正在生成 Bluepin 仓…')
      await new Promise((resolve) => setTimeout(resolve, 0))
      const vault = buildBluepinVault(current, { workspaceTitle, assets: resolved })
      const bytes = zipStore(vault.files, vault.dirs)
      downloadBlob(new Blob([bytes], { type: 'application/zip' }), bluepinDownloadName(vault.rootName))
      const skipped = vault.warnings.length
      setToast(
        `已下载 ${vault.stats.topics} 个专题 / ${vault.stats.questions} 个问题 / ${vault.stats.images} 张图片 / ${vault.stats.svgs} 张图${skipped ? `；${skipped} 张图片未导出` : ''}。`,
      )
    } catch (error) {
      setToast(`导出失败：${error?.message ?? error}`)
    } finally {
      setExportBusy(false)
      setExportProgress('')
    }
  }, [sessions, workspaceId, workspaceState])

  const handleDownloadSvg = useCallback(async () => {
    const current = dbRef.current
    setDownloadOpen(false)
    if (!current.nodes?.length) {
      setToast('还没有对话节点，暂时无法导出。')
      return
    }
    setExportBusy(true)
    setExportProgress('正在生成专题与问题 SVG…')
    try {
      const workspace = (workspaceState?.items ?? []).find((item) => item.workspaceId === workspaceId)
      const pathName = String(workspace?.path ?? '').split(/[\\/]/).filter(Boolean).pop()
      const workspaceTitle = workspace?.title || pathName || '工作区'
      const used = new Set(['专题图'])
      const files = [
        { path: '专题图.svg', text: buildTopicSvg(current, { title: `${workspaceTitle} · 专题图` }) },
      ]
      for (const topic of current.topics ?? []) {
        if (topicNodes(current, topic.id).length === 0) continue
        const base = `问题图-${sanitizeSegment(topic.title, '专题')}`
        let name = base
        let index = 2
        while (used.has(name)) {
          name = `${base}-${index}`
          index += 1
        }
        used.add(name)
        const svg = buildQuestionSvg(current, topic.id, { title: `${topic.title} · 问题图` })
        if (svg) files.push({ path: `${name}.svg`, text: svg })
      }
      const bytes = zipStore(files)
      downloadBlob(
        new Blob([bytes], { type: 'application/zip' }),
        bluepinDownloadName(`提问图谱-SVG-${workspaceTitle}`),
      )
      setToast(`已下载 ${files.length} 张 SVG（专题图 + 每个专题的问题图）。`)
    } catch (error) {
      setToast(`SVG 导出失败：${error?.message ?? error}`)
    } finally {
      setExportBusy(false)
      setExportProgress('')
    }
  }, [workspaceId, workspaceState])

  const handleDownloadHtml = useCallback(async () => {
    const current = dbRef.current
    setDownloadOpen(false)
    if (!current.nodes?.length) {
      setToast('还没有对话节点，暂时无法导出。')
      return
    }
    setExportBusy(true)
    setExportProgress('正在收集图片…')
    try {
      const workspace = (workspaceState?.items ?? []).find((item) => item.workspaceId === workspaceId)
      const pathName = String(workspace?.path ?? '').split(/[\\/]/).filter(Boolean).pop()
      const workspaceTitle = workspace?.title || pathName || '工作区'
      const sources = collectImageSources(current)
      const resolved = await resolveImages(sources, {
        sessions,
        onProgress: (done, total) => setExportProgress(total ? `下载图片 ${done}/${total}` : '正在生成…'),
      })
      const imageBytes = resolved.assets.reduce((sum, asset) => sum + asset.bytes.length, 0)
      if (imageBytes > 250 * 1024 * 1024) throw new Error('图片总量超过 250MB，已取消导出')
      setExportProgress('正在生成 HTML…')
      await new Promise((resolve) => setTimeout(resolve, 0))
      const html = buildHtmlReport(current, { workspaceTitle, assets: resolved })
      downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), htmlDownloadName(workspaceTitle))
      const topics = (current.topics ?? []).filter((topic) => topicNodes(current, topic.id).length > 0).length
      setToast(`已下载 HTML：${topics} 个专题 / ${current.nodes.length} 个问题。`)
    } catch (error) {
      setToast(`HTML 导出失败：${error?.message ?? error}`)
    } finally {
      setExportBusy(false)
      setExportProgress('')
    }
  }, [sessions, workspaceId, workspaceState])

  useEffect(() => {
    if (viewTopicId && !db.topics.some((topic) => topic.id === viewTopicId)) {
      setViewTopicId(null)
      setSelectedNodeId(null)
    }
  }, [db.topics, viewTopicId])

  useEffect(() => {
    try {
      window.localStorage.setItem(DRAWER_WIDTH_KEY, String(Math.round(drawerWidth)))
    } catch {
      // localStorage may be unavailable; the width still works for this session.
    }
  }, [drawerWidth])

  const handleDrawerResizeStart = useCallback(
    (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startWidth = drawerWidth
      const maxWidth = Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, window.innerWidth - 160))
      const onMove = (moveEvent) => {
        const next = Math.max(DRAWER_MIN, Math.min(maxWidth, startWidth - (moveEvent.clientX - startX)))
        setDrawerWidth(next)
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [drawerWidth],
  )

  const totalNodes = db.nodes.length
  const viewKey = viewTopicId ?? 'root'

  return (
    <div className="ag-root">
      <div className="ag-toolbar">
        <div className="ag-toolbar-left">
          {viewTopicId ? (
            <button type="button" className="ag-btn ag-back" onClick={() => setViewTopicId(null)}>
              ← 全部专题
            </button>
          ) : (
            <span className="ag-logo">◈</span>
          )}
          {openView ? (
            <button type="button" className="ag-btn ag-back" onClick={() => openView('chat', '')}>
              返回会话
            </button>
          ) : null}
          <div className="ag-titles">
            <select
              className="ag-title-switch"
              value={viewTopicId ?? ''}
              onChange={(event) => {
                setViewTopicId(event.target.value || null)
                setSelectedNodeId(null)
                setQuery('')
              }}
              title="切换专题，选中即进入"
              aria-label="切换专题"
            >
              <option value="">提问图谱 · 全部专题</option>
              {db.topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.title}
                </option>
              ))}
            </select>
            <div className="ag-subtitle">
              {viewTopic ? `${topicNodes(db, viewTopic.id).length} 个对话节点 · 按时间串联` : `${db.topics.length} 个专题 · ${totalNodes} 个对话节点`}
            </div>
          </div>
        </div>
        <div className="ag-toolbar-right">
          <input
            className="ag-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={viewTopicId ? '筛选节点…' : '筛选专题…'}
          />
          {viewTopicId ? (
            <>
              <button type="button" className="ag-btn" onClick={handleAsk}>
                + 在该专题提问
              </button>
              <button type="button" className="ag-btn ag-btn-primary" onClick={handleSummarize} disabled={summaryBusy}>
                {summaryBusy ? '总结中…' : '总结专题'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ag-btn ag-btn-primary"
                onClick={handleSemanticOrganize}
                disabled={semanticBusy}
                title="调用 DSH 阅读问题与回复的上下文，按功能语义重新分组"
              >
                {semanticBusy ? '语义整理中…' : '智能整理'}
              </button>
              <button type="button" className="ag-btn" onClick={handleRecluster} title="只按字面相似度快速整理，不调用模型">
                快速整理
              </button>
              {undoDb ? (
                <button type="button" className="ag-btn" onClick={handleUndoRecluster}>
                  撤销整理
                </button>
              ) : null}
              <div className="ag-download" ref={downloadRef}>
                <button
                  type="button"
                  className="ag-btn"
                  onClick={() => setDownloadOpen((value) => !value)}
                  disabled={exportBusy}
                  aria-haspopup="menu"
                  aria-expanded={downloadOpen}
                  title="下载专题/问题图与内容"
                >
                  {exportBusy ? exportProgress || '导出中…' : '下载'} <span className="ag-caret">▾</span>
                </button>
                {downloadOpen ? (
                  <div className="ag-download-menu" role="menu">
                    <button type="button" role="menuitem" onClick={handleDownloadSvg}>
                      <strong>下载 SVG</strong>
                      <span>专题图 + 每个专题的问题图</span>
                    </button>
                    <button type="button" role="menuitem" onClick={handleDownloadHtml}>
                      <strong>下载 HTML</strong>
                      <span>大纲 + 有向图 + 完整内容 + 内部链接</span>
                    </button>
                    <button type="button" role="menuitem" onClick={handleDownloadBluepin}>
                      <strong>下载 Bluepin Vault</strong>
                      <span>标准 vault + 专题/问题 SVG + 图片</span>
                    </button>
                  </div>
                ) : null}
              </div>
              <button type="button" className="ag-btn" onClick={() => setRefreshToken((value) => value + 1)}>
                重新读取
              </button>
            </>
          )}
          <button
            type="button"
            className={`ag-panel-toggle${drawerVisible ? ' is-on' : ''}`}
            aria-pressed={drawerVisible}
            onClick={() => setDrawerVisible((value) => !value)}
            title={drawerVisible ? '隐藏右侧详情面板' : '显示右侧详情面板'}
            aria-label={drawerVisible ? '隐藏右侧详情面板' : '显示右侧详情面板'}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <line x1="10" y1="3" x2="10" y2="13" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </div>

      <div className="ag-body">
        <div className="ag-canvas" ref={canvasRef}>
          <ReactFlowProvider>
            <ReactFlow
              nodes={flowNodes}
              edges={graph.edges}
              nodeTypes={nodeTypes}
              onNodesChange={handleNodesChange}
              onNodeDragStop={handleNodeDragStop}
              onNodeClick={handleNodeClick}
              onPaneClick={() => setSelectedNodeId(null)}
              fitView
              panOnDrag={false}
              selectionOnDrag={false}
              minZoom={0.15}
              maxZoom={1.8}
              nodesConnectable={false}
              elementsSelectable
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={18} size={1} color="var(--ag-grid, #dfe5ef)" />
              <PanePanHandler surfaceRef={canvasRef} />
              <MiniMap pannable zoomable nodeColor={(node) => (node.type === 'topic' ? '#2563eb' : '#94a3b8')} />
              <FlowPanel position="bottom-left">
                <div className="ag-canvas-tools">
                  <CanvasControls onResetLayout={handleResetLayout} />
                  <div className="ag-legend">
                    <span>
                      <i className="ag-dot ag-dot-serial" />
                      串行
                    </span>
                    <span>
                      <i className="ag-dot ag-dot-parallel" />
                      并行
                    </span>
                    <span>拖动空白处移动画布，拖动节点可调整布局，滚轮缩放</span>
                  </div>
                </div>
              </FlowPanel>
              <FitOnChange viewKey={viewKey} />
              <FocusOnQuery query={query} ids={focusIds} />
            </ReactFlow>
          </ReactFlowProvider>

          {db.topics.length === 0 && status.phase !== 'reading' ? (
            <div className="ag-empty">
              <div className="ag-empty-title">还没有可展示的对话</div>
              <div className="ag-empty-text">
                在 DSH 中向本工作区的任意会话提问，问题会自动归类成专题并出现在这里。
                <br />
                也可以进入专题后点「在该专题提问」。
              </div>
            </div>
          ) : null}

          {status.phase === 'reading' ? <div className="ag-reading">{status.message || '正在读取会话历史…'}</div> : null}
        </div>

        {drawerVisible ? (
          <aside className="ag-drawer" style={{ width: drawerWidth }}>
            <div
              className="ag-drawer-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="拖动调整详情栏宽度"
              title="拖动调整宽度，双击恢复默认"
              onPointerDown={handleDrawerResizeStart}
              onDoubleClick={() => setDrawerWidth(DRAWER_DEFAULT)}
            />
            {!selectedNode ? (
              <div className="ag-drawer-placeholder">
                <div className="ag-drawer-label">问答详情</div>
                <p>点击左侧对话节点，查看问题与 DSH 回复。</p>
              </div>
            ) : (
              <>
            <div className="ag-drawer-head">
              <div>
                <div className="ag-drawer-label">问答详情</div>
                <div className="ag-drawer-time">{formatTime(selectedNode.at)}</div>
              </div>
              <button
                type="button"
                className="ag-icon-btn"
                onClick={() => {
                  setSelectedNodeId(null)
                  setDrawerVisible(false)
                }}
                aria-label="关闭右侧面板"
              >
                ×
              </button>
            </div>
            <div className="ag-drawer-section">
              <div className="ag-drawer-label">问题</div>
              <div className="ag-drawer-question">
                <Markdown text={stripMarker(selectedNode.question)} />
              </div>
            </div>
            <div className="ag-drawer-section ag-drawer-answer-wrap">
              <div className="ag-drawer-label">DSH 回复</div>
              <div className="ag-drawer-answer">
                {selectedNode.answer ? (
                  <Markdown text={selectedNode.answer} />
                ) : (
                  'DSH 尚未回复，回复后这里会自动更新。'
                )}
              </div>
            </div>
            <div className="ag-drawer-foot">
              <button
                type="button"
                className="ag-btn"
                onClick={() => {
                  try {
                    uiWorkspace?.openSession(selectedNode.sessionId)
                    revealQuestion(selectedNode.question)
                  } catch (error) {
                    setToast(`打开会话失败：${error?.message ?? error}`)
                  }
                }}
              >
                打开原会话
              </button>
            </div>
              </>
            )}
          </aside>
        ) : null}
      </div>

      {toast ? <div className="ag-toast">{toast}</div> : null}

      {reclusterOpen && reclusterDiff ? (
        <ReclusterDialog diff={reclusterDiff} onClose={() => setReclusterOpen(false)} onApply={handleApplyRecluster} />
      ) : null}

      {semanticOpen && semanticPreview ? (
        <SemanticDialog
          preview={semanticPreview}
          onClose={() => {
            setSemanticOpen(false)
            setSemanticPreview(null)
          }}
          onApply={handleApplySemantic}
        />
      ) : null}

      {summaryOpen && viewTopic ? (
        <SummaryDialog
          title={viewTopic.title}
          text={summaryText}
          busy={summaryBusy}
          onChange={setSummaryText}
          onClose={() => setSummaryOpen(false)}
          onSave={handleSaveSummary}
        />
      ) : null}
    </div>
  )
}

async function createSummarySession(sessions, uiWorkspace, workspaceId) {
  if (typeof sessions?.create === 'function') {
    try {
      const created = await sessions.create({ workspaceId })
      const id = typeof created === 'string' ? created : created?.value?.sessionId ?? created?.sessionId
      if (typeof id === 'string' && id) return id
    } catch {
      // fall through to the navigation helper
    }
  }
  if (uiWorkspace?.connectWorkspace) {
    const id = await uiWorkspace.connectWorkspace(workspaceId)
    if (typeof id === 'string' && id) return id
  }
  return undefined
}

function waitForReply(source, isPrompt, timeout) {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe
    let timer
    let settleTimer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(settleTimer)
      unsubscribe?.()
      resolve(value)
    }
    const inspect = () => {
      const entries = source.getSnapshot()?.entries ?? []
      let armed = false
      let collected = ''
      for (const entry of entries) {
        if (entry.type !== 'event') continue
        const event = entry.event
        if (!event?.data) continue
        if (event.type === 'user/message') {
          const text = textOf(event.data.message?.content ?? event.data.content)
          if (isPrompt(text)) {
            armed = true
            collected = ''
          }
        } else if (event.type === 'assistant/message' && armed) {
          const text = textOf(event.data.message?.content ?? event.data.content)
          if (text) collected = collected ? `${collected}\n\n${text}` : text
        }
      }
      if (armed && collected) {
        // Models can emit several assistant messages for one turn. Wait for a
        // quiet period so the final JSON is complete before handing it back.
        clearTimeout(settleTimer)
        settleTimer = setTimeout(() => finish(collected), 1500)
      }
    }
    unsubscribe = source.subscribe(inspect)
    timer = setTimeout(() => finish(''), timeout)
    inspect()
  })
}

function waitForSummary(source, topicId, timeout) {
  return waitForReply(source, (text) => isSummaryPrompt(text, topicId), timeout)
}

export default GraphPanel
