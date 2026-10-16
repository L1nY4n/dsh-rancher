import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { ConnectionStore } from '../src/store.js'
import { RancherManager } from '../src/manager.js'
import { createApi } from '../src/api.js'
import { mockRancher, fixtureState } from '../test/fixture.js'

const live = process.env.RANCHER_PREVIEW_MODE === 'live'
const fixture = live ? null : await mockRancher()
const secondaryState = fixtureState()
secondaryState.nodes = secondaryState.nodes.slice(0, 2).map((node, index) => ({ ...node, metadata: { ...node.metadata, name: `stage-worker-0${index + 1}`, uid: `uid-stage-${index}` } }))
const secondary = live ? null : await mockRancher({ state: secondaryState })
const directory = live ? null : fs.mkdtempSync(path.resolve('work/preview/state-'))
const store = live ? new ConnectionStore() : new ConnectionStore(directory)
if (!live) store.save({ name: '演示 Rancher', url: fixture.url, token: 'fixture-token', allowWrites: true })
if (!live) store.save({ name: '预发布 Rancher', url: secondary.url, authType: 'access-secret', accessKey: 'fixture-access', secretKey: 'fixture-secret', allowWrites: false })
const handler = createApi({ store, manager: new RancherManager(store) })
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname.startsWith('/api/rancher')) return handler(req, res)
  if (url.pathname === '/app.js' || url.pathname === '/app.css') {
    res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', 'cache-control': 'no-store' })
    return fs.createReadStream(`work/preview${url.pathname}`).pipe(res)
  }
  if (url.pathname !== '/') { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><html lang="zh-CN" data-live="${live}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rancher · DSH 插件预览</title><link rel="stylesheet" href="/app.css"><div id="app"></div><script type="module" src="/app.js"></script></html>`)
})
const requestedPort = Number(process.env.PORT || 4178)
server.on('error', error => {
  if (error.code === 'EADDRINUSE') server.listen(0, '127.0.0.1')
  else { console.error(error.message); process.exit(1) }
})
server.listen(requestedPort, '127.0.0.1', () => console.log(`Rancher ${live ? 'live preview' : 'demo'}: http://127.0.0.1:${server.address().port}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  server.close(); server.closeAllConnections(); await fixture?.close(); await secondary?.close()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  process.exit(0)
})
