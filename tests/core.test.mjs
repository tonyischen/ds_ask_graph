import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeQuestion,
  chainEdges,
  classifyQuestion,
  decideTopic,
  ingestNodes,
  markerTitle,
  pairEntries,
  reclusterState,
  serialParallelEdges,
  sessionTopics,
  stripMarker,
  tokenize,
  textOf,
} from '../src/core.js'
import { loadState, normalizeState, saveState, storageKey } from '../src/store.js'
import { buildSummaryPrompt, isSummaryPrompt, localSummary } from '../src/summary.js'
import { dialogGraph, positionPatch, topicGraph } from '../src/graph.js'

const userEntry = (seq, text, time = seq * 1000) => ({
  type: 'event',
  event: { type: 'user/message', seq, time, data: { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }] } },
})

const contextEntry = (seq, text, kind = 'runtime-context') => ({
  type: 'event',
  event: {
    type: 'user/message',
    seq,
    time: seq * 1000,
    data: { id: `c${seq}`, role: 'user', source: { kind }, content: [{ type: 'text', text }] },
  },
})

const assistantEntry = (seq, text, time = seq * 1000) => ({
  type: 'event',
  event: {
    type: 'assistant/message',
    seq,
    time,
    data: { message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text }] } },
  },
})

const toolEntry = (seq, name, args = {}) => ({
  type: 'event',
  event: {
    type: 'assistant/message',
    seq,
    time: seq * 1000,
    data: {
      message: {
        id: `a${seq}`,
        role: 'assistant',
        content: [{ type: 'tool-call', id: `c${seq}`, name, arguments: JSON.stringify(args) }],
      },
    },
  },
})

const imageBlock = (attachmentId, name = 'image.png') => ({
  type: 'image',
  attachment: {
    attachmentId,
    mediaType: 'image/png',
    width: 100,
    height: 80,
    bytes: 1234,
    name,
  },
})

test('pairEntries keeps durable image refs and image-only questions', () => {
  const entries = [
    {
      type: 'event',
      event: {
        type: 'user/message',
        seq: 1,
        time: 1000,
        data: {
          message: {
            role: 'user',
            source: { kind: 'user' },
            content: [imageBlock('sha256:aaa'), { type: 'text', text: '看这张图' }, imageBlock('sha256:aaa')],
          },
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 2,
        time: 2000,
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '已处理。' }, imageBlock('sha256:bbb', 'reply.png')],
          },
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'user/message',
        seq: 3,
        time: 3000,
        data: {
          message: {
            role: 'user',
            source: { kind: 'user' },
            content: [imageBlock('sha256:ccc')],
          },
        },
      },
    },
  ]
  const nodes = pairEntries(entries, 's-img')
  assert.equal(nodes.length, 2)
  assert.deepEqual(nodes[0].images.map((image) => image.attachmentId), ['sha256:aaa', 'sha256:bbb'])
  assert.equal(nodes[1].question, '（图片提问）')
  assert.deepEqual(nodes[1].images.map((image) => image.attachmentId), ['sha256:ccc'])
  assert.equal(nodes[1].status, 'no-reply')
})

test('pairEntries treats a plan-only tool turn as a reply', () => {
  const nodes = pairEntries([userEntry(1, '帮我画个图'), toolEntry(2, 'exit_plan_mode', { plan: '# 方案\n先做画布。' })], 's4')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].status, 'done')
  assert.equal(nodes[0].answer, '# 方案\n先做画布。')
})

test('pairEntries leaves tool-only turns without a placeholder answer', () => {
  const nodes = pairEntries([userEntry(1, '继续'), toolEntry(2, 'todo_write', { todos: [] })], 's5')
  assert.equal(nodes[0].status, 'no-reply')
  assert.equal(nodes[0].answer, '')
})

test('pairEntries pairs a user question with assistant text and strips the topic marker', () => {
  const nodes = pairEntries([userEntry(1, '[专题：改造]\n怎么拆分模块？'), assistantEntry(2, '先按职责拆分。')], 's1')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].question, '怎么拆分模块？')
  assert.equal(nodes[0].answer, '先按职责拆分。')
  assert.equal(nodes[0].status, 'done')
  assert.equal(nodes[0].id, 's1:1')
})

test('pairEntries joins multi-step assistant messages and keeps unanswered questions', () => {
  const nodes = pairEntries(
    [userEntry(1, '第一个问题'), assistantEntry(2, '第一段'), assistantEntry(3, '第二段'), userEntry(4, '第二个问题')],
    's2',
  )
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].answer, '第一段\n\n第二段')
  assert.equal(nodes[1].status, 'no-reply')
})

