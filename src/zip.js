/**
 * Tiny store-only ZIP writer. Bluepin exports are mostly text plus already
 * compressed images, so deflate is not worth a dependency or the complexity.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function dosTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const month = date.getMonth() + 1
  const day = date.getDate()
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | (month << 5) | day,
  }
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value & 0xffff, true)
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true)
}

function asBytes(entry) {
  if (entry.bytes instanceof Uint8Array) return entry.bytes
  return new TextEncoder().encode(String(entry.text ?? ''))
}

/**
 * @param {Array<{path: string, text?: string, bytes?: Uint8Array}>} entries
 * @param {string[]} directories paths ending with `/`
 */
export function zipStore(entries, directories = [], now = new Date()) {
  const chunks = []
  const central = []
  let offset = 0
  const { time, date } = dosTime(now)
  const seen = new Set()

  const pushDir = (path) => {
    const name = String(path).replace(/\/?$/, '/')
    if (seen.has(name)) return
    seen.add(name)
    const nameBytes = new TextEncoder().encode(name)
    const header = new Uint8Array(30)
    const view = new DataView(header.buffer)
    writeU32(view, 0, 0x04034b50)
    writeU16(view, 4, 20)
    writeU16(view, 6, 0x0800)
    writeU16(view, 8, 0)
    writeU16(view, 10, time)
    writeU16(view, 12, date)
    writeU32(view, 14, 0)
    writeU32(view, 18, 0)
    writeU32(view, 22, 0)
    writeU16(view, 26, nameBytes.length)
    writeU16(view, 28, 0)
    chunks.push(header, nameBytes)
    central.push({ nameBytes, crc: 0, size: 0, offset, isDir: true })
    offset += header.length + nameBytes.length
  }

  for (const directory of directories) pushDir(directory)

  for (const entry of entries) {
    const path = String(entry.path).replace(/\\/g, '/')
    if (path.endsWith('/')) {
      pushDir(path)
      continue
    }
    if (seen.has(path)) continue
    seen.add(path)
    const bytes = asBytes(entry)
    const nameBytes = new TextEncoder().encode(path)
    const crc = crc32(bytes)
    const header = new Uint8Array(30)
    const view = new DataView(header.buffer)
    writeU32(view, 0, 0x04034b50)
    writeU16(view, 4, 20)
    writeU16(view, 6, 0x0800)
    writeU16(view, 8, 0)
    writeU16(view, 10, time)
    writeU16(view, 12, date)
    writeU32(view, 14, crc)
    writeU32(view, 18, bytes.length)
    writeU32(view, 22, bytes.length)
    writeU16(view, 26, nameBytes.length)
    writeU16(view, 28, 0)
    chunks.push(header, nameBytes, bytes)
    central.push({ nameBytes, crc, size: bytes.length, offset, isDir: false })
    offset += header.length + nameBytes.length + bytes.length
  }

  const centralOffset = offset
  let centralSize = 0
  for (const item of central) {
    const header = new Uint8Array(46)
    const view = new DataView(header.buffer)
    writeU32(view, 0, 0x02014b50)
    writeU16(view, 4, 20)
    writeU16(view, 6, 20)
    writeU16(view, 8, 0x0800)
    writeU16(view, 10, 0)
    writeU16(view, 12, time)
    writeU16(view, 14, date)
    writeU32(view, 16, item.crc)
    writeU32(view, 20, item.size)
    writeU32(view, 24, item.size)
    writeU16(view, 28, item.nameBytes.length)
    writeU16(view, 30, 0)
    writeU16(view, 32, 0)
    writeU16(view, 34, 0)
    writeU16(view, 36, 0)
    writeU32(view, 38, item.isDir ? 0x10 : 0)
    writeU32(view, 42, item.offset)
    chunks.push(header, item.nameBytes)
    centralSize += header.length + item.nameBytes.length
  }

  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  writeU32(endView, 0, 0x06054b50)
  writeU16(endView, 4, 0)
  writeU16(endView, 6, 0)
  writeU16(endView, 8, central.length)
  writeU16(endView, 10, central.length)
  writeU32(endView, 12, centralSize)
  writeU32(endView, 16, centralOffset)
  writeU16(endView, 20, 0)
  chunks.push(end)

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(total)
  let cursor = 0
  for (const chunk of chunks) {
    output.set(chunk, cursor)
    cursor += chunk.length
  }
  return output
}

/** Trigger a browser download for a Blob. Must be called from a user gesture. */
export function downloadBlob(blob, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('当前环境不支持浏览器下载')
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
