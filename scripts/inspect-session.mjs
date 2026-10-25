import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const from = Number(process.argv[3] ?? 0)
const to = Number(process.argv[4] ?? 1e9)
const raw = fs.readFileSync(file)
const ZSTD_MAGIC = 0xfd2fb528

function frameEnd(buf, start) {
  let p = start + 4
  const fhd = buf[p]
  p += 1
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const dictFlag = fhd & 3
  if (!singleSegment) p += 1
  p += [0, 1, 2, 4][dictFlag]
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  for (;;) {
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = bh & 1
    const type = (bh >> 1) & 3
    const size = bh >>> 3
    p += type === 1 ? 1 : size
    if (last) break
  }
  if (fhd & 4) p += 4
  return p
}

let text = ''
let p = 0
let frames = 0
while (p + 4 <= raw.length && raw.readUInt32LE(p) === ZSTD_MAGIC) {
  const end = frameEnd(raw, p)
  try { text += zlib.zstdDecompressSync(raw.subarray(p, end)).toString('utf8') } catch {}
  p = end
  frames += 1
}
const lines = text.split(/\r?\n/).filter(Boolean)
const events = []
for (const line of lines) {
  try {
    const rec = JSON.parse(line)
    if (rec.event) events.push(rec.event)
    else if (rec.type && typeof rec.seq === 'number') events.push(rec)
  } catch {}
}
console.error(`frames=${frames} lines=${lines.length} events=${events.length}`)
for (const ev of events) {
  if (ev.seq < from || ev.seq > to) continue
  if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
  const d = ev.data ?? {}
  const content = Array.isArray(d.content) ? d.content : d.message?.content
  const texts = (content ?? []).filter((b) => b?.type === 'text').map((b) => b.text)
  console.log(`seq=${ev.seq} type=${ev.type} source=${d.source?.kind ?? ''} role=${d.role ?? d.message?.role ?? ''} textLen=${texts.join('').length} :: ${texts.join(' ').slice(0, 90).replace(/\s+/g, ' ')}`)
}
