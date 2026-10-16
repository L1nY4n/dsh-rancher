import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import 'dsh-preview-theme'
import { Server, Settings2 } from 'lucide-react'
import { App, ConnectionSettings } from './app.jsx'
import { CSS } from './style.js'

const style = document.createElement('style')
style.textContent = CSS + `
html,body{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}body{margin:0;font-family:var(--dsw-font-family)}
`
document.head.appendChild(style)
const theme = matchMedia('(prefers-color-scheme:dark)')
const syncTheme = () => document.body.toggleAttribute('data-ds-dark-theme', theme.matches)
syncTheme()
theme.addEventListener('change', syncTheme)
const live = document.documentElement.dataset.live === 'true'
function Preview() {
  const [page, setPage] = useState('rancher')
  return <><div className="rc-demo">{live ? '本地预览 · 已接入真实 Rancher，管理操作会影响实际集群' : '演示环境 · 所有数据均为本地测试样例'}</div><div className="rc-preview-shell"><aside className="rc-preview-nav" aria-label="应用导航"><strong>DSH</strong><Button size="sm" icon={<Server size={16} />} aria-label="Rancher" aria-current={page === 'rancher' ? 'page' : undefined} onClick={() => setPage('rancher')}><span>Rancher</span></Button><Button size="sm" icon={<Settings2 size={16} />} aria-label="设置" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}><span>设置</span></Button></aside><main className="rc-preview-main">{page === 'rancher' ? <App /> : <ConnectionSettings onOpenWorkbench={() => setPage('rancher')} />}</main></div></>
}
createRoot(document.getElementById('app')).render(<Preview />)
