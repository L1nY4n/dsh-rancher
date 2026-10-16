import http from 'node:http'
import https from 'node:https'

const created = new Date(Date.now() - 3 * 86400000).toISOString()
const metadata = (name, namespace) => ({ name, namespace, uid: `uid-${name}`, creationTimestamp: created })

export function fixtureState() {
  const nodes = ['worker-01', 'worker-02', 'control-01'].map((name, index) => ({ metadata: { ...metadata(name), labels: { [`node-role.kubernetes.io/${index === 2 ? 'control-plane' : 'worker'}`]: 'true' } },
    spec: { unschedulable: false }, status: { conditions: [{ type: 'Ready', status: index === 1 ? 'False' : 'True', reason: index === 1 ? 'KubeletNotReady' : 'KubeletReady' }],
      addresses: [{ type: 'InternalIP', address: `10.42.0.${index + 11}` }], nodeInfo: { kubeletVersion: 'v1.31.5+rke2r1', osImage: 'Ubuntu 24.04 LTS', architecture: 'amd64', containerRuntimeVersion: 'containerd://1.7.24' }, capacity: { cpu: '8', memory: '16Gi' }, allocatable: { cpu: '8', memory: '15870976Ki', pods: '110' } } }))
  const pods = ['api-7f44b8-x2k9p', 'web-69f6c7-m8v2n', 'redis-0', 'worker-6f755-p4m6t', 'coredns-6b6889-q2z7r'].map((name, index) => ({ metadata: { ...metadata(name, index === 4 ? 'kube-system' : 'production'), labels: { app: name.split('-')[0] }, ownerReferences: [{ kind: 'ReplicaSet', name: name.split('-')[0] }] },
    spec: { nodeName: nodes[index % 3].metadata.name, containers: [{ name: 'main', image: 'registry.example.com/app:1.4.2', resources: { requests: { cpu: '100m', memory: '128Mi' }, ...(index === 4 ? {} : { limits: { cpu: '1', memory: '512Mi' } }) }, env: [{ name: 'PASSWORD', value: 'must-not-be-returned' }] }], initContainers: [{ name: 'init', image: 'busybox:1.37' }] },
    status: { phase: 'Running', podIP: `10.42.2.${index + 3}`, qosClass: 'Burstable', containerStatuses: [{ name: 'main', ready: index !== 3, restartCount: index === 3 ? 12 : 0, state: index === 3 ? { waiting: { reason: 'CrashLoopBackOff' } } : { running: { startedAt: created } } }] } }))
  const deployments = ['api', 'web', 'worker'].map((name, index) => ({ metadata: metadata(name, 'production'),
    spec: { replicas: 3, template: { spec: { containers: [{ name, image: `registry.example.com/${name}:1.4.2` }] } } }, status: { readyReplicas: index === 2 ? 2 : 3, availableReplicas: index === 2 ? 2 : 3 } }))
  return { nodes, pods, deployments, calls: [] }
}