test('pairEntries ignores injected context and handles newest-first windows', () => {
  const nodes = pairEntries(
    [
      assistantEntry(5, '更多回答'),
      assistantEntry(4, '回答'),
      contextEntry(3, 'Time sampled while preparing turn 1'),
      userEntry(2, '真正的问题'),
      contextEntry(1, 'Current runtime context. This snapshot supersedes', 'runtime-context'),
    ],
    's3',
  )
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].question, '真正的问题')
  assert.equal(nodes[0].answer, '回答\n\n更多回答')
})

test('marker helpers handle full-width and half-width colons', () => {
  assert.equal(markerTitle('[专题: 图表] 你好'), '图表')
  assert.equal(markerTitle('[专题：图表]\n你好'), '图表')
  assert.equal(stripMarker('[专题：图表]\n你好'), '你好')
  assert.equal(textOf({ content: [{ type: 'text', text: 'x' }, { type: 'reasoning', text: 'y' }] }), 'x')
})

function seededState() {
  const state = {
    version: 1,
    topics: [
      { id: 't1', title: '会话历史可视化', createdAt: 1, updatedAt: 1, summary: '', summaryAt: 0, nodeIds: ['s1:1'] },
      { id: 't2', title: '发布流程', createdAt: 2, updatedAt: 2, summary: '', summaryAt: 0, nodeIds: ['s2:1'] },
    ],
    nodes: [
      { id: 's1:1', sessionId: 's1', topicId: 't1', question: '如何把会话历史画成图谱？', answer: '用有向图。', at: 1000, status: 'done', assignment: 'manual' },
      { id: 's2:1', sessionId: 's2', topicId: 't2', question: '发布流程要几步？', answer: '三步。', at: 2000, status: 'done', assignment: 'manual' },
    ],
    assignments: { s1: 't1', s2: 't2' },
    pendingTopics: {},
    positions: {},
    topicPositions: {},
  }
  return state
}

test('classifyQuestion reuses a topic with overlapping tokens', () => {
  const state = seededState()
  const result = classifyQuestion('会话历史怎么画成图谱？', state, 3000)
  assert.equal(result?.topicId, 't1')
  assert.equal(classifyQuestion('完全无关的烹饪食谱问题', state, 3000), null)
})

test('ingestNodes routes by pending topic, then by marker, then by classification', () => {
  let state = seededState()
  state = { ...state, topics: [...state.topics, { id: 't3', title: '图表布局', createdAt: 3, updatedAt: 3, summary: '', summaryAt: 0, nodeIds: [] }] }
  state = { ...state, pendingTopics: { s3: 't3' } }
  const pending = ingestNodes(state, [
    { id: 's3:1', sessionId: 's3', question: '这张图怎么布局？', answer: '', at: 3000, status: 'no-reply' },
  ], 3000)
  assert.equal(pending.nodes.find((node) => node.id === 's3:1')?.topicId, 't3')
  assert.equal(pending.pendingTopics.s3, undefined)

  const marked = ingestNodes(pending, [
    { id: 's4:1', sessionId: 's4', question: '[专题：新主题]\n一个全新的问题', answer: '', at: 4000, status: 'no-reply' },
  ], 4000)
  const topic = marked.topics.find((item) => item.title === '新主题')
  assert.ok(topic)
  assert.equal(marked.nodes.find((node) => node.id === 's4:1')?.topicId, topic.id)

  const classified = ingestNodes(marked, [
    { id: 's5:1', sessionId: 's5', question: '会话历史怎么画成图谱？', answer: '继续讨论。', at: 5000, status: 'done' },
  ], 5000)
  assert.equal(classified.nodes.find((node) => node.id === 's5:1')?.topicId, 't1')
})

