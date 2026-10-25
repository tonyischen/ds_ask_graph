/**
 * Dev smoke test: load dist/client.js the way the Web module loader does,
 * then apply it against a stub Cordis context. Catches module-load and
 * registration-shape errors without a browser.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const code = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

let factory
const windowStub = {
  __ModuleLoader__: {
    load(options) {
      factory = options.factory
      windowStub.__moduleId = options.id
    },
  },
}
const documentStub = {
  createElement: () => ({ dataset: {}, remove() {}, textContent: '' }),
  head: { append() {} },
}
globalThis.window = windowStub
globalThis.document = documentStub

new Function('window', code)(windowStub)
assert.equal(typeof factory, 'function', 'module loader factory was not registered')
const exports = factory(require)
assert.equal(typeof exports.apply, 'function', 'apply() missing from client half')
assert.equal(windowStub.__moduleId, 'dsh-ask-graph')

const registrations = []
const noop = () => () => {}
const snapshot = (value) => ({ getSnapshot: () => value, subscribe: noop })
const ctx = {
  effect: (run) => {
    const dispose = run()
    return () => dispose?.()
  },
  slots: {
    inject: (_name, run) => run(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  sessions: { list: snapshot({ ids: [], byId: {}, phase: 'ready' }) },
  workspaces: { list: snapshot({ items: [], archivedSessionIds: [] }) },
  uiWorkspace: {
    startSession() {},
    openSession() {},
    connectWorkspace: async () => undefined,
    archiveSession: async () => {},
  },
}

exports.apply(ctx)
const names = registrations.map((item) => item.options.name)
assert.deepEqual(names, ['conversation.view'], 'only the conversation view should be registered')
const view = registrations[0]
assert.equal(view.options.id, 'ask-graph')
assert.equal(view.options.label(), '提问图谱')
assert.equal(view.options.order, 25)
assert.equal(typeof view.component, 'function')
console.log('smoke ok:', names.join(', '))