export async function mockRancher({ state = fixtureState(), handler, tlsOptions } = {}) {
  const handle = async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    const url = new URL(req.url, 'http://localhost')
    state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, authorization: req.headers.authorization, accept: req.headers.accept, contentType: req.headers['content-type'] })
    const send = (status, value) => { res.writeHead(status, { 'content-type': typeof value === 'string' ? 'text/plain' : 'application/json' }); res.end(typeof value === 'string' ? value : JSON.stringify(value)) }
    if (handler && await handler({ req, res, url, body, send })) return
    if (url.pathname === '/v3-public/localProviders/local' && req.method === 'POST' && url.searchParams.get('action') === 'login') {
      if (body?.username === 'fixture-user' && body?.password === 'fixture-password') return send(201, body.responseType === 'json' ? { token: 'fixture-session-token' } : {})
      return send(401, { message: 'Invalid username or password' })
    }
    const basic = `Basic ${Buffer.from('fixture-access:fixture-secret').toString('base64')}`
    if (!['Bearer fixture-token', 'Bearer fixture-session-token', basic].includes(req.headers.authorization)) return send(401, { message: 'Unauthorized' })
    if (url.pathname === '/v3/clusters') return send(200, { data: [{ id: 'c-demo', name: 'production-rke2', state: 'active', nodeCount: 3, version: { gitVersion: 'v1.31.5+rke2r1' } }] })
    const path = url.pathname.replace('/k8s/clusters/c-demo/', '')
    if (!url.pathname.startsWith('/k8s/clusters/c-demo/')) return send(404, { message: 'Cluster not found' })
    const namespace = path.match(/namespaces\/([^/]+)\//)?.[1]
    const items = array => array.filter(item => !namespace || item.metadata.namespace === namespace)
    const list = items => send(200, { items, metadata: {} })
    if (req.method === 'GET') {
      if (path.startsWith('apis/metrics.k8s.io/')) {
        const timestamp = new Date().toISOString(), window = '30s'
        if (path.endsWith('/nodes')) return list(state.nodes.map((node, index) => ({ metadata: node.metadata, timestamp, window, usage: { cpu: `${(index + 1) * 250000000}n`, memory: `${(index + 1) * 1048576}Ki` } })))
        if (path.endsWith('/pods')) return list(items(state.pods).map((pod, index) => ({ metadata: pod.metadata, timestamp, window, containers: [{ name: 'main', usage: { cpu: `${(index + 1) * 25000000}n`, memory: `${(index + 1) * 32768}Ki` } }] })))
      }
      if (path === 'api/v1/namespaces') return list(['production', 'kube-system'].map(name => ({ metadata: { ...metadata(name), annotations: { 'field.cattle.io/projectId': 'c-demo:p-production' }, labels: { 'kubernetes.io/metadata.name': name } }, status: { phase: 'Active' } })))
      if (path === 'api/v1/nodes') return list(state.nodes)
      if (path.endsWith('/pods')) {
        let filtered = items(state.pods)
        const node = url.searchParams.get('fieldSelector')?.split('=')[1]
        const label = url.searchParams.get('labelSelector')?.split('=')
        if (node) filtered = filtered.filter(item => item.spec.nodeName === node)
        if (label) filtered = filtered.filter(item => item.metadata.labels?.[label[0]] === label[1])
        return list(filtered)
      }
      if (path.endsWith('/deployments')) return list(items(state.deployments))
      if (path.endsWith('/services')) return list(items([{ metadata: metadata('api', 'production'), spec: { type: 'ClusterIP', clusterIP: '10.43.22.10', ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }] } }]))
      if (path.endsWith('/events')) return list(items([{ metadata: metadata('api.started', 'production'), type: 'Normal', reason: 'Started', message: 'Started container main', count: 1, involvedObject: { kind: 'Pod', name: state.pods[0].metadata.name }, lastTimestamp: created }, { metadata: metadata('worker.backoff', 'production'), type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container', count: 12, involvedObject: { kind: 'Pod', name: state.pods[3].metadata.name }, lastTimestamp: new Date().toISOString() }]))
      const podName = path.match(/\/pods\/([^/]+)/)?.[1]
      const pod = state.pods.find(item => item.metadata.name === podName && item.metadata.namespace === namespace)
      if (pod && path.endsWith('/log')) {
        const first = `${new Date().toISOString()} INFO ${url.searchParams.get('container') || 'main'} ready\n${new Date().toISOString()} INFO listening on :8080\n`
        if (url.searchParams.get('follow') === 'true') {
          res.writeHead(200, { 'content-type': 'text/plain' }); res.write(first)
          let line = 0
          const timer = setInterval(() => res.write(`${new Date().toISOString()} INFO live line ${++line}\n`), 150)
          res.on('close', () => clearInterval(timer))
          return
        }
        return send(200, first + (url.searchParams.get('previous') ? 'previous container instance\n' : ''))
      }
      if (pod) return send(200, pod)
    }
    if (req.method === 'DELETE') {
      const index = state.pods.findIndex(item => path.endsWith(`/pods/${item.metadata.name}`) && item.metadata.namespace === namespace)
      if (index < 0) return send(404, { message: 'Pod not found' })
      if (body?.preconditions?.uid !== state.pods[index].metadata.uid) return send(409, { message: 'UID precondition failed' })
      state.pods.splice(index, 1)
      return send(200, { status: 'Success' })
    }
    if (req.method === 'PATCH') {
      const node = state.nodes.find(item => path === `api/v1/nodes/${item.metadata.name}`)
      if (node) { node.spec.unschedulable = body.spec.unschedulable; return send(200, node) }
      const deployment = state.deployments.find(item => path.includes(`/deployments/${item.metadata.name}`) && item.metadata.namespace === namespace)
      if (deployment) {
        if (path.endsWith('/scale')) deployment.spec.replicas = body.spec.replicas
        else deployment.spec.template.metadata = body.spec.template.metadata
        return send(200, deployment)
      }
    }
    send(404, { message: `Not found: ${path}` })
  }
  const server = tlsOptions ? https.createServer(tlsOptions, handle) : http.createServer(handle)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `${tlsOptions ? 'https' : 'http'}://127.0.0.1:${server.address().port}`, state, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}