test('一个长会话可以交叉提多个专题的问题，且隔很久仍回到原专题', () => {
  let state = { version: 1, topics: [], nodes: [], pendingTopics: {} }
  state = ingestNodes(state, [{ id: 'a1', sessionId: 's', question: '登录鉴权 token 过期怎么处理？', answer: '刷新 token。', at: 0, status: 'done' }], 0)
  const loginTopic = state.nodes[0].topicId
  state = ingestNodes(state, [{ id: 'a2', sessionId: 's', question: '图谱布局的节点重叠怎么分开？', answer: '拖动节点。', at: 600_000, status: 'done' }], 600_000)
  const layoutTopic = state.nodes.find((node) => node.id === 'a2').topicId
  assert.notEqual(loginTopic, layoutTopic)

  state = ingestNodes(state, [{ id: 'a3', sessionId: 's', question: '登录鉴权 token 刷新后仍然过期怎么办？', answer: '重新登录。', at: 1_200_000, status: 'done' }], 1_200_000)
  assert.equal(state.nodes.find((node) => node.id === 'a3').topicId, loginTopic)

  const later = 90 * 86_400_000
  const decision = decideTopic('登录鉴权 token 又过期了怎么办？', state, { sessionId: 's', now: later })
  assert.equal(decision.topicId, loginTopic)
})

test('recluster splits interleaved topics and keeps manual assignments', () => {
  const state = {
    version: 1,
    topics: [
      { id: 't1', title: '杂项', createdAt: 0, updatedAt: 0, nodeIds: [] },
      { id: 't2', title: '发布流程', createdAt: 0, updatedAt: 0, nodeIds: [] },
    ],
    nodes: [
      { id: 'n1', sessionId: 's', topicId: 't1', question: '登录鉴权 token 过期怎么处理？', answer: '刷新 token。', at: 0, status: 'done', assignment: 'auto' },
      { id: 'n2', sessionId: 's', topicId: 't1', question: '图谱布局的节点重叠怎么分开？', answer: '拖动节点。', at: 1000, status: 'done', assignment: 'auto' },
      { id: 'n3', sessionId: 's', topicId: 't1', question: '登录鉴权 token 刷新后仍然过期怎么办？', answer: '重新登录。', at: 2000, status: 'done', assignment: 'auto' },
      { id: 'm1', sessionId: 's', topicId: 't2', question: '发布流程要几步？', answer: '三步。', at: 3000, status: 'done', assignment: 'manual' },
    ],
    pendingTopics: {},
  }
  const next = reclusterState(state)
  const loginA = next.nodes.find((node) => node.id === 'n1')
  const loginB = next.nodes.find((node) => node.id === 'n3')
  const layout = next.nodes.find((node) => node.id === 'n2')
  assert.equal(loginA.topicId, loginB.topicId)
  assert.notEqual(loginA.topicId, layout.topicId)
  assert.equal(next.nodes.find((node) => node.id === 'm1').topicId, 't2')
  assert.equal(next.nodes.find((node) => node.id === 'm1').assignment, 'manual')
})

test('同一功能的改写问法会回到原专题，而不是各开一个专题', () => {
  let state = { version: 1, topics: [], nodes: [], pendingTopics: {} }
  state = ingestNodes(state, [{ id: 'g1', sessionId: 's', question: '图谱布局的节点重叠怎么分开？', answer: '拖开。', at: 0, status: 'done' }], 0)
  const graphTopic = state.nodes[0].topicId
  state = ingestNodes(state, [{ id: 'l1', sessionId: 's', question: '登录 token 过期怎么处理？', answer: '刷新。', at: 1000, status: 'done' }], 1000)
  assert.notEqual(state.nodes.find((node) => node.id === 'l1').topicId, graphTopic)

  state = ingestNodes(state, [{ id: 'g2', sessionId: 's', question: '图谱的边线能改成曲线吗？', answer: '可以。', at: 2000, status: 'done' }], 2000)
  assert.equal(state.nodes.find((node) => node.id === 'g2').topicId, graphTopic)

  const tokens = tokenize('登录 token 过期怎么处理？')
  assert.ok(!tokens.has('么处'))
  assert.ok(tokens.has('登录') && tokens.has('token'))
})

test('recluster keeps summaries of topics that get merged', () => {
  const state = {
    version: 1,
    topics: [
      { id: 't1', title: '登录 token 过期', createdAt: 0, updatedAt: 0, summary: '旧的登录总结', summaryAt: 10, nodeIds: [] },
      { id: 't2', title: '登录 token 刷新', createdAt: 0, updatedAt: 0, summary: '旧的刷新总结', summaryAt: 20, nodeIds: [] },
    ],
    nodes: [
      { id: 'n1', sessionId: 's', topicId: 't1', question: '登录 token 过期怎么处理？', answer: '', at: 0, status: 'done', assignment: 'auto' },
      { id: 'n2', sessionId: 's', topicId: 't2', question: '登录 token 刷新失败怎么办？', answer: '', at: 1000, status: 'done', assignment: 'auto' },
    ],
    pendingTopics: {},
  }
  const next = reclusterState(state)
  assert.equal(next.topics.length, 1)
  assert.match(next.topics[0].summary, /旧的登录总结/)
  assert.match(next.topics[0].summary, /旧的刷新总结/)
})

