import test from 'node:test'
import assert from 'node:assert/strict'
import { crc32, zipStore } from '../src/zip.js'

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index
      break
    }
  }
  assert.notEqual(eocd, -1, 'EOCD missing')
  const count = view.getUint16(eocd + 10, true)
  const centralOffset = view.getUint32(eocd + 16, true)
  const out = []
  let cursor = centralOffset
  const decoder = new TextDecoder()
  for (let index = 0; index < count; index += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50)
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const crc = view.getUint32(cursor + 16, true)
    const size = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = bytes.subarray(dataStart, dataStart + size)
    out.push({ name, flags, method, crc, data, directory: name.endsWith('/') })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return out
}

test('zipStore writes UTF-8 names, directories and file bytes', () => {
  const entries = [
    { path: 'vault/pages/问题-01.md', text: '你好，Bluepin' },
    { path: 'vault/assets/image.png', bytes: new Uint8Array([1, 2, 3, 4]) },
  ]
  const dirs = ['vault/', 'vault/pages/', 'vault/assets/', 'vault/daily/']
  const zip = zipStore(entries, dirs, new Date('2026-10-25T12:00:00'))
  const parsed = readZip(zip)
  const byName = new Map(parsed.map((item) => [item.name, item]))
  assert.ok(byName.get('vault/')?.directory)
  assert.ok(byName.get('vault/pages/')?.directory)
  assert.ok(byName.get('vault/daily/')?.directory)
  const note = byName.get('vault/pages/问题-01.md')
  assert.equal(note.flags & 0x0800, 0x0800)
  assert.equal(note.method, 0)
  assert.equal(new TextDecoder().decode(note.data), '你好，Bluepin')
  const image = byName.get('vault/assets/image.png')
  assert.deepEqual([...image.data], [1, 2, 3, 4])
  assert.equal(image.crc, crc32(image.data))
})

test('zipStore does not duplicate paths', () => {
  const zip = zipStore(
    [
      { path: 'vault/a.md', text: 'one' },
      { path: 'vault/a.md', text: 'two' },
    ],
    ['vault/'],
  )
  const parsed = readZip(zip).filter((item) => item.name === 'vault/a.md')
  assert.equal(parsed.length, 1)
  assert.equal(new TextDecoder().decode(parsed[0].data), 'one')
})
