import React from 'react'
import { Server } from 'lucide-react'
import { App, ConnectionSettings } from './app.jsx'
import { CSS } from './style.js'
import { selectConnection } from './view.js'

export const name = 'rancher'
export const inject = ['slots', 'layout']

export function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'dsh-rancher')
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'rancher: styles')
  const openWorkbench = id => {
    if (id) selectConnection(id)
    ctx.layout.selectPanel('rancher')
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'rancher' }, () => <App />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'rancher', order: 20, label: () => 'Rancher',
  }, ({ size = 18 }) => <Server size={size} />))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'rancher', order: 36, label: () => 'Rancher',
  }, ({ close }) => <ConnectionSettings embedded onOpenWorkbench={id => { close?.(); openWorkbench(id) }} />))
}
