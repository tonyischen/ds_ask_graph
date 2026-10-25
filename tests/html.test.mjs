import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHtmlReport } from '../src/html.js'
import { buildQuestionSvg, buildTopicSvg } from '../src/svg.js'

const state = {
  version: 1,
  topics: [
    { id: 't1', title: '登录鉴权', createdAt: 0, updatedAt: 1000, summary: '登录 token 的总结。', keywords: ['登录'], nodeIds: [] },
    { id: 't2', title: '图谱布局', createdAt: 2000, updatedAt: 3000, summary: '', keywords: [], nodeIds: [] },
  ],
  nodes: [
    {
      id: 'n1',
      sessionId: 's1',
      topicId: 't1',
      question: '登录 token 过期怎么处理？',
      answer: '刷新 token。',
      at: 1000,
      status: 'done',
      images: [{ attachmentId: 'sha256:abc', mediaType: 'image/png', name: 'image.png' }],
    },
    {
      id: 'n2',
      sessionId: 's1',
      topicId: 't1',
      question: '刷新失败怎么办？',
      answer: '重新登录。',
      at: 2000,
      status: 'done',
      images: [],
    },
    {
      id: 'n3',
      sessionId: 's2',
      topicId: 't2',
      question: '节点重叠怎么分开？',
      answer: '拖开。',
      at: 3000,
      status: 'done',
      images: [],
    },
  ],
}

const assets = {
  map: new Map([['attachment:sha256:abc', 'assets/image-abc.png']]),
  assets: [{ path: 'assets/image-abc.png', bytes: new Uint8Array([1, 2, 3]) }],
  warnings: [],
}

test('buildTopicSvg includes topic nodes and serial edge', () => {
  const svg = buildTopicSvg(state, { title: '专题图' })
  assert.match(svg, /^<svg /)
  assert.match(svg, /登录鉴权/)
  assert.match(svg, /图谱布局/)
  assert.match(svg, /串行|并行/)
  assert.match(svg, /marker-end="url\(#arrow-topics\)"/)
})

test('buildQuestionSvg includes question cards and time chain', () => {
  const svg = buildQuestionSvg(state, 't1', { title: '登录鉴权 · 问题图' })
  assert.match(svg, /登录 token 过期怎么处理？/)
  assert.match(svg, /刷新失败怎么办？/)
  assert.match(svg, /marker-end="url\(#arrow-q-t1\)"/)
})

test('buildHtmlReport contains outline, SVG, content, anchors and embedded image', () => {
  const html = buildHtmlReport(state, { workspaceTitle: '测试工作区', assets })
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<ol class="outline">/)
  assert.match(html, /<svg /)
  assert.match(html, /#topic-t1/)
  assert.match(html, /#q-n1/)
  assert.match(html, /登录 token 过期怎么处理？/)
  assert.match(html, /刷新 token。/)
  assert.match(html, /data:image\/png;base64,/)
  assert.match(html, /id="topic-t1"/)
  assert.match(html, /id="q-n1"/)
})

test('HTML search script and styles are self-contained', () => {
  const html = buildHtmlReport(state, { workspaceTitle: '测试工作区', assets })
  assert.ok(!html.includes('src="http'))
  assert.match(html, /<style>/)
  assert.match(html, /getElementById\('search'\)/)
})
