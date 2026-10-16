import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../index.js'

test('real Cordis activates nested host services and disposes all routes and tools', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rancher-cordis-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); fs.rmSync(directory, { recursive: true, force: true }) })
  const routes = new Map(), tools = new Map()
  class WebServer extends Service {
    constructor(ctx) { super(ctx, 'webServer') }
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) }
  }
  class Tools extends Service {
    constructor(ctx) { super(ctx, 'tools') }
    register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) }
  }
  // The plugin must survive services being provided after it loads.
  const fiber = await ctx.plugin(plugin, { dataDir: directory })
  assert.equal(routes.size, 0)
  await ctx.plugin(WebServer)
  await ctx.plugin(Tools)
  // Cordis nested inject fibers settle asynchronously.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(routes.size, 1)
  assert.deepEqual([...tools.keys()], ['rancher_connections', 'rancher_read', 'rancher_manage'])
  await fiber.dispose()
  assert.equal(routes.size, 0)
  assert.equal(tools.size, 0)
})

test('built browser registers an independent workbench, sidebar entry and connection settings', () => {
  let plugin, removed = false
  const descriptors = []
  const requested = []
  const react = { createContext: () => ({}), forwardRef: () => () => {}, createElement: (...args) => ({ args }), Fragment: Symbol('Fragment') }
  const globals = {
    window: { __ModuleLoader__: { load: entry => {
      assert.equal(entry.id, 'dsh-rancher')
      plugin = entry.factory(id => {
        requested.push(id)
        if (id === 'react') return react
        assert.equal(id, '@deepseek-ai/dsh-client-ui-primitives')
        return Object.fromEntries(['Button', 'Input', 'Checkbox', 'Modal', 'Menu', 'SegmentedTabs', 'Tag', 'StateDot'].map(name => [name, () => null]))
      })
    } } },
    document: { createElement: () => ({ setAttribute() {}, remove() { removed = true } }), head: { appendChild() {} } },
  }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), globals)
  assert.ok(requested.includes('@deepseek-ai/dsh-client-ui-primitives'), 'Controls must resolve from the DSH module table')
  assert.deepEqual([...plugin.inject], ['slots', 'layout'])
  const effects = []
  plugin.apply({ effect: effect => effects.push(effect()), slots: { inject: (_name, register) => register(), register: value => { descriptors.push(value) } }, layout: { selectPanel() {} } })
  assert.deepEqual(descriptors.map(value => value.name), ['main', 'sidebar.panellist', 'settings.section'])
  assert.equal(descriptors[0].key, 'rancher')
  assert.equal(descriptors[1].id, 'rancher')
  assert.equal(descriptors[1].label(), 'Rancher')
  assert.equal(descriptors[2].id, 'rancher')
  effects.forEach(dispose => dispose?.())
  assert.equal(removed, true)
})
