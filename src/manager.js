import { RancherClient, segment } from './client.js'
import { check } from './errors.js'
import { quantity, usageView, sumUsage, containerResources } from './resources.js'

export const READ_OPERATIONS = ['clusters', 'namespaces', 'nodes', 'pods', 'node-metrics', 'pod-metrics', 'pod', 'logs', 'deployments', 'services', 'events']
export const WRITE_OPERATIONS = ['delete-pod', 'cordon', 'uncordon', 'restart-deployment', 'scale-deployment']

const ready = resource => (resource.status?.conditions || []).find(condition => condition.type === 'Ready')?.status === 'True'
const meta = resource => ({ name: resource.metadata?.name, namespace: resource.metadata?.namespace || '', uid: resource.metadata?.uid, createdAt: resource.metadata?.creationTimestamp })

export function podView(pod) {
  const statuses = pod.status?.containerStatuses || []
  const initStatuses = pod.status?.initContainerStatuses || []
  const terminated = [...initStatuses, ...statuses].find(item => item.state?.waiting?.reason)
  return { ...meta(pod), node: pod.spec?.nodeName || '', phase: pod.status?.phase || 'Unknown',
    status: pod.metadata?.deletionTimestamp ? 'Terminating' : terminated?.state?.waiting?.reason || pod.status?.phase || 'Unknown',
    ready: statuses.filter(item => item.ready).length, containers: pod.spec?.containers?.length || 0,
    restarts: [...initStatuses, ...statuses].reduce((sum, item) => sum + (item.restartCount || 0), 0),
    ip: pod.status?.podIP || '', containerNames: (pod.spec?.containers || []).map(item => item.name),
    initContainerNames: (pod.spec?.initContainers || []).map(item => item.name),
    qosClass: pod.status?.qosClass || '', resources: containerResources(pod.spec?.containers),
    owners: (pod.metadata?.ownerReferences || []).map(({ kind, name }) => ({ kind, name })) }
}

export class RancherManager {
  constructor(store) { this.store = store }

  async testConnection(input, signal) {
    const client = new RancherClient(this.store.prepare(input))
    const clusters = await client.list('v3/clusters', {}, signal)
    return { authenticated: true, clusterCount: clusters.length, checkedAt: new Date().toISOString(), message: `连接验证通过，可访问 ${clusters.length} 个集群` }
  }

