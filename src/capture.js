import { pairEntries } from './core.js'

const BACKFILL_LIMIT = 20


/**
 * Content-bearing fields of a Session summary. `retainedBy`/`referenceCount`
 * are deliberately excluded: every `sessions.retain()`/`reference.release()`
 * this manager performs mutates the very list it subscribes to, so treating
 * those counters as "changed" fed the manager its own notifications and
 * re-read the session forever (a ~650 ms loop that kept waking the shared
 * store until the sidebar's Slot entry died on React's maximum update depth).
 */
function signature(summary) {
  if (!summary) return ''
  return [
    summary.updatedAt ?? 0,
    summary.running ? 1 : 0,
    summary.phase ?? '',
    summary.blank ? 1 : 0,
    summary.title ?? '',
  ].join('|')
}

function changed(summary, previous) {
  if (!summary) return false
  if (previous === undefined) return true
  return signature(summary) !== previous
}

/**
 * Reads session event windows and emits paired dialog nodes. It never holds a
 * session open for long: backfill reads once, live updates re-read the changed
 * session on a short debounce.
 */
export class CaptureManager {
  constructor({ sessions, workspaces, workspaceId, onNodes, onStatus }) {
    this.sessions = sessions
    this.workspaces = workspaces
    this.workspaceId = workspaceId
    this.onNodes = onNodes
    this.onStatus = onStatus
    this.stopped = false
    this.seen = new Map()
    this.busy = new Set()
    this.timers = new Map()
    this.backfilled = false
    this.unsubscribe = undefined
  }

  start() {
    this.stopped = false
    const list = this.sessions?.list
    if (!list) {
      this.onStatus?.({ phase: 'error', message: 'sessions 服务不可用' })
      return
    }
    this.unsubscribe = list.subscribe(() => this.onListChange())
    this.onListChange()
  }

  stop() {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.seen.clear()
    this.busy.clear()
    this.backfilled = false
  }

  workspace() {
    if (!this.workspaceId) return undefined
    return this.workspaces?.list?.getSnapshot()?.items?.find((item) => item.workspaceId === this.workspaceId)
  }

  candidateIds() {
    const snapshot = this.sessions.list.getSnapshot()
    const workspace = this.workspace()
    const archived = new Set(this.workspaces?.list?.getSnapshot()?.archivedSessionIds ?? [])
    const within = (id) => {
      if (archived.has(id)) return false
      const summary = snapshot.byId?.[id]
      if (summary?.parentId) return false
      if (!workspace) return true
      return workspace.sessionIds?.includes(id) || summary?.cwd === workspace.path
    }
    const ids = (snapshot.ids ?? []).filter(within)
    return ids.sort((a, b) => (snapshot.byId?.[b]?.updatedAt ?? 0) - (snapshot.byId?.[a]?.updatedAt ?? 0))
  }

  onListChange() {
    if (this.stopped) return
    const snapshot = this.sessions.list.getSnapshot()
    const ids = this.candidateIds()

    if (!this.backfilled && ids.length > 0) {
      const backfillIds = ids.filter((id) => !snapshot.byId?.[id]?.blank).slice(0, BACKFILL_LIMIT)
      if (backfillIds.length > 0) {
        this.backfilled = true
        this.backfill(backfillIds)
      }
    }
    if (!this.backfilled && snapshot.phase === 'ready') this.backfilled = true

    for (const id of ids) {
      const summary = snapshot.byId?.[id]
      if (!summary) continue
      const previous = this.seen.get(id)
      if (!changed(summary, previous)) continue
      this.seen.set(id, signature(summary))
      if (this.busy.has(id)) continue
      this.queueRead(id)
    }
  }

  queueRead(id, delay = 650) {
    if (this.busy.has(id)) return
    const current = this.timers.get(id)
    if (current) clearTimeout(current)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      this.readSession(id)
    }, delay)
    this.timers.set(id, timer)
  }

  async backfill(ids) {
    this.onStatus?.({ phase: 'reading', message: `读取最近 ${ids.length} 个会话…` })
    let index = 0
    const worker = async () => {
      while (!this.stopped && index < ids.length) {
        const id = ids[index]
        const deep = index < 3
        index += 1
        await this.readSession(id, true, deep)
      }
    }
    await Promise.all([worker(), worker(), worker()])
    if (!this.stopped) this.onStatus?.({ phase: 'ready', message: '' })
  }

  async readSession(id, backfill = false, deep = false) {
    if (this.stopped || this.busy.has(id)) return
    this.busy.add(id)
    let reference
    try {
      reference = this.sessions.retain(id, { source: 'ask-graph' })
      await reference.ready
      const session = reference.binding?.session
      const source = reference.binding?.eventSource
      if (!session || !source) return

      const maxPages = deep ? 800 : backfill ? 200 : 2
      for (let page = 0; page < maxPages; page += 1) {
        const window = source.getSnapshot()
        if (!window?.hasMore) break
        try {
          await session.loadOlder()
        } catch {
          break
        }
      }

      const entries = source.getSnapshot()?.entries ?? []
      const nodes = pairEntries(entries, id).filter(
        (node) =>
          !node.question.includes('<!--ask-graph-summary:') &&
          !node.question.includes('<!--ask-graph-semantic:') &&
          !node.question.startsWith('你是 DSH 的专题总结助手') &&
          !node.question.startsWith('你是「提问图谱」的语义整理助手'),
      )
      if (nodes.length > 0 && !this.stopped) this.onNodes?.(id, nodes)
      if (backfill && nodes.length === 0) this.onStatus?.({ phase: 'ready', message: '' })
    } catch (error) {
      this.onStatus?.({ phase: 'error', message: `会话 ${id.slice(0, 8)} 读取失败：${error?.message ?? error}` })
    } finally {
      this.busy.delete(id)
      try {
        reference?.release()
      } catch {
        // Released by the controller already.
      }
    }
  }
}

