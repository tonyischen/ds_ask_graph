import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'dist')

const result = await build({
  entryPoints: [join(root, 'src', 'client.jsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  loader: { '.js': 'jsx', '.css': 'text' },
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'info',
})

const bundle = result.outputFiles[0].text

const wrapped = `window.__ModuleLoader__.load({
  id: "dsh-ask-graph",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${bundle}
    return module.exports;
  }
});
`

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'client.js'), wrapped, 'utf8')
console.log(`built dist/client.js (${wrapped.length} bytes)`)
