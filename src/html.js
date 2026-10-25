import { formatTime, serialParallelEdges, stripMarker, topicNodes, topicSpan } from './core.js'
import { rewriteMarkdownImages, sanitizeSegment } from './bluepin.js'
import { buildQuestionSvg, buildTopicSvg } from './svg.js'

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const safeId = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_')

function safeHref(value) {
  const url = String(value ?? '').trim()
  if (!url) return '#'
  if (/^(https?:|mailto:|#|data:image\/)/i.test(url)) return url
  return '#'
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function mimeFromPath(path) {
  const extension = String(path).split('.').pop()?.toLowerCase()
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      svg: 'image/svg+xml',
    }[extension] || 'application/octet-stream'
  )
}

function assetDataUrls(assets) {
  const map = new Map()
  for (const asset of assets.assets ?? []) {
    if (!asset?.bytes) continue
    map.set(asset.path, `data:${mimeFromPath(asset.path)};base64,${bytesToBase64(asset.bytes)}`)
  }
  return map
}

function imageTag(src, alt, dataUrls) {
  const resolved = dataUrls.get(src) || (/^(https?:|data:)/i.test(src) ? src : '')
  if (!resolved) return `<span class="missing-image">[图片未导出：${escapeHtml(alt || src)}]</span>`
  return `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(alt || '图片')}" loading="lazy">`
}

function inlineMarkdown(text, dataUrls) {
  let value = escapeHtml(text)
  value = value.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, alt, url) =>
    imageTag(url, alt, dataUrls),
  )
  value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const href = safeHref(url)
    return href === '#' ? label : `<a href="${escapeHtml(href)}">${label}</a>`
  })
  value = value.replace(/`([^`]+)`/g, '<code>$1</code>')
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  value = value.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  return value
}

function renderMarkdown(text, dataUrls) {
  const source = String(text ?? '')
  const parts = source.split(/(```[\s\S]*?```)/g)
  const out = []
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (index % 2 === 1) {
      const body = part.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')
      out.push(`<pre><code>${escapeHtml(body)}</code></pre>`)
      continue
    }
    const lines = part.split(/\r?\n/)
    let paragraph = []
    let list = ''
    const flushParagraph = () => {
      if (paragraph.length === 0) return
      out.push(`<p>${paragraph.map((line) => inlineMarkdown(line, dataUrls)).join('<br>')}</p>`)
      paragraph = []
    }
    const flushList = () => {
      if (list) out.push(`<ul>${list}</ul>`)
      list = ''
    }
    for (const line of lines) {
      if (!line.trim()) {
        flushParagraph()
        flushList()
        continue
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/)
      if (heading) {
        flushParagraph()
        flushList()
        const level = Math.min(6, heading[1].length + 1)
        out.push(`<h${level}>${inlineMarkdown(heading[2], dataUrls)}</h${level}>`)
        continue
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        flushParagraph()
        const item = line.replace(/^\s*([-*+]|\d+\.)\s+/, '')
        list += `<li>${inlineMarkdown(item, dataUrls)}</li>`
        continue
      }
      if (/^\s*>\s?/.test(line)) {
        flushParagraph()
        flushList()
        out.push(`<blockquote>${inlineMarkdown(line.replace(/^\s*>\s?/, ''), dataUrls)}</blockquote>`)
        continue
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        flushParagraph()
        flushList()
        out.push('<hr>')
        continue
      }
      flushList()
      paragraph.push(line)
    }
    flushParagraph()
    flushList()
  }
  return out.join('\n')
}

function questionLabel(question, limit = 46) {
  const text = stripMarker(question).replace(/\s+/g, ' ').trim() || '图片提问'
  const chars = Array.from(text)
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('')
}

function statusText(status) {
  return status === 'done' ? '已回复' : status === 'pending' ? '等待回复' : '暂无回复'
}

function relationMap(state) {
  const outgoing = new Map()
  const incoming = new Map()
  for (const edge of serialParallelEdges(state)) {
    const out = outgoing.get(edge.source) ?? []
    out.push(edge)
    outgoing.set(edge.source, out)
    const inc = incoming.get(edge.target) ?? []
    inc.push(edge)
    incoming.set(edge.target, inc)
  }
  return { outgoing, incoming }
}

function nodeImagesHtml(node, assets, dataUrls) {
  const images = []
  for (const image of node.images ?? []) {
    const path = assets.map?.get?.(`attachment:${image.attachmentId}`)
    const data = path ? dataUrls.get(path) : undefined
    if (data) images.push(`<figure><img src="${data}" alt="${escapeHtml(image.name || '图片')}" loading="lazy"></figure>`)
  }
  return images.join('')
}

export function buildHtmlReport(state, { workspaceTitle = '工作区', assets = {}, now = Date.now() } = {}) {
  const topics = (state.topics ?? []).filter((topic) => topicNodes(state, topic.id).length > 0)
  const byId = new Map(topics.map((topic) => [topic.id, topic]))
  const dataUrls = assetDataUrls(assets)
  const relations = relationMap(state)
  const topicHref = (id) => `#topic-${safeId(id)}`
  const questionHref = (id) => `#q-${safeId(id)}`
  const title = `提问图谱 · ${workspaceTitle}`

  const topicSvg = buildTopicSvg(state, {
    title: `${workspaceTitle} · 专题图`,
    hrefForTopic: topicHref,
    idPrefix: 'html-topics',
  })

  const outline = topics
    .map((topic) => {
      const questions = topicNodes(state, topic.id)
      return [
        `<li class="outline-topic"><a href="${topicHref(topic.id)}">${escapeHtml(topic.title)}</a>`,
        '<ol>',
        ...questions.map((node) => `<li><a href="${questionHref(node.id)}">${escapeHtml(questionLabel(node.question, 32))}</a></li>`),
        '</ol></li>',
      ].join('')
    })
    .join('')

  const sections = topics
    .map((topic) => {
      const nodes = topicNodes(state, topic.id)
      const span = topicSpan(state, topic.id)
      const spanText = span ? `${formatTime(span.start)} ~ ${formatTime(span.end)}` : '暂无时间'
      const svg = buildQuestionSvg(state, topic.id, {
        title: `${topic.title} · 问题图`,
        hrefForNode: questionHref,
        idPrefix: `html-q-${safeId(topic.id)}`,
      })
      const out = relations.outgoing.get(topic.id) ?? []
      const inc = relations.incoming.get(topic.id) ?? []
      const relationLinks = [
        ...out.map((edge) => {
          const target = byId.get(edge.target)
          return target ? `<a href="${topicHref(target.id)}">后续：${escapeHtml(target.title)}</a>（${edge.kind === 'parallel' ? '并行' : '串行'}）` : ''
        }),
        ...inc.map((edge) => {
          const target = byId.get(edge.source)
          return target ? `<a href="${topicHref(target.id)}">前序：${escapeHtml(target.title)}</a>（${edge.kind === 'parallel' ? '并行' : '串行'}）` : ''
        }),
      ]
        .filter(Boolean)
        .join(' · ')

      const questionHtml = nodes
        .map((node, index) => {
          const previous = index > 0 ? nodes[index - 1] : undefined
          const next = index + 1 < nodes.length ? nodes[index + 1] : undefined
          const summary = node.answer ? renderMarkdown(rewriteMarkdownImages(node.answer, assets.map), dataUrls) : '<p>暂无回复。</p>'
          const images = nodeImagesHtml(node, assets, dataUrls)
          return [
            `<article class="question" id="q-${safeId(node.id)}">`,
            `<h4>${index + 1}. ${escapeHtml(questionLabel(node.question, 80))}</h4>`,
            `<div class="meta"><span>${escapeHtml(formatTime(node.at) || '未知时间')}</span><span>${statusText(node.status)}</span></div>`,
            `<div class="question-text">${renderMarkdown(rewriteMarkdownImages(stripMarker(node.question), assets.map), dataUrls)}</div>`,
            images,
            '<div class="answer"><h5>DSH 回复</h5>',
            summary,
            '</div>',
            '<div class="chain">',
            previous ? `<a href="${questionHref(previous.id)}">← 上一问：${escapeHtml(questionLabel(previous.question, 32))}</a>` : '<span>← 上一问：无</span>',
            next ? `<a href="${questionHref(next.id)}">下一问：${escapeHtml(questionLabel(next.question, 32))} →</a>` : '<span>下一问：无 →</span>',
            '</div></article>',
          ].join('')
        })
        .join('')

      return [
        `<section class="topic" id="topic-${safeId(topic.id)}">`,
        `<h2>${escapeHtml(topic.title)}</h2>`,
        `<div class="meta"><span>${nodes.length} 个问题</span><span>${escapeHtml(spanText)}</span></div>`,
        topic.keywords?.length ? `<div class="keywords">${topic.keywords.map((word) => `<span>${escapeHtml(word)}</span>`).join('')}</div>` : '',
        topic.summary ? `<div class="summary">${renderMarkdown(rewriteMarkdownImages(topic.summary, assets.map), dataUrls)}</div>` : '',
        relationLinks ? `<div class="relations">${relationLinks}</div>` : '',
        '<div class="graph">',
        svg,
        '</div>',
        '<h3>问题</h3>',
        questionHtml,
        `<div class="back"><a href="#top">↑ 回到顶部</a> · <a href="${topicHref(topic.id)}">本专题顶部</a></div>`,
        '</section>',
      ].join('')
    })
    .join('')

  const stats = `${topics.length} 个专题 · ${topics.reduce((sum, topic) => sum + topicNodes(state, topic.id).length, 0)} 个问题`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light;--bg:#f7f9fc;--panel:#fff;--text:#17233d;--muted:#64748b;--border:#dfe5ef;--accent:#2563eb}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.layout{display:flex;gap:24px;max-width:1500px;margin:0 auto;padding:24px}
