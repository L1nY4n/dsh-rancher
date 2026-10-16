import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { ConnectionStore, normalizeUrl } from '../src/store.js'
import { RancherClient } from '../src/client.js'
import { RancherManager, READ_OPERATIONS, WRITE_OPERATIONS } from '../src/manager.js'
import { createApi, admission } from '../src/api.js'
import { toolsFor } from '../src/tools.js'
import { mockRancher } from './fixture.js'
import { quantity, containerResources } from '../src/resources.js'

async function setup(t, options) {
  const fixture = await mockRancher(options)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rancher-test-'))
  const store = new ConnectionStore(directory)
  const connection = store.save({ name: 'Test', url: fixture.url, token: 'fixture-token' })
  t.after(async () => { await fixture.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const manager = new RancherManager(store)
  const scope = { connectionId: connection.id, clusterId: 'c-demo' }
  return { ...fixture, store, connection, manager, scope, run: input => manager.run({ ...scope, ...input }) }
}

test('quantities retain cores/bytes, distinguish missing from zero and aggregate only complete container budgets', () => {
  for (const [text, expected] of [['250m', .25], ['250000000n', .25], ['125000u', .125], ['.5', .5], ['1e3', 1000], ['128Mi', 134217728], ['2Gi', 2147483648], ['1G', 1e9], ['0', 0]]) assert.ok(Math.abs(quantity(text) - expected) < 1e-6, text)
  for (const text of [undefined, null, '', 'NaN', '-1', '20bad']) assert.equal(quantity(text), null)
  const resources = containerResources([{ resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '1', memory: '128Mi' } } }, { resources: { requests: { cpu: '200m', memory: '32Mi' }, limits: { cpu: '2' } } }])
  assert.ok(Math.abs(resources.requests.cpuCores - .3) < 1e-10)
  assert.equal(resources.requests.memoryBytes, 96 * 1024 ** 2)
  assert.equal(resources.limits.cpuCores, 3)
  assert.equal(resources.limits.memoryBytes, null)
})

test('node/Pod metrics preserve namespace, sample time and per-container usage', async t => {
  const { run, state } = await setup(t)
  const nodes = await run({ operation: 'node-metrics', namespace: 'production' })
  assert.equal(nodes[0].cpuCores, .25)
  assert.equal(nodes[0].memoryBytes, 1024 ** 3)
  assert.equal(nodes[0].window, '30s')
  assert.ok(nodes[0].timestamp)
  const pods = await run({ operation: 'pod-metrics', namespace: 'kube-system' })
  assert.equal(pods.length, 1)
  assert.equal(pods[0].namespace, 'kube-system')
  assert.ok(Math.abs(pods[0].containers[0].cpuCores - .025) < 1e-10)
  assert.equal(pods[0].memoryBytes, 32 * 1024 ** 2)
  assert.match(state.calls.at(-1).path, /metrics.k8s.io\/v1beta1\/namespaces\/kube-system\/pods$/)
  const pod = (await run({ operation: 'pods', namespace: 'production' }))[0]
  assert.equal(pod.resources.requests.cpuCores, .1)
  assert.equal(pod.resources.limits.memoryBytes, 512 * 1024 ** 2)
  const node = (await run({ operation: 'nodes' }))[0]
  assert.equal(node.podCapacity, 110)
  assert.equal(node.capacity.memoryBytes, 16 * 1024 ** 3)
})

test('namespace filtering applies to each namespaced resource and node scope stays cluster-wide', async t => {
  const { run } = await setup(t)
  assert.deepEqual((await run({ operation: 'namespaces' })).map(item => item.name), ['kube-system', 'production'])
  assert.equal((await run({ operation: 'pods', namespace: 'kube-system' })).length, 1)
  assert.equal((await run({ operation: 'pods', namespace: 'production', node: 'worker-02' })).length, 1)
  for (const operation of ['deployments', 'services', 'events']) assert.equal((await run({ operation, namespace: 'kube-system' })).length, 0)
  assert.equal((await run({ operation: 'nodes', namespace: 'kube-system' })).length, 3)
})

test('missing, forbidden or unhealthy metrics API never breaks basic resource reads', async t => {
  for (const status of [403, 404, 503]) {
    const { run } = await setup(t, { handler: ({ url, send }) => {
      if (!url.pathname.includes('metrics.k8s.io')) return false
      send(status, { message: 'metrics unavailable' }); return true
    } })
    for (const operation of ['node-metrics', 'pod-metrics']) await assert.rejects(run({ operation }), error => error.status === status)
    assert.equal((await run({ operation: 'nodes' })).length, 3)
    assert.equal((await run({ operation: 'pods' })).length, 5)
  }
})

