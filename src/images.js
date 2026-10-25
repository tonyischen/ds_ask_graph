import { collectMarkdownImages, hashString, imageKey, sanitizeSegment } from './bluepin.js'

const EXT_BY_MEDIA = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
}

const MEDIA_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

function extensionFromMedia(mediaType) {
  return EXT_BY_MEDIA[String(mediaType ?? '').split(';')[0].trim().toLowerCase()] || 'png'
}

function extensionFromName(name) {
  const match = String(name ?? '').match(/\.([a-z0-9]{2,5})(?:$|[?#])/i)
  return match ? match[1].toLowerCase() : ''
}

function sourceForUrl(url) {
  const value = String(url ?? '').trim()
  if (!value) return null
  if (value.startsWith('data:')) {
    return { key: imageKey(value), kind: 'data', url: value }
  }
  if (/^https?:\/\//i.test(value)) {
    return { key: imageKey(value), kind: 'remote', url: value }
  }
  return { key: imageKey(value), kind: 'local', url: value }
}

/**
 * All image sources referenced by the graph: DSH attachment refs plus markdown
 * images in questions, replies and topic summaries.
 */
export function collectImageSources(state) {
  const sources = new Map()
  const add = (source) => {
    if (source && !sources.has(source.key)) sources.set(source.key, source)
  }
  const addText = (text) => {
    for (const url of collectMarkdownImages(text)) add(sourceForUrl(url))
  }

  for (const node of state.nodes ?? []) {
    for (const image of node.images ?? []) {
      if (!image || typeof image.attachmentId !== 'string') continue
      add({
        key: `attachment:${image.attachmentId}`,
        kind: 'attachment',
        sessionId: node.sessionId,
        attachmentId: image.attachmentId,
        mediaType: image.mediaType,
        name: image.name,
      })
    }
    addText(node.question)
    addText(node.answer)
  }
  for (const topic of state.topics ?? []) addText(topic.summary)
  return [...sources.values()]
}

function decodeDataUrl(url) {
  const match = String(url).match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
  if (!match) throw new Error('无法解析 data URL')
  const mediaType = match[1] || 'image/png'
  const payload = match[3] ?? ''
  if (match[2]) {
    const binary = atob(payload.replace(/\s+/g, ''))
    return { bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)), mediaType }
  }
  const text = decodeURIComponent(payload)
  return { bytes: new TextEncoder().encode(text), mediaType }
}

async function fetchRemote(url, fetchImpl, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer = setTimeout(() => controller?.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: controller?.signal,
      credentials: 'include',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const mediaType = response.headers.get('content-type')?.split(';')[0] || ''
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { bytes, mediaType }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve everything into `assets/` paths and bytes. DSH attachments are read
 * through the session API; remote/data URLs are best-effort. Failures become
 * warnings and never abort the export.
 */
export async function resolveImages(sources, { sessions, onProgress, fetchImpl = globalThis.fetch } = {}) {
  const map = new Map()
  const assets = []
  const warnings = []
  const usedNames = new Set()
  const seenKeys = new Set()
  let done = 0
  const total = sources.length
  const tick = () => {
    done += 1
    onProgress?.(done, total)
  }

  const addAsset = (source, bytes, mediaType, preferredName) => {
    if (!bytes || bytes.length === 0) {
      warnings.push(`图片为空：${preferredName || source.url || source.attachmentId}`)
      return
    }
    if (bytes.length > 50 * 1024 * 1024) {
      warnings.push(`图片过大，已跳过：${preferredName || source.attachmentId}`)
      return
    }
    const media = String(mediaType || source.mediaType || '').split(';')[0].trim().toLowerCase()
    let extension = extensionFromMedia(media)
    if (!extFromKnown(media)) {
      const named = extensionFromName(preferredName) || extensionFromName(source.url)
      if (named && MEDIA_BY_EXT[named]) extension = named
    }
    const rawName = String(preferredName || '').replace(/\.[a-z0-9]{2,5}$/i, '')
    const base = sanitizeSegment(rawName || 'image', 'image').slice(0, 36)
    let name = `image-${hashString(source.key)}-${base}.${extension}`
    let index = 2
    while (usedNames.has(name)) {
      name = `image-${hashString(source.key)}-${base}-${index}.${extension}`
      index += 1
    }
    usedNames.add(name)
    const path = `assets/${name}`
    assets.push({ path, bytes })
    map.set(source.key, path)
  }

  const attachmentsBySession = new Map()
  for (const source of sources) {
    if (source.kind !== 'attachment') continue
    const bucket = attachmentsBySession.get(source.sessionId) ?? []
    bucket.push(source)
    attachmentsBySession.set(source.sessionId, bucket)
  }

  if (attachmentsBySession.size > 0) {
    if (!sessions?.retain) {
      for (const group of attachmentsBySession.values()) {
        for (const source of group) {
          warnings.push(`DSH 附件读取不可用：${source.name || source.attachmentId}`)
          tick()
        }
      }
    } else {
      for (const [sessionId, group] of attachmentsBySession) {
        let reference
        try {
          reference = sessions.retain(sessionId, { source: 'ask-graph-export' })
          await reference.ready
          const session = reference.binding?.session
          if (!session || typeof session.readAttachment !== 'function') throw new Error('会话不支持读取附件')
          for (const source of group) {
            try {
              const result = await session.readAttachment(source.attachmentId)
              if (!result?.ok) throw new Error(result?.error?.message || '读取失败')
              addAsset(source, result.value.data, result.value.attachment?.mediaType || source.mediaType, source.name)
            } catch (error) {
              warnings.push(`图片未导出：${source.name || source.attachmentId}（${error?.message ?? error}）`)
            }
            seenKeys.add(source.key)
            tick()
          }
        } catch (error) {
          for (const source of group) {
            if (!seenKeys.has(source.key)) warnings.push(`图片未导出：${source.name || source.attachmentId}（${error?.message ?? error}）`)
          }
          for (const source of group) if (!seenKeys.has(source.key)) tick()
        } finally {
          try {
            reference?.release()
          } catch {
            // already released
          }
        }
      }
    }
  }

  for (const source of sources) {
    if (seenKeys.has(source.key) || source.kind === 'attachment') continue
    try {
      if (source.kind === 'data') {
        const { bytes, mediaType } = decodeDataUrl(source.url)
        addAsset(source, bytes, mediaType, 'image')
      } else if (source.kind === 'remote') {
        if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持下载远程图片')
        const { bytes, mediaType } = await fetchRemote(source.url, fetchImpl, 12_000)
        const fallbackName = source.url.split('/').pop()?.split('?')[0] || 'image'
        addAsset(source, bytes, mediaType, fallbackName)
      } else {
        warnings.push(`本地图片无法读取：${source.url}`)
      }
    } catch (error) {
      warnings.push(`图片未导出：${source.url}（${error?.message ?? error}）`)
    }
    tick()
  }

  return { map, assets, warnings: [...new Set(warnings)] }
}

function extFromKnown(media) {
  return Boolean(EXT_BY_MEDIA[media])
}