aside{position:sticky;top:24px;align-self:flex-start;width:290px;max-height:calc(100vh - 48px);overflow:auto;padding:16px;border:1px solid var(--border);border-radius:14px;background:var(--panel)}
aside h1{font-size:17px;margin:0 0 4px}aside .sub{color:var(--muted);font-size:11px;margin-bottom:12px}
#search{width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:8px;margin-bottom:12px;font:inherit;background:var(--bg);color:var(--text)}
.outline{list-style:none;margin:0;padding:0}.outline ol{list-style:none;margin:2px 0 10px 10px;padding:0;border-left:1px solid var(--border)}
.outline li{margin:3px 0;font-size:12px}.outline ol li{padding-left:8px}.outline a{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{flex:1;min-width:0}.hero,.topic{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:20px}
.hero h1{margin:0 0 6px;font-size:24px}.hero .sub{color:var(--muted)}.hero .graph{margin-top:16px}
.graph{overflow:auto;border:1px solid var(--border);border-radius:10px;background:var(--bg)}
.graph svg{display:block;max-width:100%;height:auto}.topic h2{margin:0 0 4px;font-size:20px}.topic h3{margin:22px 0 8px;font-size:15px}
.meta{display:flex;gap:14px;color:var(--muted);font-size:12px}.keywords{margin:8px 0}.keywords span{display:inline-block;margin:2px 5px 2px 0;padding:1px 7px;border-radius:999px;background:#eef4ff;color:var(--accent);font-size:11px}
.summary{margin:10px 0;padding:10px 12px;border-left:3px solid var(--accent);background:#f8fbff;border-radius:4px}
.relations{margin:8px 0 12px;font-size:12px;color:var(--muted)}
.question{border-top:1px solid var(--border);padding-top:16px;margin-top:16px}.question h4{margin:0 0 4px;font-size:15px}
.question-text,.answer{overflow-wrap:anywhere}.answer{margin-top:8px}.answer h5{margin:0 0 6px;font-size:12px;color:var(--muted)}
.chain{display:flex;justify-content:space-between;gap:12px;margin-top:10px;font-size:12px}
figure{margin:10px 0}figure img{max-width:100%;border:1px solid var(--border);border-radius:8px}
img{max-width:100%}pre{overflow:auto;padding:10px;background:#0f172a;color:#e2e8f0;border-radius:8px}code{font-family:ui-monospace,Consolas,monospace;font-size:12px}
blockquote{margin:8px 0;padding:4px 12px;border-left:3px solid var(--border);color:var(--muted)}.missing-image{color:#b45309;font-size:12px}
.back{margin-top:16px;font-size:12px}.topic[hidden],.question[hidden]{display:none}
@media(max-width:900px){.layout{display:block;padding:12px}aside{position:static;width:auto;max-height:none;margin-bottom:16px}}
</style>
</head>
<body>
<a id="top"></a>
<div class="layout">
<aside>
<h1>${escapeHtml(workspaceTitle)}</h1>
<div class="sub">${escapeHtml(stats)} · ${escapeHtml(formatTime(now))}</div>
<input id="search" type="search" placeholder="搜索专题或问题…" autocomplete="off">
<ol class="outline">${outline}</ol>
</aside>
<main>
<div class="hero">
<h1>${escapeHtml(title)}</h1>
<div class="sub">${escapeHtml(stats)} · 生成于 ${escapeHtml(formatTime(now))}</div>
<div class="graph">${topicSvg}</div>
</div>
${sections}
</main>
</div>
<script>
(function(){
  var input=document.getElementById('search');
  var topics=Array.prototype.slice.call(document.querySelectorAll('.topic'));
  input.addEventListener('input',function(){
    var q=input.value.trim().toLowerCase();
    topics.forEach(function(topic){
      var questions=Array.prototype.slice.call(topic.querySelectorAll('.question'));
      var visible=0;
      questions.forEach(function(question){
        var hit=!q||question.textContent.toLowerCase().indexOf(q)>=0;
        question.hidden=!hit;
        if(hit)visible++;
      });
      var titleHit=!q||topic.querySelector('h2').textContent.toLowerCase().indexOf(q)>=0;
      topic.hidden=!!q&&!titleHit&&visible===0;
    });
  });
})();
</script>
</body>
</html>`
}

export function htmlDownloadName(workspaceTitle, now = Date.now()) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `${sanitizeSegment(workspaceTitle, '提问图谱')}-提问图谱-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.html`
}