  async run(input, signal) {
    check(input && typeof input === 'object', '请求必须是对象')
    const { operation, connectionId, clusterId, namespace, name } = input
    check([...READ_OPERATIONS, ...WRITE_OPERATIONS].includes(operation), '不支持的 Rancher 操作')
    if (input.namespaces !== undefined) {
      check(Array.isArray(input.namespaces) && input.namespaces.length <= 100, '命名空间必须为最多 100 项的数组')
      input.namespaces.forEach(value => segment(value, '命名空间'))
      check(['pods', 'pod-metrics', 'deployments', 'services', 'events'].includes(operation), '此操作不支持多命名空间')
      check(!namespace, '不能同时指定 namespace 和 namespaces')
      const selected = [...new Set(input.namespaces)]
      if (selected.length) {
        const result = []
        for (let start = 0; start < selected.length; start += 5) {
          signal?.throwIfAborted()
          result.push(...(await Promise.all(selected.slice(start, start + 5).map(namespace => this.run({ ...input, namespaces: undefined, namespace }, signal)))).flat())
        }
        return operation === 'events' ? result.sort((a, b) => String(b.lastTimestamp).localeCompare(String(a.lastTimestamp))) : result
      }
    }
    const connection = this.store.get(connectionId)
    const client = new RancherClient(connection)
    if (WRITE_OPERATIONS.includes(operation)) {
      check(connection.allowWrites === true, '此连接处于只读模式，请在连接设置中开启管理操作', 403)
    }
    if (operation === 'clusters') {
      const clusters = await client.list('v3/clusters', {}, signal)
      return clusters.map(item => ({ id: item.id, name: item.name || item.id, state: item.state, version: item.version?.gitVersion || '',
        nodeCount: item.nodeCount ?? null, provider: item.provider || item.driver || '', transitioning: item.transitioning === 'yes' }))
    }
    const k8s = resource => client.k8s(clusterId, resource)
    const nsPath = prefix => `${prefix}/${namespace ? `namespaces/${segment(namespace, '命名空间')}/` : ''}`
    const list = (resource, query) => client.list(k8s(resource), query, signal)
    const request = (resource, opts) => client.request(k8s(resource), { ...opts, signal })
    if (operation === 'namespaces') return (await list('api/v1/namespaces')).map(item => ({ ...meta(item), status: item.status?.phase,
      project: item.metadata?.annotations?.['field.cattle.io/projectId'] || item.metadata?.labels?.['field.cattle.io/projectId'] || '', labels: item.metadata?.labels || {} })).sort((a, b) => a.name.localeCompare(b.name))
    if (operation === 'node-metrics') return (await list('apis/metrics.k8s.io/v1beta1/nodes')).map(item => ({ ...meta(item), ...usageView(item.usage), timestamp: item.timestamp, window: item.window }))
    if (operation === 'pod-metrics') return (await list(`${nsPath('apis/metrics.k8s.io/v1beta1')}pods`)).map(item => {
      const containers = (item.containers || []).map(container => ({ name: container.name, ...usageView(container.usage) }))
      return { ...meta(item), ...sumUsage(containers), containers, timestamp: item.timestamp, window: item.window }
    })
    if (operation === 'nodes') return (await list('api/v1/nodes')).map(item => ({ ...meta(item), ready: ready(item),
      unschedulable: item.spec?.unschedulable === true, roles: Object.keys(item.metadata?.labels || {}).filter(key => key.startsWith('node-role.kubernetes.io/')).map(key => key.split('/')[1]),
      ip: item.status?.addresses?.find(address => address.type === 'InternalIP')?.address || '',
      version: item.status?.nodeInfo?.kubeletVersion || '', cpu: item.status?.allocatable?.cpu || '', memory: item.status?.allocatable?.memory || '',
      allocatable: usageView(item.status?.allocatable), capacity: usageView(item.status?.capacity), podCapacity: quantity(item.status?.allocatable?.pods),
      os: item.status?.nodeInfo?.osImage || '', architecture: item.status?.nodeInfo?.architecture || '', runtime: item.status?.nodeInfo?.containerRuntimeVersion || '',
      pressure: (item.status?.conditions || []).filter(condition => condition.type.endsWith('Pressure') && condition.status === 'True').map(condition => condition.type),
      conditions: (item.status?.conditions || []).map(({ type, status, reason }) => ({ type, status, reason })) }))
    if (operation === 'pods') return (await list(`${nsPath('api/v1')}pods`, { labelSelector: input.labelSelector, fieldSelector: input.node ? `spec.nodeName=${segment(input.node, '节点')}` : undefined })).map(podView)
    if (operation === 'deployments') return (await list(`${nsPath('apis/apps/v1')}deployments`)).map(item => ({ ...meta(item),
      ready: item.status?.readyReplicas || 0, replicas: item.spec?.replicas ?? 1, available: item.status?.availableReplicas || 0,
      images: (item.spec?.template?.spec?.containers || []).map(container => container.image), generation: item.metadata?.generation,
      observedGeneration: item.status?.observedGeneration }))
    if (operation === 'services') return (await list(`${nsPath('api/v1')}services`)).map(item => ({ ...meta(item),
      type: item.spec?.type, clusterIP: item.spec?.clusterIP, externalIPs: item.status?.loadBalancer?.ingress || [],
      ports: (item.spec?.ports || []).map(({ name, port, targetPort, nodePort, protocol }) => ({ name, port, targetPort, nodePort, protocol })) }))
    if (operation === 'events') return (await list(`${nsPath('api/v1')}events`)).map(item => ({ ...meta(item), type: item.type, reason: item.reason,
      message: client.redact(item.message || ''), count: item.count || 1, object: `${item.involvedObject?.kind || ''}/${item.involvedObject?.name || ''}`,
      lastTimestamp: item.lastTimestamp || item.eventTime || item.metadata?.creationTimestamp })).sort((a, b) => String(b.lastTimestamp).localeCompare(String(a.lastTimestamp)))
    if (operation === 'cordon' || operation === 'uncordon') {
      await request(`api/v1/nodes/${segment(name, '节点')}`, { method: 'PATCH', contentType: 'application/merge-patch+json', body: { spec: { unschedulable: operation === 'cordon' } } })
      return { accepted: true, operation, name }
    }
    check(namespace, '此操作需要指定命名空间')
    const podPath = `${nsPath('api/v1')}pods/${segment(name)}`
    if (operation === 'pod') {
      const pod = await request(podPath)
      return { ...podView(pod), labels: pod.metadata?.labels || {}, qosClass: pod.status?.qosClass,
        conditions: (pod.status?.conditions || []).map(({ type, status, reason, lastTransitionTime }) => ({ type, status, reason, lastTransitionTime })),
        containerDetails: [...(pod.spec?.initContainers || []), ...(pod.spec?.containers || [])].map(({ name, image, resources, ports }) => ({ name, image, resources: resources || {}, ports: ports || [] })) }
    }
    if (operation === 'logs') {
      const tail = input.tailLines ?? 200
      check(Number.isInteger(tail) && tail >= 1 && tail <= 5000, '日志行数必须为 1–5000')
      check(input.previous === undefined || typeof input.previous === 'boolean', 'previous 必须是布尔值')
      const query = new URLSearchParams({ tailLines: String(tail), timestamps: 'true', limitBytes: '524288' })
      if (input.container) query.set('container', segment(input.container, '容器'))
      if (input.previous) query.set('previous', 'true')
      return { text: await request(`${podPath}/log?${query}`, { text: true }), tailLines: tail }
    }
    if (operation === 'delete-pod') {
      check(typeof input.uid === 'string' && input.uid, '删除 Pod 需要 UID，请先查询 Pod 详情')
      await request(podPath, { method: 'DELETE', body: { apiVersion: 'v1', kind: 'DeleteOptions', gracePeriodSeconds: 30, preconditions: { uid: input.uid } } })
      return { accepted: true, operation, name, message: '删除请求已提交；由控制器管理的 Pod 将按副本策略重建。' }
    }
    const deployment = `${nsPath('apis/apps/v1')}deployments/${segment(name)}`
    if (operation === 'restart-deployment') {
      await request(deployment, { method: 'PATCH', contentType: 'application/merge-patch+json', body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } } })
    } else if (operation === 'scale-deployment') {
      check(Number.isInteger(input.replicas) && input.replicas >= 0 && input.replicas <= 10000, '副本数必须为 0–10000 的整数')
      await request(`${deployment}/scale`, { method: 'PATCH', contentType: 'application/merge-patch+json', body: { spec: { replicas: input.replicas } } })
    }
    return { accepted: true, operation, name, message: '请求已提交，请刷新查看就绪状态。' }
  }

  async streamLogs(input, signal, consume) {
    check(input && typeof input === 'object' && !Array.isArray(input), '请求必须是对象')
    const { connectionId, clusterId, namespace, name, container } = input
    const tail = input.tailLines ?? 200
    check(Number.isInteger(tail) && tail >= 1 && tail <= 5000, '日志行数必须为 1–5000')
    check(input.previous === undefined || input.previous === false, '上一次容器日志不支持实时跟随')
    const query = new URLSearchParams({ follow: 'true', timestamps: 'true', tailLines: String(tail) })
    if (container) query.set('container', segment(container, '容器'))
    const client = new RancherClient(this.store.get(connectionId))
    const path = client.k8s(clusterId, `api/v1/namespaces/${segment(namespace, '命名空间')}/pods/${segment(name)}/log?${query}`)
    await client.stream(path, { signal, consume })
  }
}
