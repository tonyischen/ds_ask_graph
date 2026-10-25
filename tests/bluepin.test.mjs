import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bluepinDownloadName,
  buildBluepinVault,
  imageKey,
  rewriteMarkdownImages,
  sanitizeSegment,
} from '../src/bluepin.js'
import { collectImageSources, resolveImages } from '../src/images.js'

const node = (id, sessionId, topicId, question, answer, at, images = []) => ({
  id,
  sessionId,
  topicId,
  question,
  answer,
  at,
  status: 'done',
  images,
})

function sampleState() {
  return {
    version: 1,
    topics: [
      { id: 't1', title: '登录鉴权', createdAt: 0, updatedAt: 1000, summary: '登录 token 的总结。', keywords: ['登录', 'token'], nodeIds: [] },
      { id: 't2', title: '图谱布局', createdAt: 2000, updatedAt: 3000, summary: '', keywords: ['图谱'], nodeIds: [] },
    ],
    nodes: [
      node('n1', 's1', 't1', '登录 token 过期怎么处理？', '刷新 token。', 0, [
        { attachmentId: 'sha256:abc', mediaType: 'image/png', name: 'image.png' },
      ]),
      node('n2', 's1', 't1', '刷新失败怎么办？', '重新登录。', 1000),
      node('n3', 's2', 't2', '节点重叠怎么分开？', '拖开。', 2000),
    ],
  }
}

const assetBundle = {
  map: new Map([['attachment:sha256:abc', 'assets/image-abc-image.png']]),
  assets: [{ path: 'assets/image-abc-image.png', bytes: new Uint8Array([1, 2, 3]) }],
  warnings: [],
}

function stems(vault) {
  return new Set(
    vault.files
      .filter((file) => file.path.endsWith('.md'))
      .map((file) => file.path.split('/').pop().replace(/\.md$/, '')),
  )
}

test('buildBluepinVault creates the standard Bluepin layout and wiki links', () => {
  const vault = buildBluepinVault(sampleState(), { workspaceTitle: '测试工作区', assets: assetBundle, now: 1_700_000_000_000 })
  assert.equal(vault.rootName, '测试工作区-提问图谱')
  assert.deepEqual(vault.dirs, [
    '测试工作区-提问图谱/',
    '测试工作区-提问图谱/pages/',
    '测试工作区-提问图谱/assets/',
    '测试工作区-提问图谱/daily/',
  ])
  const paths = vault.files.map((file) => file.path)
  assert.ok(paths.includes('测试工作区-提问图谱/pages/提问图谱-测试工作区.md'))
  assert.ok(paths.includes('测试工作区-提问图谱/pages/专题-登录鉴权.md'))
  assert.ok(paths.includes('测试工作区-提问图谱/pages/问题-登录鉴权-01.md'))
  assert.ok(paths.includes('测试工作区-提问图谱/assets/image-abc-image.png'))
  assert.ok(paths.includes('测试工作区-提问图谱/assets/专题图.svg'))
  assert.ok(paths.includes('测试工作区-提问图谱/assets/问题图-登录鉴权.svg'))
  assert.equal(vault.stats.svgs, 3)

  const index = vault.files.find((file) => file.path.endsWith('提问图谱-测试工作区.md')).text
  assert.match(index, /!\[专题图\]\(assets\/专题图\.svg\)/)
  assert.match(index, /\[\[专题-登录鉴权\]\]/)
  assert.match(index, /\[\[专题-图谱布局\]\]/)

  const topic = vault.files.find((file) => file.path.endsWith('专题-登录鉴权.md')).text
  assert.match(topic, /!\[问题图\]\(assets\/问题图-登录鉴权\.svg\)/)
  assert.match(topic, /\[\[问题-登录鉴权-01\]\] — 登录 token 过期怎么处理？/)
  assert.match(topic, /\[\[问题-登录鉴权-02\]\] — 刷新失败怎么办？/)
  assert.match(topic, /后续：\[\[专题-图谱布局\]\]（串行）/)

  const question = vault.files.find((file) => file.path.endsWith('问题-登录鉴权-02.md')).text
  assert.match(question, /上一问：\[\[问题-登录鉴权-01\]\] — 登录 token 过期怎么处理？/)
  assert.match(question, /下一问：无/)
  assert.match(question, /\[\[专题-登录鉴权\]\]/)

  const first = vault.files.find((file) => file.path.endsWith('问题-登录鉴权-01.md')).text
  assert.match(first, /!\[image\.png\]\(assets\/image-abc-image\.png\)/)
})