test('multiple namespaces union resource and metric lists, deduplicate and reject unsafe scopes', async t => {
  const { run, state } = await setup(t)
  for (const operation of ['pods', 'pod-metrics', 'deployments', 'services', 'events']) {
    const selected = await run({ operation, namespaces: ['production', 'kube-system', 'production'] })
    const all = await run({ operation })
    assert.equal(selected.length, all.length, operation)
    assert.deepEqual(new Set(selected.map(row => `${row.namespace}/${row.name}`)), new Set(all.map(row => `${row.namespace}/${row.name}`)))
  }
  assert.equal((await run({ operation: 'pods', namespaces: [] })).length, 5)
  assert.equal((await run({ operation: 'pods', namespaces: ['production', 'kube-system'], node: 'worker-02' })).length, 2)
  const before = state.calls.length
  for (const input of [{ namespaces: 'production' }, { namespaces: ['../secret'] }, { namespaces: ['production'], namespace: 'production' }, { namespaces: Array(101).fill('production') }, { operation: 'delete-pod', namespaces: ['production'] }]) {
    await assert.rejects(run({ operation: 'pods', ...input }))
  }
  assert.equal(state.calls.length, before, 'Invalid multi scopes must fail before network access')
})

test('Pod reads use small Kubernetes pages and retain the complete result', async t => {
  const pods = Array.from({ length: 205 }, (_, index) => ({ metadata: { name: `pod-${index}`, namespace: 'production', uid: `uid-${index}` }, spec: { containers: [{ name: 'main' }] }, status: { phase: 'Running' } }))
  const { run, state } = await setup(t, { handler: ({ url, send }) => {
    if (!url.pathname.endsWith('/api/v1/pods')) return false
    const start = Number(url.searchParams.get('continue') || 0)
    const limit = Number(url.searchParams.get('limit'))
    send(200, { items: pods.slice(start, start + limit), metadata: { continue: start + limit < pods.length ? String(start + limit) : '' } })
    return true
  } })
  const result = await run({ operation: 'pods' })
  assert.equal(result.length, 205)
  assert.deepEqual(state.calls.filter(call => call.path.endsWith('/api/v1/pods')).map(call => [call.query.limit, call.query.continue]), [['100', undefined], ['100', '100'], ['100', '200']])
})