test('analyzeQuestion marks short and anaphoric follow-ups', () => {
  assert.equal(analyzeQuestion('那这个呢？').anaphoric, true)
  assert.equal(analyzeQuestion('那这个呢？').short, true)
  assert.equal(analyzeQuestion('登录鉴权 token 过期以后应该怎么样处理？').short, false)
})

test('ingestNodes refreshes answers of existing nodes without moving them', () => {
  const state = ingestNodes(seededState(), [
    { id: 's1:1', sessionId: 's1', question: 'ignored', answer: '新的回复', at: 1000, status: 'done' },
  ])
  const node = state.nodes.find((item) => item.id === 's1:1')
  assert.equal(node.answer, '新的回复')
  assert.equal(node.topicId, 't1')
})

test('topic edges mark serial and overlapping parallel spans', () => {
  const state = {
    topics: [
      { id: 'a', title: 'A', nodeIds: [], createdAt: 0, updatedAt: 0 },
      { id: 'b', title: 'B', nodeIds: [], createdAt: 0, updatedAt: 0 },
      { id: 'c', title: 'C', nodeIds: [], createdAt: 0, updatedAt: 0 },
    ],
    nodes: [
      { id: 'a1', sessionId: 'a', topicId: 'a', question: 'a', at: 0, answer: '' },
      { id: 'a2', sessionId: 'a', topicId: 'a', question: 'a2', at: 1000, answer: '' },
      { id: 'b1', sessionId: 'b', topicId: 'b', question: 'b', at: 3000, answer: '' },
      { id: 'b2', sessionId: 'b', topicId: 'b', question: 'b2', at: 5000, answer: '' },
      { id: 'c1', sessionId: 'c', topicId: 'c', question: 'c', at: 4000, answer: '' },
      { id: 'c2', sessionId: 'c', topicId: 'c', question: 'c2', at: 6000, answer: '' },
    ],
  }
  const edges = serialParallelEdges(state)
  assert.ok(edges.some((edge) => edge.source === 'a' && edge.target === 'b' && edge.kind === 'serial'))
  assert.ok(edges.some((edge) => edge.source === 'b' && edge.target === 'c' && edge.kind === 'parallel'))
  assert.deepEqual(chainEdges([{ id: 'x', at: 2 }, { id: 'y', at: 1 }]).map((edge) => `${edge.source}->${edge.target}`), ['y->x'])
})

test('ingestNodes merges image refs into existing nodes', () => {
  let state = { version: 1, topics: [], nodes: [], pendingTopics: {} }
  const first = {
    id: 'img:1',
    sessionId: 's',
    question: '看图',
    answer: '',
    at: 1000,
    status: 'no-reply',
    images: [{ attachmentId: 'sha256:one', mediaType: 'image/png' }],
  }
  state = ingestNodes(state, [first], 1000)
  state = ingestNodes(
    state,
    [{ ...first, images: [{ attachmentId: 'sha256:two', mediaType: 'image/jpeg' }] }],
    1000,
  )
  assert.deepEqual(state.nodes[0].images.map((image) => image.attachmentId), ['sha256:one', 'sha256:two'])
})

test('store keeps valid image refs and drops malformed ones', () => {
  const normalized = normalizeState({
    version: 1,
    topics: [{ id: 't', title: 'T' }],
    nodes: [
      {
        id: 'n',
        sessionId: 's',
        topicId: 't',
        question: 'q',
        images: [
          { attachmentId: 'sha256:ok', mediaType: 'image/png', name: 'a.png' },
          { attachmentId: 'bad', mediaType: 'image/png' },
          { attachmentId: 'sha256:ok', mediaType: 'image/jpeg' },
        ],
      },
    ],
  })
  assert.deepEqual(normalized.nodes[0].images.map((image) => image.attachmentId), ['sha256:ok'])
  assert.equal(normalized.nodes[0].images[0].mediaType, 'image/png')
})

test('store drops stale coordinates when the layout version changes', () => {
  const migrated = normalizeState({
    version: 1,
    layoutVersion: 1,
    topics: [{ id: 't', title: 'T' }],
    nodes: [{ id: 'n', sessionId: 's', topicId: 't', question: 'q' }],
    positions: { t: { n: { x: 1, y: 2 } } },
    topicPositions: { t: { x: 5, y: 5 } },
  })
  assert.equal(migrated.layoutVersion, 2)
  assert.deepEqual(migrated.positions, {})
  assert.deepEqual(migrated.topicPositions, {})
  assert.equal(migrated.topics.length, 1)
  assert.equal(migrated.nodes.length, 1)
})

