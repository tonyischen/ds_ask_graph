import test from 'node:test'
import assert from 'node:assert/strict'
import { applySemanticGroups } from '../src/core.js'
import {
  buildSemanticPrompt,
  isSemanticPrompt,
  parseSemanticGroups,
  semanticMarker,
} from '../src/semantic.js'

const node = (id, sessionId, topicId, question, at, assignment = 'auto') => ({
  id,
  sessionId,
  topicId,
  question,
  answer: '',
  at,
  status: 'done',
  assignment,
})

function baseState() {
  return {
    version: 1,
    topics: [
      { id: 't1', title: '登录 token 过期', createdAt: 0, updatedAt: 0, summary: '旧的登录总结', summaryAt: 10, nodeIds: [] },
      { id: 't2', title: '登录 token 刷新', createdAt: 0, updatedAt: 0, summary: '旧的刷新总结', summaryAt: 20, nodeIds: [] },
      { id: 't3', title: '手动专题', createdAt: 0, updatedAt: 0, summary: '', summaryAt: 0, nodeIds: [] },
    ],
    nodes: [
      node('n1', 's', 't1', '登录 token 过期怎么处理？', 0),
      node('n2', 's', 't2', '登录 token 刷新失败怎么办？', 1000),
      node('m1', 's', 't3', '手动归类的节点', 2000, 'manual'),
    ],
    pendingTopics: {},
  }
}

test('semantic prompt includes marker and every node id', () => {
  const state = baseState()
  const token = 'abc'
  const prompt = buildSemanticPrompt(state.nodes, state.topics, token)
  assert.ok(prompt.includes(semanticMarker(token)))
  assert.ok(isSemanticPrompt(prompt, token))
  for (const item of state.nodes) assert.ok(prompt.includes(`id: ${item.id}`))
})

test('parseSemanticGroups accepts fenced JSON, drops unknown/duplicate ids', () => {
  const valid = new Set(['a', 'b', 'c'])
  const text = '```json\n{"topics":[{"title":"登录","nodeIds":["a","x","b","a"]},{"title":"图谱","summary":"图","nodeIds":["c"]}]}\n```'
  const { groups, missing } = parseSemanticGroups(text, valid)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].nodeIds, ['a', 'b'])
  assert.deepEqual(groups[1].nodeIds, ['c'])
  assert.deepEqual(missing, [])
  assert.throws(() => parseSemanticGroups('not json', valid))
})

test('parseSemanticGroups reports nodes the model omitted', () => {
  const { groups, missing } = parseSemanticGroups('{"topics":[{"title":"A","nodeIds":["a"]}]}', new Set(['a', 'b']))
  assert.equal(groups.length, 1)
  assert.deepEqual(missing, ['b'])
})

test('applySemanticGroups merges topics semantically and keeps manual nodes', () => {
  const next = applySemanticGroups(baseState(), [
    { title: '登录鉴权', summary: '登录 token 的过期与刷新。', nodeIds: ['n1', 'n2'] },
  ])
  const n1 = next.nodes.find((item) => item.id === 'n1')
  const n2 = next.nodes.find((item) => item.id === 'n2')
  assert.equal(n1.topicId, n2.topicId)
  const topic = next.topics.find((item) => item.id === n1.topicId)
  assert.equal(topic.title, '登录鉴权')
  assert.match(topic.summary, /登录 token 的过期与刷新/)
  assert.match(topic.summary, /旧的登录总结/)
  assert.match(topic.summary, /旧的刷新总结/)
  assert.equal(next.nodes.find((item) => item.id === 'm1').topicId, 't3')
  assert.equal(next.nodes.find((item) => item.id === 'm1').assignment, 'manual')
})

test('applySemanticGroups puts model-missing nodes into the inbox', () => {
  const next = applySemanticGroups(baseState(), [{ title: '登录鉴权', nodeIds: ['n1'] }])
  const n2 = next.nodes.find((item) => item.id === 'n2')
  const inbox = next.topics.find((item) => item.id === n2.topicId)
  assert.equal(inbox.kind, 'inbox')
  assert.equal(n2.assignmentReason, 'semantic')
})