test('Pod page endpoint requests only the selected Kubernetes chunk and preserves cursor history', async t => {
  const pods = Array.from({ length: 125 }, (_, index) => ({ metadata: { name: `pod-${index}`, namespace: 'production', uid: `uid-${index}` }, spec: { containers: [{ name: 'main', env: [{ name: 'SECRET', value: 'must-not-leak' }] }] }, status: { phase: 'Running' } }))
  const { store, manager, scope, state } = await setup(t, { handler: ({ url, send }) => {
    if (!url.pathname.endsWith('/api/v1/pods')) return false
    const start = Number(url.searchParams.get('continue') || 0), limit = Number(url.searchParams.get('limit'))
    send(200, { items: pods.slice(start, start + limit), metadata: { continue: start + limit < pods.length ? String(start + limit) : '' } })
    return true
  } })
  const server = http.createServer(createApi({ store, manager }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const read = async cursor => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rancher/pods/page`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...scope, pageSize: 50, cursor }) })
    assert.equal(response.status, 200)
    return (await response.json()).data
  }
  const first = await read(null)
  assert.equal(first.items.length, 50)
  assert.equal(JSON.stringify(first).includes('must-not-leak'), false)
  assert.deepEqual(state.calls.map(call => [call.query.limit, call.query.continue]), [['50', undefined]])
  const second = await read(first.nextCursor)
  const third = await read(second.nextCursor)
  assert.equal(second.items[0].name, 'pod-50')
  assert.equal(third.items.length, 25)
  assert.equal(third.nextCursor, null)
  assert.deepEqual(state.calls.map(call => [call.query.limit, call.query.continue]), [['50', undefined], ['50', '50'], ['50', '100']])
  assert.equal((await read(null)).items[0].name, 'pod-0')
})

test('Pod pages fill across selected namespaces without a phantom empty page', async t => {
  const { manager, scope, state } = await setup(t, { handler: ({ url, send }) => {
    if (!url.pathname.endsWith('/pods')) return false
    const namespace = url.pathname.match(/namespaces\/([^/]+)\/pods$/)?.[1]
    const pods = namespace === 'production' ? ['a', 'b'] : namespace === 'kube-system' ? ['c'] : []
    const start = Number(url.searchParams.get('continue') || 0), limit = Number(url.searchParams.get('limit'))
    send(200, { items: pods.slice(start, start + limit).map(name => ({ metadata: { name, namespace }, spec: { containers: [] }, status: { phase: 'Running' } })), metadata: { continue: start + limit < pods.length ? String(start + limit) : '' } })
    return true
  } })
  const input = { ...scope, namespaces: ['production', 'kube-system'], pageSize: 2 }
  const first = await manager.pagePods(input)
  assert.deepEqual(first.items.map(item => item.name), ['a', 'b'])
  assert.deepEqual(first.nextCursor, { index: 1, token: '' })
  const second = await manager.pagePods({ ...input, cursor: first.nextCursor })
  assert.deepEqual(second.items.map(item => item.name), ['c'])
  assert.equal(second.nextCursor, null)
  assert.deepEqual(state.calls.map(call => [call.path.includes('/production/'), call.query.limit, call.query.continue]), [[true, '2', undefined], [false, '1', undefined], [false, '2', undefined]])
  await assert.rejects(manager.pagePods({ ...input, cursor: { index: 99, token: '' } }), /游标/)
  await assert.rejects(manager.pagePods({ ...input, pageSize: 101 }), /每页条数/)
})

test('Pod page follows an empty chunk with a continue token and reports expired cursors', async t => {
  const { manager, scope, state } = await setup(t, { handler: ({ url, send }) => {
    if (!url.pathname.endsWith('/pods')) return false
    const token = url.searchParams.get('continue')
    if (token === 'expired') { send(410, { message: 'continue token expired' }); return true }
    if (!token) { send(200, { items: [], metadata: { continue: 'empty-first' } }); return true }
    send(200, { items: [{ metadata: { name: 'after-empty', namespace: 'production' }, spec: { containers: [] }, status: { phase: 'Running' } }], metadata: {} })
    return true
  } })
  const page = await manager.pagePods({ ...scope, pageSize: 25 })
  assert.deepEqual(page.items.map(item => item.name), ['after-empty'])
  assert.equal(page.nextCursor, null)
  assert.deepEqual(state.calls.map(call => call.query.continue), [undefined, 'empty-first'])
  await assert.rejects(manager.pagePods({ ...scope, cursor: { index: 0, token: 'expired' } }), error => error.status === 410 && /刷新 Pod 列表/.test(error.message))
})

test('Pod stream exposes the first page before later pages finish', async t => {
  let releaseSecond
  const second = new Promise(resolve => { releaseSecond = resolve })
  t.after(() => releaseSecond())
  const pods = Array.from({ length: 101 }, (_, index) => ({ metadata: { name: `pod-${index}`, namespace: 'production', uid: `uid-${index}` }, spec: { containers: [{ name: 'main', env: [{ name: 'SECRET', value: 'must-not-leak' }] }] }, status: { phase: 'Running' } }))
  const { store, manager, scope, state } = await setup(t, { handler: async ({ url, send }) => {
    if (!url.pathname.endsWith('/api/v1/pods')) return false
    const continued = Boolean(url.searchParams.get('continue'))
    if (continued) await second
    send(200, { items: continued ? pods.slice(100) : pods.slice(0, 100), metadata: { continue: continued ? '' : 'next' } })
    return true
  } })
  const server = http.createServer(createApi({ store, manager }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rancher/pods/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scope) })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /ndjson/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let first = ''
  while (!first.includes('\n')) first += decoder.decode((await reader.read()).value)
  const [firstLine, ...remaining] = first.split('\n')
  const page = JSON.parse(firstLine)
  assert.equal(page.type, 'page')
  assert.equal(page.items.length, 100)
  assert.equal(first.includes('must-not-leak'), false)
  releaseSecond()
  let rest = remaining.join('\n')
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    rest += decoder.decode(value)
  }
  assert.deepEqual(rest.trim().split('\n').map(line => JSON.parse(line).type), ['page', 'end'])
  assert.equal(JSON.parse(rest.trim().split('\n')[0]).items.length, 1)
  assert.ok(state.calls.filter(call => call.path.endsWith('/api/v1/pods')).every(call => call.query.limit === '100'))
})

test('multi-namespace errors never silently return a partial union', async t => {
  const { run } = await setup(t, { handler: ({ url, send }) => {
    if (url.pathname.includes('/namespaces/kube-system/')) { send(403, { message: 'kube-system forbidden' }); return true }
  } })
  await assert.rejects(run({ operation: 'pods', namespaces: ['production', 'kube-system'] }), /forbidden/)
})

test('snapshot and follow logs negotiate Kubernetes media types while reading plain text', async t => {
  const { run, manager, scope, state } = await setup(t, { handler: ({ req, res, url, send }) => {
    if (!url.pathname.endsWith('/log')) return false
    if (req.headers.accept !== 'application/json') {
      send(406, { message: 'only the following media types are accepted: application/json, application/yaml' })
      return true
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('plain log line\n')
    return true
  } })
  assert.equal((await run({ operation: 'logs', namespace: 'production', name: 'api' })).text, 'plain log line\n')
  const events = []
  await manager.streamLogs({ ...scope, namespace: 'production', name: 'api' }, undefined, event => events.push(event))
  assert.deepEqual(events.map(event => event.type), ['ready', 'log', 'end'])
  assert.equal(events[1].text, 'plain log line\n')
  assert.deepEqual(state.calls.filter(call => call.path.endsWith('/log')).map(call => call.accept), ['application/json', 'application/json'])
})

test('log time ranges reach snapshot and stream requests; invalid ranges never reach Rancher', async t => {
  const { run, manager, scope, state } = await setup(t, { handler: ({ res, url }) => {
    if (!url.pathname.endsWith('/log')) return false
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('recent log\n')
    return true
  } })
  await run({ operation: 'logs', namespace: 'production', name: 'api', sinceSeconds: 300, previous: true })
  await manager.streamLogs({ ...scope, namespace: 'production', name: 'api', sinceSeconds: 86400 }, undefined, () => {})
  assert.deepEqual(state.calls.filter(call => call.path.endsWith('/log')).map(call => call.query.sinceSeconds), ['300', '86400'])
  const count = state.calls.length
  for (const sinceSeconds of [0, -1, 1.5, '300', null, 86401]) {
    await assert.rejects(run({ operation: 'logs', namespace: 'production', name: 'api', sinceSeconds }), /时间范围/)
    await assert.rejects(manager.streamLogs({ ...scope, namespace: 'production', name: 'api', sinceSeconds }, undefined, () => {}), /时间范围/)
  }
  assert.equal(state.calls.length, count)
})

test('follow logs deliver incrementally, redact chunk boundaries and drop oversized lines', async t => {
  const { manager, scope, state } = await setup(t, { handler: ({ res, url }) => {
    if (!url.pathname.endsWith('/log')) return false
    res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first\nfixture-')
    const timer = setTimeout(() => { res.write('token Bearer split'); res.write('-secret\n' + 'x'.repeat(65537) + '\nlast'); res.end() }, 100)
    res.once('close', () => clearTimeout(timer))
    return true
  } })
  const events = []
  await manager.streamLogs({ ...scope, namespace: 'production', name: 'api', container: 'main', tailLines: 100 }, undefined, async event => events.push(event))
  assert.equal(events[0].type, 'ready')
  assert.equal(events[1].text, 'first\n')
  const text = events.filter(event => event.type === 'log').map(event => event.text).join('')
  assert.match(text, /\[REDACTED\] Bearer \[REDACTED\]/)
  assert.match(text, /超过 64 KiB/)
  assert.ok(text.endsWith('last'))
  assert.ok(text.length < 200)
  assert.equal(events.at(-1).type, 'end')
  assert.equal(state.calls.at(-1).query.follow, 'true')
  assert.equal(state.calls.at(-1).query.container, 'main')
  assert.equal(state.calls.at(-1).accept, 'application/json')
  const count = state.calls.length
  for (const input of [{ previous: true }, { tailLines: 0 }, { namespace: '' }, { name: '../secret' }]) await assert.rejects(manager.streamLogs({ ...scope, namespace: 'production', name: 'api', ...input }, undefined, async () => {}))
  assert.equal(state.calls.length, count)
})

test('stream API preserves admission, upstream errors and disconnect cancellation', async t => {
  let closed
  const disconnected = new Promise(resolve => { closed = resolve })
  const { store, manager, scope } = await setup(t, { handler: ({ res, url, send }) => {
    if (!url.pathname.endsWith('/log')) return false
    if (url.pathname.includes('/pods/forbidden/')) { send(403, { message: 'fixture-token forbidden' }); return true }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first live line\n')
    res.once('close', closed)
    return true
  } })
  let allowed = false
  const server = http.createServer(createApi({ store, manager, getConnection: () => ({ admit: () => allowed ? {} : { rejection: 401 } }) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const url = `http://127.0.0.1:${server.address().port}/api/rancher/logs/stream`
  const options = name => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...scope, namespace: 'production', name }) })
  assert.equal((await fetch(url, options('api'))).status, 401)
  allowed = true
  const forbidden = await fetch(url, options('forbidden'))
  assert.equal(forbidden.status, 403)
  assert.equal((await forbidden.text()).includes('fixture-token'), false)
  const abort = new AbortController()
  const response = await fetch(url, { ...options('api'), signal: abort.signal })
  assert.match(response.headers.get('content-type'), /ndjson/)
  const reader = response.body.getReader()
  let first = ''
  while (!first.includes('first live line')) first += new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /"type":"ready"/)
  abort.abort()
  let timeout
  await Promise.race([disconnected, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Upstream did not close')), 2000) })]).finally(() => clearTimeout(timeout))
  await reader.cancel().catch(() => {})
})

