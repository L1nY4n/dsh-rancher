// Explicit opt-in, read-only smoke test against the user's saved Rancher connection.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { ConnectionStore } from '../src/store.js'
import { RancherManager } from '../src/manager.js'

const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
const resultFile = new URL(`../work/live-results-${version}.json`, import.meta.url)
let stage = 'connection-selection'

async function main() {
const connectionName = process.env.RANCHER_LIVE_CONNECTION
assert.ok(connectionName, 'Set RANCHER_LIVE_CONNECTION to a saved connection name')
const store = new ConnectionStore()
const connection = store.list().find(item => item.name === connectionName)
assert.ok(connection, 'Saved connection not found')
const manager = new RancherManager(store)
stage = 'clusters'
const clusters = await manager.run({ connectionId: connection.id, operation: 'clusters' })
assert.ok(clusters.length)
const scope = { connectionId: connection.id, clusterId: clusters[0].id }
stage = 'namespaces'
const spaces = await manager.run({ ...scope, operation: 'namespaces' })
const namespaces = ['bip', 'kube-system'].filter(name => spaces.some(item => item.name === name))
assert.equal(namespaces.length, 2, 'This smoke test requires bip and kube-system')
stage = 'pods'
const pods = await manager.run({ ...scope, namespaces, operation: 'pods' })
assert.ok(pods.length && pods.every(item => namespaces.includes(item.namespace)))
stage = 'pod-metrics'
const metrics = await manager.run({ ...scope, namespaces, operation: 'pod-metrics' })
assert.ok(metrics.length && metrics.every(item => namespaces.includes(item.namespace)))
stage = 'nodes'
const nodes = await manager.run({ ...scope, operation: 'nodes' })
const counts = key => Object.fromEntries([...new Set(pods.map(row => row[key]))].map(value => [value, pods.filter(row => row[key] === value).length]))
const pod = pods.find(item => item.namespace === 'bip' && item.status === 'Running' && item.containerNames.length)
assert.ok(pod)
stage = 'streaming-logs'
const abort = new AbortController()
let ready = false, receivedCharacters = 0
const timer = setTimeout(() => abort.abort(), 15000)
try {
  await manager.streamLogs({ ...scope, namespace: pod.namespace, name: pod.name, container: pod.containerNames[0], tailLines: 10 }, abort.signal, event => {
    if (event.type === 'ready') ready = true
    if (event.type === 'log') { receivedCharacters += event.text.length; abort.abort() }
  })
} catch (error) { if (!abort.signal.aborted) throw error }
finally { clearTimeout(timer) }
assert.ok(ready && receivedCharacters > 0, 'Expected a successful live log stream')
const result = { passed: true, version, checkedAt: new Date().toISOString(), readOnly: true, connection: connection.name,
  cluster: scope.clusterId, namespaces, nodeCount: nodes.length, podCount: pods.length, metricCount: metrics.length,
  namespaceGroups: counts('namespace'), nodeGroups: counts('node'),
  streaming: { ready, receivedCharacters, cancellation: abort.signal.aborted, logTextRecorded: false } }
return result
}

let result
try { result = await main() }
catch (error) {
  const tlsDisconnected = /disconnected before secure TLS connection was established/.test(error.message || '')
  result = { passed: false, version, checkedAt: new Date().toISOString(), readOnly: true,
    stage, remoteMutations: 0, streamingVerified: false,
    error: { status: error.status || null, code: tlsDisconnected ? 'TLS_HANDSHAKE_DISCONNECTED' : 'LIVE_CHECK_FAILED',
      message: tlsDisconnected ? 'Connection disconnected before TLS handshake completed' : 'Live read check failed; credentials and upstream response omitted' } }
  process.exitCode = 1
}
await mkdir(new URL('../work/', import.meta.url), { recursive: true })
await writeFile(resultFile, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
