import { ConnectionStore } from './src/store.js'
import { RancherManager } from './src/manager.js'
import { createApi } from './src/api.js'
import { toolsFor } from './src/tools.js'

export const name = 'rancher'
export const inject = []

export function apply(ctx, config = {}) {
  const store = new ConnectionStore(config.dataDir)
  const manager = new RancherManager(store)
  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix', path: '/api/rancher',
      handler: createApi({ store, manager, getConnection: () => ctx.get('connection') }),
    }), 'rancher: API')
  })
  // Consume the host registry; importing a second dsh-tools runtime breaks Cordis ownership.
  ctx.inject(['tools'], scoped => {
    for (const tool of toolsFor(store, manager)) scoped.effect(() => scoped.tools.register(tool), `rancher: ${tool.name}`)
  })
}