test('connection persistence masks credentials, keeps tokens and requires re-entry on host change', async t => {
  const { store, connection } = await setup(t)
  assert.equal(store.get(connection.id).allowWrites, false)
  assert.equal(JSON.stringify(store.list()).includes('fixture-token'), false)
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600)
  store.save({ ...connection, name: 'Renamed', token: '' })
  assert.equal(store.get(connection.id).token, 'fixture-token')
  assert.equal(new ConnectionStore(store.directory).get(connection.id).name, 'Renamed')
  assert.throws(() => store.save({ ...connection, url: 'https://other.example.com' }), /重新填写/)
  assert.throws(() => store.save({ ...connection, allowWrites: 'true' }), /布尔值/)
  assert.throws(() => normalizeUrl('http://rancher.example.com'), /HTTPS/)
  assert.equal(normalizeUrl('https://example.com/rancher/v3/'), 'https://example.com/rancher')
})

test('supports Rancher account password login and Access Key / Secret Key authentication', async t => {
  const fixture = await mockRancher()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rancher-auth-test-'))
  const store = new ConnectionStore(directory)
  t.after(async () => { await fixture.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const passwordConnection = store.save({ name: 'Password', url: fixture.url, authType: 'password', username: 'fixture-user', password: 'fixture-password' })
  const accessConnection = store.save({ name: 'Access key', url: fixture.url, authType: 'access-secret', accessKey: 'fixture-access', secretKey: 'fixture-secret' })
  const passwordManager = new RancherManager(store)
  const passwordClusters = await passwordManager.run({ connectionId: passwordConnection.id, operation: 'clusters' })
  const accessClusters = await passwordManager.run({ connectionId: accessConnection.id, operation: 'clusters' })
  assert.equal(passwordClusters[0].id, 'c-demo')
  assert.equal(accessClusters[0].id, 'c-demo')
  assert.equal(fixture.state.calls.find(call => call.path.includes('localProviders'))?.body.password, 'fixture-password')
  assert.equal(fixture.state.calls.find(call => call.path.includes('localProviders'))?.body.responseType, 'json')
  assert.equal(fixture.state.calls.find(call => call.path.includes('localProviders'))?.authorization, undefined)
  assert.equal(fixture.state.calls.find(call => call.authorization?.startsWith('Basic '))?.authorization, `Basic ${Buffer.from('fixture-access:fixture-secret').toString('base64')}`)
  assert.equal(JSON.stringify(store.list()).includes('fixture-password'), false)
  assert.equal(JSON.stringify(store.list()).includes('fixture-secret'), false)
})

test('multiple Rancher servers isolate credentials, matching cluster IDs and management operations', async t => {
  const basic = `Basic ${Buffer.from('fixture-access:fixture-secret').toString('base64')}`
  const only = authorization => ({ req, send }) => {
    if (req.headers.authorization !== authorization) { send(401, { message: 'Wrong server credential' }); return true }
  }
  const first = await mockRancher({ handler: only('Bearer fixture-token') })
  const second = await mockRancher({ handler: only(basic) })
  second.state.nodes[0].metadata.name = 'second-server-worker'
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rancher-multiple-'))
  t.after(async () => { await first.close(); await second.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const store = new ConnectionStore(directory)
  const a = store.save({ name: 'First', url: first.url, token: 'fixture-token', allowWrites: true })
  const b = store.save({ name: 'Second', url: second.url, authType: 'access-secret', accessKey: 'fixture-access', secretKey: 'fixture-secret' })
  const manager = new RancherManager(store)
  const run = (connectionId, input) => manager.run({ connectionId, clusterId: 'c-demo', ...input })
  assert.equal((await run(a.id, { operation: 'nodes' }))[0].name, 'worker-01')
  assert.equal((await run(b.id, { operation: 'nodes' }))[0].name, 'second-server-worker')
  await run(a.id, { operation: 'cordon', name: 'worker-01' })
  assert.equal(first.state.nodes[0].spec.unschedulable, true)
  assert.equal(second.state.nodes[0].spec.unschedulable, false)
  const calls = second.state.calls.length
  await assert.rejects(run(b.id, { operation: 'cordon', name: 'second-server-worker' }), /只读模式/)
  assert.equal(second.state.calls.length, calls)
  store.save({ ...b, name: 'Second renamed', secretKey: '' })
  assert.equal(store.get(a.id).token, 'fixture-token')
  assert.equal(store.get(b.id).secretKey, 'fixture-secret')
  assert.ok(first.state.calls.every(call => call.authorization === 'Bearer fixture-token'))
  assert.ok(second.state.calls.every(call => call.authorization === basic))
})

test('Rancher accepts self-signed mismatched certificates without changing host TLS verification', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rancher-tls-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const keyFile = path.join(directory, 'key.pem'), certFile = path.join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' })
  const fixture = await mockRancher({ tlsOptions: { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) } })
  t.after(() => fixture.close())
  const input = { name: 'Self-signed', url: fixture.url, authType: 'password', username: 'fixture-user', password: 'fixture-password' }
  const store = new ConnectionStore(path.join(directory, 'state'))
  const manager = new RancherManager(store)
  const result = await manager.testConnection(input)
  assert.equal(result.clusterCount, 1)
  const connection = store.save(input)
  assert.equal((await manager.run({ connectionId: connection.id, clusterId: 'c-demo', operation: 'nodes' })).length, 3)
  // Simulate an existing 0.2.3 connection with stale certificate settings on disk.
  store.persist({ connections: [{ ...store.get(connection.id), tlsFingerprint256: '00:'.repeat(31) + '00', tlsCa: 'obsolete CA' }] })
  const migrated = new ConnectionStore(store.directory)
  assert.equal((await new RancherManager(migrated).run({ connectionId: connection.id, clusterId: 'c-demo', operation: 'nodes' })).length, 3)
  assert.equal(migrated.list()[0].tlsFingerprint256, undefined)
  assert.equal(migrated.prepare({ ...connection }).tlsCa, undefined)
  const calls = fixture.state.calls.length
  await assert.rejects(new Promise((resolve, reject) => {
    https.get(fixture.url + '/v3/clusters', { agent: false }, resolve).on('error', reject)
  }), error => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT')
  assert.equal(fixture.state.calls.length, calls, 'Unrelated HTTPS clients still reject self-signed certificates')
})

test('Rancher login and resource reads accept omitted CA chains and expired certificates', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rancher-incomplete-chain-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = name => path.join(directory, name)
  const openssl = args => execFileSync('openssl', args, { stdio: 'ignore' })
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('ca.key'), '-out', file('ca.pem'), '-days', '2', '-subj', '/CN=Fixture CA'])
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('leaf.key'), '-out', file('leaf.csr'), '-subj', '/CN=localhost'])
  for (const expired of [false, true]) {
    openssl(['x509', '-req', '-in', file('leaf.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-set_serial', expired ? '2' : '1', '-days', expired ? '0' : '1', '-out', file('leaf.pem')])
    // Serve only the CA-signed leaf, as Rancher dynamiclistener does on the reported server.
    const fixture = await mockRancher({ tlsOptions: { key: fs.readFileSync(file('leaf.key')), cert: fs.readFileSync(file('leaf.pem')) } })
    t.after(() => fixture.close())
    const input = { name: 'Omitted chain', url: fixture.url, authType: 'password', username: 'fixture-user', password: 'fixture-password' }
    const store = new ConnectionStore(file(`state-${expired}`))
    const manager = new RancherManager(store)
    assert.equal((await manager.testConnection(input)).clusterCount, 1)
    const connection = store.save(input)
    assert.equal((await manager.run({ connectionId: connection.id, clusterId: 'c-demo', operation: 'pods' })).length, 5)
    assert.ok(fixture.state.calls.some(call => call.path.includes('localProviders')))
    assert.ok(fixture.state.calls.some(call => call.path.endsWith('/pods')))
  }
})

