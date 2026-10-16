import { READ_OPERATIONS, WRITE_OPERATIONS } from './manager.js'
import { check } from './errors.js'

const fields = {
  connectionId: { type: 'string', description: 'Connection ID from rancher_connections.' },
  clusterId: { type: 'string', description: 'Exact Rancher cluster ID returned by clusters (not its display name).' },
  namespace: { type: 'string', description: 'Namespace; omit for cross-namespace lists.' },
  name: { type: 'string', description: 'Exact resource name.' },
}

function tool(name, description, properties, required, execute) {
  return {
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      check(args && typeof args === 'object' && !Array.isArray(args), '工具参数必须是对象')
      exec?.signal?.throwIfAborted()
      return { result: JSON.stringify(await execute(args, exec?.signal)) }
    },
  }
}

export function toolsFor(store, manager) {
  return [
    tool('rancher_connections', 'List configured Rancher connections and whether management is enabled. Never returns API tokens. Configure credentials in the Rancher settings page.', {}, [], () => store.list()),
    tool('rancher_read', 'Read Rancher clusters, namespaces, nodes, Pods, node-metrics/pod-metrics (CPU cores, memory bytes, timestamp), Pod details/logs, Deployments, Services or events. Metrics require metrics.k8s.io access. Call clusters first to resolve a cluster ID. Multi-container logs need container. previous=true reads logs of the previous container instance. Live data only.', {
      ...fields, operation: { type: 'string', enum: READ_OPERATIONS }, container: { type: 'string' },
      namespaces: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'Multiple namespaces for resource/Pod metric lists. Empty means all. Do not combine with namespace.' },
      tailLines: { type: 'integer', minimum: 1, maximum: 5000 }, previous: { type: 'boolean' },
      labelSelector: { type: 'string' }, node: { type: 'string' },
    }, ['connectionId', 'operation'], (args, signal) => {
      check(READ_OPERATIONS.includes(args.operation), '只读工具不支持此操作')
      return manager.run(args, signal)
    }),
    tool('rancher_manage', 'Manage Rancher resources: cordon/uncordon a node, delete one Pod, roll out a Deployment restart or change replicas. Requires management enabled for the connection. Confirm the intended target and disruption with the user before a destructive change. Pod deletion requires its current UID from rancher_read. Returns accepted, not rollout completion; read back status afterwards.', {
      ...fields, operation: { type: 'string', enum: WRITE_OPERATIONS }, uid: { type: 'string' },
      replicas: { type: 'integer', minimum: 0, maximum: 10000 },
    }, ['connectionId', 'clusterId', 'operation', 'name'], (args, signal) => {
      check(WRITE_OPERATIONS.includes(args.operation), '管理工具不支持此操作')
      return manager.run(args, signal)
    }),
  ]
}