test('every generated wiki target resolves to a generated note', () => {
  const vault = buildBluepinVault(sampleState(), { workspaceTitle: '测试工作区', assets: assetBundle, now: 1_700_000_000_000 })
  const targets = stems(vault)
  for (const file of vault.files) {
    if (!file.text) continue
    for (const match of file.text.matchAll(/\[\[([^\]]+)\]\]/g)) {
      assert.ok(!match[1].includes('|'), `alias syntax is unsupported by Bluepin: ${match[0]}`)
      assert.ok(targets.has(match[1]), `broken wiki target ${match[1]} in ${file.path}`)
    }
  }
})

test('duplicate titles get unique files and links', () => {
  const state = sampleState()
  state.topics.push({ id: 't3', title: '登录鉴权', createdAt: 0, updatedAt: 0, summary: '', keywords: [], nodeIds: [] })
  state.nodes.push(node('n4', 's3', 't3', '另一个登录问题？', '答。', 3000))
  const vault = buildBluepinVault(state, { workspaceTitle: '测试工作区', assets: assetBundle, now: 1_700_000_000_000 })
  const names = stemList(vault)
  assert.equal(names.filter((name) => name.startsWith('专题-登录鉴权')).length, 2)
  assert.ok(names.includes('专题-登录鉴权-2'))
  const index = vault.files.find((file) => file.path.endsWith('提问图谱-测试工作区.md')).text
  assert.match(index, /\[\[专题-登录鉴权-2\]\]/)
})

function stemList(vault) {
  return vault.files.filter((file) => file.path.endsWith('.md')).map((file) => file.path.split('/').pop().replace(/\.md$/, ''))
}

test('sanitizeSegment handles Windows reserved names and illegal characters', () => {
  assert.equal(sanitizeSegment('a/b:c*?'), 'a-b-c')
  assert.equal(sanitizeSegment('CON'), '_CON')
  assert.equal(sanitizeSegment('  . '), '未命名')
  assert.equal(sanitizeSegment('图谱 布局'), '图谱-布局')
})

test('rewriteMarkdownImages rewrites outside fences only', () => {
  const map = new Map([[imageKey('https://example.com/a.png'), 'assets/a.png']])
  const source = '```md\n![x](https://example.com/a.png)\n```\n![y](https://example.com/a.png)'
  const result = rewriteMarkdownImages(source, map)
  assert.match(result, /```md\n!\[x\]\(https:\/\/example\.com\/a\.png\)\n```/)
  assert.match(result, /!\[y\]\(assets\/a\.png\)/)
})

test('collectImageSources and resolveImages handle attachments and data URLs', async () => {
  const state = sampleState()
  state.nodes[1].answer = '看图：![inline](data:image/png;base64,AQID)'
  const sources = collectImageSources(state)
  const keys = sources.map((source) => source.key)
  assert.ok(keys.includes('attachment:sha256:abc'))
  assert.ok(keys.some((key) => key.startsWith('data:')))

  const read = []
  const sessions = {
    retain(sessionId) {
      assert.equal(sessionId, 's1')
      return {
        ready: Promise.resolve(),
        binding: {
          session: {
            readAttachment: async (attachmentId) => {
              read.push(attachmentId)
              return { ok: true, value: { attachment: { mediaType: 'image/png' }, data: new Uint8Array([9, 8, 7]) } }
            },
          },
        },
        release() {},
      }
    },
  }
  const resolved = await resolveImages(sources, { sessions })
  assert.deepEqual(read, ['sha256:abc'])
  assert.ok(resolved.map.get('attachment:sha256:abc'))
  assert.equal(resolved.assets.length, 2)
  assert.ok(resolved.assets.some((asset) => asset.bytes.length === 3))
})

test('Bluepin download name includes a date', () => {
  const name = bluepinDownloadName('测试-提问图谱', 1_700_000_000_000)
  assert.match(name, /^测试-提问图谱-\d{8}-\d{4}\.zip$/)
})
