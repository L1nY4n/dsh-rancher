import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const uiModule = '@deepseek-ai/dsh-client-ui-primitives'

await build({
  entryPoints: ['ui/client.jsx'], outfile: 'client.js', bundle: true, format: 'cjs',
  platform: 'browser', target: ['chrome110'], external: ['react', 'react-dom', uiModule],
  jsx: 'transform', minify: true,
  banner: { js: "window.__ModuleLoader__.load({id:'dsh-rancher',factory:(require)=>{const module={exports:{}};const exports=module.exports;" },
  footer: { js: 'return module.exports;}});' },
})
await mkdir('work/preview', { recursive: true })
// The installed plugin uses the host module. Only standalone previews compile
// the same upstream components and theme from a local DSH source checkout.
const source = path.resolve(process.env.DSH_SOURCE_DIR || '../deepseek-harness')
const primitives = path.join(source, 'packages/client/ui-primitives/src')
if (!existsSync(primitives)) {
  console.log('Client built. Set DSH_SOURCE_DIR to a DSH checkout to build the standalone preview.')
} else {
  const require = createRequire(import.meta.url)
  await build({
    entryPoints: ['ui/preview.jsx'], outfile: 'work/preview/app.js', bundle: true, format: 'esm',
    platform: 'browser', jsx: 'automatic', target: ['chrome110'], loader: { '.module.css': 'local-css' },
    alias: Object.fromEntries(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].map(id => [id, require.resolve(id)])),
    plugins: [{ name: 'dsh-preview-components', setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'controls', namespace: 'dsh-preview' }))
      build.onResolve({ filter: /^dsh-preview-theme$/ }, () => ({ path: 'theme', namespace: 'dsh-preview' }))
      build.onLoad({ filter: /.*/, namespace: 'dsh-preview' }, ({ path: entry }) => ({
        contents: entry === 'controls'
          ? ['Button', 'Input', 'Checkbox', 'Modal', 'Menu', 'MenuItemButton', 'SegmentedTabs', 'Tag', 'StateDot'].map(name => `export { ${name} } from ${JSON.stringify(path.join(primitives, `${name === 'MenuItemButton' ? 'Menu' : name}.tsx`))}`).join('\n')
          : ['base', 'design-platform', 'focus'].map(name => `import ${JSON.stringify(path.join(source, `packages/client/ui-theme/src/styles/${name}.css`))}`).join('\n'),
        loader: 'js', resolveDir: source,
      }))
    } }],
  })
}