test('connection tests do not save drafts and failed verification cannot overwrite saved connections', async t => {
  const { store, manager, url } = await setup(t)
  const server = http.createServer(createApi({ store, manager }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const base = `http://127.0.0.1:${server.address().port}/api/rancher`
  const post = (route, input) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const draft = { name: 'Checked password', url, authType: 'password', username: 'fixture-user', password: 'fixture-password' }
  const before = fs.readFileSync(store.file, 'utf8')
  const tested = await post('/connections/test', draft)
  assert.equal(tested.status, 200)
  assert.equal((await tested.json()).data.clusterCount, 1)
  assert.equal(fs.readFileSync(store.file, 'utf8'), before)
  const failed = await post('/connections', { ...draft, password: 'wrong-password' })
  assert.equal(failed.status, 401)
  assert.equal(fs.readFileSync(store.file, 'utf8'), before)
  const saved = await post('/connections', draft)
  assert.equal(saved.status, 200)
  const body = await saved.text()
  assert.equal(JSON.parse(body).data.verification.authenticated, true)
  assert.equal(body.includes('fixture-password'), false)
  assert.equal(store.list().length, 2)
})

test('all resource reads use Rancher proxy, handle filters and never expose container environment', async t => {
  const { run, state } = await setup(t)
  for (const operation of READ_OPERATIONS.filter(op => !['pod', 'logs'].includes(op))) {
    assert.ok(Array.isArray(await run({ operation })), operation)
  }
  const pods = await run({ operation: 'pods', namespace: 'production', node: 'worker-01', labelSelector: 'app=api' })
  assert.equal(pods.length, 1)
  const pod = await run({ operation: 'pod', namespace: pods[0].namespace, name: pods[0].name })
  assert.equal(pod.uid, 'uid-api-7f44b8-x2k9p')
  assert.equal(JSON.stringify(pod).includes('must-not-be-returned'), false)
  const logs = await run({ operation: 'logs', namespace: pods[0].namespace, name: pods[0].name, container: 'main', previous: true, tailLines: 100 })
  assert.match(logs.text, /previous container instance/)
  assert.deepEqual(state.calls.at(-1).query, { tailLines: '100', timestamps: 'true', limitBytes: '524288', container: 'main', previous: 'true' })
  assert.ok(state.calls.every(call => call.authorization === 'Bearer fixture-token'))
  assert.equal((await run({ operation: 'pods' })).find(item => item.name.startsWith('worker-')).status, 'CrashLoopBackOff')
})

test('write operations reject read-only connections before any network request', async t => {
  const { run, state } = await setup(t)
  for (const operation of WRITE_OPERATIONS) await assert.rejects(run({ operation, namespace: 'production', name: 'api' }), /只读模式/)
  assert.equal(state.calls.length, 0)
})

test('management sends merge patches, UID preconditions, scale subresource and reads back state', async t => {
  const { store, connection, run, state } = await setup(t)
  store.save({ ...connection, allowWrites: true })
  await run({ operation: 'cordon', name: 'worker-01' })
  assert.equal((await run({ operation: 'nodes' }))[0].unschedulable, true)
  await run({ operation: 'uncordon', name: 'worker-01' })
  assert.equal(state.nodes[0].spec.unschedulable, false)
  await run({ operation: 'restart-deployment', namespace: 'production', name: 'api' })
  const restart = state.calls.at(-1)
  assert.equal(restart.contentType, 'application/merge-patch+json')
  assert.ok(restart.body.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'])
  await run({ operation: 'scale-deployment', namespace: 'production', name: 'api', replicas: 0 })
  assert.match(state.calls.at(-1).path, /\/deployments\/api\/scale$/)
  assert.equal((await run({ operation: 'deployments', namespace: 'production' }))[0].replicas, 0)
  const pod = (await run({ operation: 'pods' }))[0]
  await assert.rejects(run({ operation: 'delete-pod', ...pod, uid: 'old-uid' }), /UID/)
  await run({ operation: 'delete-pod', ...pod })
  assert.equal(state.calls.at(-1).body.preconditions.uid, pod.uid)
  assert.equal((await run({ operation: 'pods' })).length, 4)
})

test('invalid resource paths, incomplete mutations and malformed limits fail locally', async t => {
  const { run, store, connection } = await setup(t)
  store.save({ ...connection, allowWrites: true })
  for (const name of ['../secrets', 'foo/bar', 'https://evil.test', 'foo?x=y']) await assert.rejects(run({ operation: 'pod', namespace: 'production', name }), /无效/)
  await assert.rejects(run({ operation: 'logs', namespace: 'production', name: 'api', tailLines: -1 }), /行数/)
  await assert.rejects(run({ operation: 'delete-pod', namespace: 'production', name: 'api' }), /UID/)
  await assert.rejects(run({ operation: 'scale-deployment', namespace: 'production', name: 'api', replicas: 1.2 }), /副本数/)
  await assert.rejects(run({ operation: 'restart-deployment', name: 'api' }), /命名空间/)
})

test('Kubernetes continuation pages and Rancher pagination are fully collected', async t => {
  const { run } = await setup(t, { handler: ({ url, send }) => {
    if (url.pathname.endsWith('/pods')) {
      const continuation = url.searchParams.get('continue')
      send(200, { items: [{ metadata: { name: continuation ? 'second' : 'first' } }], metadata: continuation ? {} : { continue: 'page/2+=' } }); return true
    }
    if (url.pathname === '/v3/clusters') {
      const second = url.searchParams.has('marker')
      send(200, { data: [{ id: second ? 'c-2' : 'c-1' }], pagination: second ? {} : { next: '?marker=2' } }); return true
    }
  } })
  assert.deepEqual((await run({ operation: 'pods' })).map(item => item.name), ['first', 'second'])
  assert.deepEqual((await run({ operation: 'clusters' })).map(item => item.id), ['c-1', 'c-2'])
})

test('credentials never follow redirects or hostile pagination links', async t => {
  const { run } = await setup(t, { handler: ({ url, send }) => {
    if (url.pathname === '/v3/clusters') { send(200, { data: [], pagination: { next: 'https://evil.test/v3/clusters' } }); return true }
    if (url.pathname.endsWith('/nodes')) { send(302, {}); return true }
  } })
  await assert.rejects(run({ operation: 'clusters' }), /分页链接/)
  await assert.rejects(run({ operation: 'nodes' }), /重定向/)
})

test('upstream failures and log output redact the configured Rancher token', async t => {
  const { run } = await setup(t, { handler: ({ url, send }) => {
    if (url.pathname.endsWith('/nodes')) { send(403, { message: 'Access denied for fixture-token' }); return true }
    if (url.pathname.endsWith('/log')) { send(200, 'fixture-token Bearer other-secret'); return true }
  } })
  await assert.rejects(run({ operation: 'nodes' }), error => error.status === 403 && !error.message.includes('fixture-token'))
  assert.equal((await run({ operation: 'logs', namespace: 'production', name: 'api' })).text, '[REDACTED] Bearer [REDACTED]')
})

test('cancellation propagates through the downstream HTTP request', async t => {
  const { store, connection } = await setup(t, { handler: () => true })
  const controller = new AbortController()
  const pending = new RancherClient(store.get(connection.id)).request('v3/clusters', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /aborted/i)
})

test('HTTP routes use host admission and expose no tokens in connection responses', async t => {
  const { store, manager } = await setup(t)
  let allowed = false
  const server = http.createServer(createApi({ store, manager, getConnection: () => ({ admit: () => allowed ? {} : { rejection: 401 } }) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const base = `http://127.0.0.1:${server.address().port}/api/rancher`
  assert.equal((await fetch(`${base}/connections`)).status, 401)
  allowed = true
  const connections = await (await fetch(`${base}/connections`)).text()
  assert.equal(connections.includes('fixture-token'), false)
  assert.equal((await fetch(`${base}/run`, { method: 'POST', body: '{}' })).status, 415)
  assert.equal((await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400)
  assert.equal((await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId: store.list()[0].id, operation: 'clusters' }) })).status, 200)
})

test('trust fence supports old/new host admission and fails closed on unexpected services', () => {
  const req = { headers: { host: '127.0.0.1:4178', origin: 'http://127.0.0.1:4178' } }
  assert.equal(admission(req), undefined)
  assert.equal(admission({ headers: { ...req.headers, origin: 'https://evil.test' } }), 403)
  assert.equal(admission({ headers: { host: 'evil.test' } }), 403)
  assert.equal(admission({ headers: {} }), 403)
  assert.equal(admission(req, { requestRejection: () => 401 }), 401)
  assert.equal(admission(req, { admit: () => ({ rejection: 403 }) }), 403)
  assert.equal(admission(req, {}), 503)
  assert.equal(admission(req, { admit: () => { throw new Error('offline') } }), 503)
  assert.equal(admission({ headers: { host: '127.0.0.1:4178', referer: 'dsh-app://app/' } }), undefined)
})

test('DSH tools share management logic and isolate read and write surfaces', async t => {
  const { store, manager, scope } = await setup(t)
  const tools = toolsFor(store, manager)
  assert.equal(tools.length, 3)
  const read = tools.find(tool => tool.name === 'rancher_read')
  const result = await read.execute({ ...scope, operation: 'nodes' }, { signal: new AbortController().signal })
  assert.equal(JSON.parse(result.result).length, 3)
  assert.equal(read.output.render({}, result)[0].text, result.result)
  await assert.rejects(read.execute({ ...scope, operation: 'delete-pod' }), /只读工具/)
})
