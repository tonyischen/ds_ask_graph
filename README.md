# 提问图谱（dsh-ask-graph）

把 DeepSeek Harness（DSH）工作区里的会话历史整理成可下钻的**专题图 / 问题图**。

## 功能

- 读取当前工作区的会话历史，按功能/语义归入专题。
- 专题总览按时间形成串行/并行有向图；点击专题进入问题子图。
- 问题按时间串联，点击节点在右侧查看完整问题与 DSH 回复。
- 支持「智能整理」：调用当前 DSH 模型按上下文语义重组专题。
- 支持搜索定位、手动归类、专题总结、在原会话中定位问题。
- 导出：
  - **HTML**：大纲 + 专题/问题有向图 + 完整内容 + 内部链接，单文件离线打开。
  - **SVG**：专题总览图 + 每个专题的问题图。
  - **Bluepin Vault**：标准 `pages/`、`assets/`、`daily/` 目录，带 wiki 链接、图片与 SVG 图。

## 环境

- DSH `0.2.1` 系列（Web / Desktop 客户端）。
- 插件是 Client 插件；数据保存在浏览器 `localStorage`，按工作区隔离。
- 智能整理会把问题与回复发送给当前配置的 DSH 模型；其余功能本地运行。

## 开发

```bash
pnpm install
pnpm build
pnpm test
node scripts/smoke.mjs
```

构建产物：`dist/client.js`。

## 安装

在 DSH 插件管理器中安装本包，或：

```bash
dsh plugin --profile web add dsh-ask-graph
```

从本地源码调试时，可使用插件管理器的 `install_bundle`（目录路径）或 profile 的 `link:` 依赖。

## 目录

```
src/
  client.jsx      插件入口与 View 注册
  ui.jsx          图谱、详情面板、交互
  core.js         事件配对、专题归类、布局
  graph.js        dagre 布局
  semantic.js     智能整理提示词与解析
  bluepin.js      Bluepin vault 生成
  html.js         HTML 报告
  svg.js          专题/问题 SVG
  images.js       DSH 附件与 Markdown 图片解析
  zip.js          无依赖 ZIP writer
tests/            单元测试
```