test('store normalizes malformed state and round-trips through localStorage', () => {
  const normalized = normalizeState({ version: 1, layoutVersion: 2, topics: [{ id: 't', title: 'T' }], nodes: [{ id: 'n', sessionId: 's', topicId: 't', question: 'q' }], positions: { t: { n: { x: 1, y: 2 }, bad: { x: 'x' } } } })
  assert.equal(normalized.topics.length, 1)
  assert.equal(normalized.nodes.length, 1)
  assert.deepEqual(normalized.positions.t, { n: { x: 1, y: 2 } })
  assert.equal(normalizeState({ version: 99 }).topics.length, 0)
  assert.equal(storageKey('ws1'), 'ask-graph:v1:ws1')

  const memory = new Map()
  const original = globalThis.localStorage
  globalThis.localStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  }
  try {
    const state = seededState()
    assert.equal(saveState('ws1', state).ok, true)
    assert.equal(loadState('ws1').topics.length, 2)
    memory.set(storageKey('ws1'), '{broken')
    assert.equal(loadState('ws1').topics.length, 0)
  } finally {
    globalThis.localStorage = original
  }
})

test('store drops injected context nodes written by older versions', () => {
  const normalized = normalizeState({
    version: 1,
    topics: [
      { id: 'bad', title: '噪音专题' },
      { id: 'good', title: '真实专题' },
    ],
    nodes: [
      { id: 'b', sessionId: 's', topicId: 'bad', question: 'Current runtime context. This snapshot supersedes earlier ones.' },
      { id: 'g', sessionId: 's', topicId: 'good', question: '真实问题' },
    ],
  })
  assert.deepEqual(normalized.topics.map((topic) => topic.id), ['good'])
  assert.deepEqual(normalized.nodes.map((node) => node.id), ['g'])
})

test('store renames topics whose title came from injected context', () => {
  const normalized = normalizeState({
    version: 1,
    topics: [{ id: 't', title: 'The approval policy changed from ask to never' }],
    nodes: [{ id: 'n', sessionId: 's', topicId: 't', question: '真正的用户问题' }],
  })
  assert.equal(normalized.topics[0].title, '真正的用户问题')
})

test('summary helpers are deterministic and include the topic marker', () => {
  const state = seededState()
  const topic = state.topics[0]
  const nodes = [state.nodes[0]]
  const summary = localSummary(topic, nodes)
  assert.match(summary, /共 1 个对话节点/)
  assert.match(summary, /会话历史/)
  const prompt = buildSummaryPrompt(topic, nodes)
  assert.ok(isSummaryPrompt(prompt, 't1'))
  assert.ok(!isSummaryPrompt(prompt, 't2'))
  assert.match(prompt, /专题总结/)
})

test('graph layouts produce finite positions and chain edges', () => {
  const state = {
    topics: [
      { id: 't1', title: 'A', createdAt: 1, updatedAt: 1, summary: '', summaryAt: 0, nodeIds: [] },
      { id: 't2', title: 'B', createdAt: 2, updatedAt: 2, summary: '', summaryAt: 0, nodeIds: [] },
    ],
    nodes: [
      { id: 's1:1', sessionId: 's1', topicId: 't1', question: '第一问', answer: '答', at: 1000, status: 'done' },
      { id: 's1:2', sessionId: 's1', topicId: 't1', question: '第二问', answer: '', at: 2000, status: 'no-reply' },
      { id: 's2:1', sessionId: 's2', topicId: 't2', question: '另一问', answer: '', at: 3000, status: 'no-reply' },
    ],
    topicPositions: {},
    positions: {},
  }
  const root = topicGraph(state, {})
  assert.equal(root.nodes.length, 2)
  assert.equal(root.edges.length, 1)
  for (const node of root.nodes) {
    assert.ok(Number.isFinite(node.position.x))
    assert.ok(Number.isFinite(node.position.y))
  }
  const sub = dialogGraph(state, 't1', {})
  assert.equal(sub.nodes.length, 2)
  assert.equal(sub.edges.length, 1)
  assert.deepEqual(positionPatch({}, 'n', { x: 1.6, y: 2.4 }), { n: { x: 2, y: 2 } })
})
