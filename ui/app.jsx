import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useId } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { Button as DshButton, Input, Checkbox, Modal as DshModal, Menu, MenuItemButton, SegmentedTabs, Tag, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { Server, Box, Layers, Network, Activity, Settings2, RefreshCw, Plus, Pencil, Trash2, X, Search, FileText, RotateCw, Scaling, Lock, Unlock, Check, AlertCircle, Copy, ArrowUpRight, Database, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, ChevronDown, ShieldCheck, Download, ChevronsDown, Rows3 } from 'lucide-react'
import { api, run, streamLogs, pagePods } from './api.js'
import { RancherIcon } from './rancher-icon.jsx'
import { useRancherView, selectConnection, connectionsChanged } from './view.js'
import { quantity } from '../src/resources.js'

const TABS = [ ['nodes', '节点', Server], ['pods', 'Pods', Box], ['deployments', '工作负载', Layers], ['services', '服务', Network], ['events', '事件', Activity] ]
const idOf = item => item.uid || item.id || `${item.namespace}/${item.name}`
const date = value => value ? new Date(value).toLocaleString() : '—'
const age = value => {
  if (!value) return '—'
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value)) / 60000))
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`
}
const memory = value => {
  const match = String(value).match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/)
  if (!match) return value || '-'
  const powers = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }
  const gib = Number(match[1]) * (powers[match[2]] || 1) / 1024 ** 3
  return gib >= 1 ? `${Number(gib.toFixed(1))} GiB` : `${Number((gib * 1024).toFixed(1))} MiB`
}
const cpu = value => value === null || value === undefined || value === '' ? '—' : `${Number(Number(value).toFixed(3))}`
const cpuUsage = value => value === null || value === undefined ? '—' : value < 1 ? `${Number((value * 1000).toFixed(1))}m` : `${Number(value.toFixed(2))} 核`
const memUsage = value => value === null || value === undefined ? '—' : memory(value)
const healthy = (row, type) => type === 'nodes' ? row.ready && !row.pressure?.length : type === 'pods' ? (row.status === 'Running' && row.ready === row.containers) || row.status === 'Succeeded' : type === 'deployments' ? row.ready === row.replicas && row.available >= row.replicas : type === 'events' ? row.type !== 'Warning' : true

function ResourceUsage({ value, total, kind, stale = false, title = '' }) {
  const percent = value != null && total > 0 ? value / total * 100 : null
  const formatted = kind === 'cpu' ? cpuUsage(value) : memUsage(value)
  return <div className={`rc-usage ${stale ? 'rc-metric-stale' : ''}`} title={`${title}${stale ? ' · 上次采样，当前指标读取失败' : ''}`}>
    <span><span>{formatted}</span>{percent !== null && <small>{Number(percent.toFixed(1))}%</small>}</span>
    {percent !== null && <span className={`rc-usage-track ${percent >= 90 ? 'rc-usage-high' : ''}`}><i style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></span>}
  </div>
}
const authName = type => ({ token: 'Bearer Token', password: '账户密码', 'access-secret': 'Access Key / Secret Key' }[type] || 'Bearer Token')

function LoadingRows() {
  return <div className="rc-skeleton" role="status" aria-label="正在加载资源" aria-busy="true">{Array.from({ length: 9 }, (_, index) => <div className="rc-skeleton-row" key={index}>{Array.from({ length: 5 }, (_, column) => <span key={column} />)}</div>)}</div>
}

function useData(key, fetcher, enabled = true, interval = false) {
  const [state, setState] = useState({ key: '', data: null, loading: false, error: '', at: null })
  const [tick, setTick] = useState(0)
  const ref = useRef(fetcher)
  const active = useRef(null)
  ref.current = fetcher
  useEffect(() => {
    if (!enabled) { setState({ key, data: null, loading: false, error: '', at: null }); return }
    const abort = new AbortController()
    active.current = abort
    setState(old => ({ key, data: old.key === key ? old.data : null, loading: true, error: '', at: old.key === key ? old.at : null }))
    ref.current(abort.signal, data => {
      if (!abort.signal.aborted) setState(old => old.key === key ? { ...old, data, loading: true, error: '', at: null } : old)
    }).then(data => {
      if (!abort.signal.aborted) setState({ key, data, loading: false, error: '', at: new Date() })
    }).catch(error => { if (!abort.signal.aborted) setState(old => ({ ...old, loading: false, error: error.message })) })
      .finally(() => { if (active.current === abort) active.current = null })
    return () => { abort.abort(); if (active.current === abort) active.current = null }
  }, [key, tick, enabled])
  useEffect(() => {
    if (!interval || !enabled) return
    const timer = setInterval(() => { if (!document.hidden && !active.current) setTick(value => value + 1) }, 15000)
    return () => clearInterval(timer)
  }, [interval, enabled])
  return { ...(state.key === key ? state : { data: null, loading: enabled, error: '', at: null }), reload: () => setTick(value => value + 1) }
}

export function Button({ icon: Icon, children, className = '', title, ...props }) {
  const classes = className.split(/\s+/)
  const variant = classes.includes('primary') ? 'primary' : classes.includes('ghost') || !children ? 'ghost' : 'outline'
  return <DshButton size="sm" variant={variant} icon={Icon ? <Icon size={15} /> : undefined} className={`rc-button ${children ? '' : 'rc-icon-button'} ${classes.includes('danger') ? 'rc-danger' : ''} ${classes.filter(value => !['primary', 'ghost', 'danger'].includes(value)).join(' ')}`} title={title} aria-label={children ? undefined : title} {...props}>{children}</DshButton>
}

function Select({ label, items, value, onChange, disabled = false, className = '', searchable = false }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => { if (!open) setQuery('') }, [open])
  const selected = items.find(item => String(item.value) === String(value))
  const select = next => { onChange(next); setOpen(false) }
  const filtered = items.filter(item => !query || String(item.label).toLowerCase().includes(query.toLowerCase()))
  return <Menu open={open && !disabled} onClose={() => setOpen(false)} portal compact autoFocus
    className={`rc-select ${className}`} selectedId={String(value)}
    items={searchable ? [] : items.map(item => ({ id: String(item.value), label: item.label, disabled: item.disabled }))}
    onSelect={select}
    anchor={<DshButton variant="outline" size="sm" className="rc-select-button" aria-label={label}
      aria-haspopup="menu" aria-expanded={open && !disabled} data-value={value} disabled={disabled}
      onClick={() => setOpen(!open)} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true) } }}>
      <span className="rc-select-value">{selected?.label || '请选择'}</span><ChevronDown size={13} />
    </DshButton>}>
    {searchable && <><div className="rc-menu-search"><Input aria-label={`搜索${label}`} value={query} placeholder={`搜索${label}…`} icon={<Search size={13} />} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (['Home', 'End', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.stopPropagation() }} /></div>{filtered.map(item => <MenuItemButton key={String(item.value)} disabled={item.disabled} icon={String(item.value) === String(value) ? <Check size={13} /> : undefined} onSelect={() => select(String(item.value))}>{item.label}</MenuItemButton>)}{!filtered.length && <div className="rc-menu-search rc-muted">没有匹配的命名空间</div>}</>}
  </Menu>
}

function Tabs({ label, items, value, onChange, id }) {
  return <SegmentedTabs label={label} className="rc-tabs" value={value} onChange={onChange}
    items={items.map(([key, text, Icon]) => ({ value: key, id: `${id}-${key}`, panelId: `${id}-${key}-panel`, label: <span className="rc-tab-label">{Icon && <Icon size={14} />}{text}</span> }))} />
}

function NamespaceSelect({ items, value, onChange, disabled, clusterScoped }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const close = () => { setOpen(false); setQuery('') }
  const toggle = name => onChange(value.includes(name) ? value.filter(item => item !== name) : [...value, name].sort())
  return <Menu open={open && !disabled} onClose={close} portal compact className="rc-select" listClassName="rc-namespace-menu"
    anchor={<DshButton variant="outline" size="sm" className="rc-select-button" aria-label="命名空间" aria-haspopup="menu" aria-expanded={open && !disabled} disabled={disabled} data-value={clusterScoped ? '' : value.join(',')} onClick={() => setOpen(!open)}>
      <span className="rc-select-value" title={value.join(', ')}>{clusterScoped ? '集群级资源 · 不限命名空间' : value.length ? value.length === 1 ? value[0] : `${value.length} 个命名空间` : '全部命名空间'}</span><ChevronDown size={13} />
    </DshButton>}>
    <div className="rc-menu-search"><Input aria-label="搜索命名空间" value={query} placeholder="搜索命名空间…" icon={<Search size={13} />} onChange={event => setQuery(event.target.value)} onKeyDown={event => event.stopPropagation()} /></div>
    <MenuItemButton icon={!value.length ? <Check size={13} /> : undefined} onSelect={() => onChange([])}>全部命名空间</MenuItemButton>
    {items.filter(name => name.toLowerCase().includes(query.toLowerCase())).map(name => <MenuItemButton key={name} disabled={value.length >= 100 && !value.includes(name)} icon={value.includes(name) ? <Check size={13} /> : <span className="rc-check-space" />} onSelect={() => toggle(name)}>{name}</MenuItemButton>)}
    {!items.some(name => name.toLowerCase().includes(query.toLowerCase())) && <div className="rc-menu-search rc-muted">没有匹配的命名空间</div>}
    <div className="rc-menu-done"><span>{value.length ? `已选 ${value.length} 项${value.length >= 100 ? '（上限）' : ''}` : '当前范围：全部'}</span><DshButton size="sm" variant="outline" onClick={close}>完成选择</DshButton></div>
  </Menu>
}

function ErrorMessage({ error, retry }) {
  return error ? <div className="rc-error" role="alert"><AlertCircle /><span>{error}</span>{retry && <Button icon={RefreshCw} title="重试" onClick={retry} />}</div> : null
}

function DrawerResizeHandle() {
  const handle = useRef()
  const drag = useRef(null)
  const [width, setWidth] = useState(() => {
    try { const saved = Number(localStorage.getItem('rancher.podDrawerWidth')); if (saved >= 560) return saved } catch {}
    return 1000
  })
  const [maximum, setMaximum] = useState(window.innerWidth - 48)
  const minimum = Math.min(560, maximum)
  const current = Math.max(minimum, Math.min(maximum, width))
  useLayoutEffect(() => {
    const dialog = handle.current.closest('[role="dialog"]')
    const measure = () => {
      const parent = dialog.parentElement
      const style = getComputedStyle(parent)
      setMaximum(Math.max(0, parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)))
    }
    measure(); window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  useLayoutEffect(() => { handle.current.closest('[role="dialog"]').style.setProperty('--rc-drawer-width', `${current}px`) }, [current])
  const remember = value => { try { localStorage.setItem('rancher.podDrawerWidth', String(value)) } catch {} }
  const finish = event => {
    if (!drag.current) return
    drag.current = null; remember(current)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <div ref={handle} className="rc-drawer-resize" role="separator" tabIndex={0} aria-label="调整 Pod 窗口宽度" aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={Math.round(current)} aria-valuetext={`${Math.round(current)} 像素`} title="拖拽调整宽度 · 双击恢复默认 · ← → 微调"
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); drag.current = { x: event.clientX, width: current }; event.currentTarget.setPointerCapture(event.pointerId) }}
    onPointerMove={event => { if (drag.current) setWidth(Math.max(minimum, Math.min(maximum, drag.current.width + drag.current.x - event.clientX))) }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { drag.current = null }}
    onDoubleClick={() => { setWidth(1000); remember(1000) }}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = Math.max(minimum, Math.min(maximum, event.key === 'Home' ? minimum : event.key === 'End' ? maximum : current + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 100 : 40)))
      setWidth(next); remember(next)
    }} />
}

function Modal({ title, children, close, wide = false, busy = false, drawer = false, resizable = false, onKeyDownCapture }) {
  return <DshModal open title={title} closeLabel="关闭" onClose={() => { if (!busy) close() }}
    onKeyDownCapture={onKeyDownCapture} className={`rc-root rc-modal ${wide ? 'wide' : ''} ${drawer ? 'drawer' : ''} ${resizable ? 'rc-pod-dialog' : ''}`} contentClassName="rc-modal-content">
    <div className="rc-dialog-body" aria-busy={busy}>{resizable && <DrawerResizeHandle />}{children}</div>
  </DshModal>
}

function Field({ label, children }) { return <label className="rc-field"><span>{label}</span>{children}</label> }
function State({ children, good, bad }) { return <span className={`rc-state ${good ? 'good' : bad ? 'bad' : 'neutral'}`}><StateDot size={6} state={good ? 'done' : bad ? 'error' : 'idle'} />{children}</span> }
function Empty({ children, icon: Icon = Database }) { return <div className="rc-empty"><Icon /><span>{children}</span></div> }

function ConnectionForm({ entry, saved, close }) {
  const [draft, setDraft] = useState(entry
    ? { ...entry, token: '', username: '', password: '', accessKey: '', secretKey: '' }
    : { name: '', url: '', authType: 'token', token: '', username: '', password: '', accessKey: '', secretKey: '', allowWrites: false })
  const [pending, setPending] = useState('')
  const busy = Boolean(pending)
  const [error, setError] = useState('')
  const [verification, setVerification] = useState(null)
  const [confirmSave, setConfirmSave] = useState(false)
  const set = (key, value) => {
    setVerification(null); setError('')
    setDraft(old => ({ ...old, [key]: value }))
  }
  async function testConnection() {
    setPending('test'); setError(''); setVerification(null)
    try { setVerification(await api('/connections/test', { body: draft })) }
    catch (error) { setError(error.message) }
    finally { setPending('') }
  }
  async function submit() {
    setPending('save'); setError(''); setVerification(null)
    try { const result = await api('/connections', { body: draft }); saved(result); close() }
    catch (error) { setError(error.message) }
    finally { setPending('') }
  }
  return <Modal title={entry ? '编辑 Rancher 连接' : '添加 Rancher 连接'} close={close} busy={busy}>
    <form onSubmit={event => { event.preventDefault(); setConfirmSave(true) }}><fieldset disabled={busy} className="rc-form"><ErrorMessage error={error} />
      {verification && <p className="rc-success" role="status">{verification.message}</p>}
      <Field label="连接名称"><Input className="rc-input" required maxLength={80} value={draft.name} onChange={e => set('name', e.target.value)} placeholder="生产集群" /></Field>
      <Field label="Rancher URL"><Input className="rc-input" type="url" required value={draft.url} onChange={e => set('url', e.target.value)} placeholder="https://rancher.example.com" /></Field>
      <Field label="认证方式"><Select label="认证方式" value={draft.authType} onChange={value => set('authType', value)} items={[{ value: 'token', label: 'Bearer Token' }, { value: 'password', label: '账户密码' }, { value: 'access-secret', label: 'Access Key / Secret Key' }]} /></Field>
      {draft.authType === 'token' && <Field label={entry ? 'API Token（留空保留；更换地址时必填）' : 'API Token'}><Input className="rc-input" type="password" autoComplete="new-password" required={!entry} value={draft.token} onChange={e => set('token', e.target.value)} placeholder="token-xxxxx:xxxxxxxx" /></Field>}
      {draft.authType === 'password' && <div className="rc-grid"><Field label="Rancher 用户名"><Input className="rc-input" autoComplete="username" required={!entry || !(entry.authType === 'password' && entry.hasCredential)} value={draft.username} onChange={e => set('username', e.target.value)} placeholder="admin" /></Field><Field label={entry ? '密码（留空保留）' : '密码'}><Input className="rc-input" type="password" autoComplete="current-password" required={!entry || !(entry.authType === 'password' && entry.hasCredential)} value={draft.password} onChange={e => set('password', e.target.value)} /></Field></div>}
      {draft.authType === 'access-secret' && <div className="rc-grid"><Field label="Access Key"><Input className="rc-input" autoComplete="username" required={!entry || !(entry.authType === 'access-secret' && entry.hasCredential)} value={draft.accessKey} onChange={e => set('accessKey', e.target.value)} placeholder="token-xxxxx" /></Field><Field label={entry ? 'Secret Key（留空保留）' : 'Secret Key'}><Input className="rc-input" type="password" autoComplete="new-password" required={!entry || !(entry.authType === 'access-secret' && entry.hasCredential)} value={draft.secretKey} onChange={e => set('secretKey', e.target.value)} /></Field></div>}
      <p className="rc-muted">HTTPS 加密传输 · 不校验服务器证书</p>
      <Checkbox className="rc-check" label="启用管理操作（删除 Pod、节点调度、重启和扩缩容）" checked={draft.allowWrites} onChange={checked => set('allowWrites', checked)} />
      <div className="rc-modal-actions"><Button onClick={close} disabled={busy}>取消</Button><Button onClick={testConnection} disabled={busy}>{pending === 'test' ? '验证中…' : '测试连接'}</Button><Button type="submit" icon={Check} className="primary" disabled={busy}>{pending === 'save' ? '验证并保存中…' : '保存连接'}</Button></div>
    </fieldset></form>
    {confirmSave && <Modal title="确认保存连接" close={() => { if (!busy) setConfirmSave(false) }} busy={busy}><p>保存「{draft.name}」的连接配置？</p><p className="rc-muted">{draft.url}</p><p className="rc-muted">认证：{authName(draft.authType)} · {draft.allowWrites ? '允许删除 Pod、节点调度、重启及扩缩容' : '只读访问'}。{entry ? '将更新已保存的连接配置。' : '将认证信息保存在本机。'}</p><ErrorMessage error={error} /><div className="rc-modal-actions"><Button disabled={busy} onClick={() => setConfirmSave(false)}>取消</Button><Button className="primary" disabled={busy} onClick={submit}>{busy ? '验证并保存中…' : '确认保存'}</Button></div></Modal>}
  </Modal>
}

function Connections({ connections, refresh, select, saved }) {
  const [edit, setEdit] = useState(undefined)
  const [remove, setRemove] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function deleteConnection() {
    setBusy(true); setError('')
    try { await api(`/connections/${encodeURIComponent(remove.id)}`, { method: 'DELETE' }); refresh(); setRemove(null) }
    catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  return <><div className="rc-toolbar"><h3>Rancher 连接</h3><span className="rc-spacer" /><Button icon={Plus} onClick={() => setEdit(null)}>添加连接</Button></div>
    <div className="rc-connections">{connections.map(entry => <div className="rc-connection" key={entry.id}><RancherIcon /><div className="rc-connection-info"><strong>{entry.name}</strong><small>{entry.url}</small><div className="rc-connection-auth"><Lock size={11} />{authName(entry.authType)}<span>·</span>{entry.url.startsWith('https://') ? '不校验证书' : '本机 HTTP'}</div></div><State good={entry.allowWrites}>{entry.allowWrites ? '可管理' : '只读'}</State><div className="rc-connection-actions"><Button icon={ArrowUpRight} title={`打开 ${entry.name}`} onClick={() => select(entry.id)} /><Button icon={Pencil} title={`编辑 ${entry.name}`} onClick={() => setEdit(entry)} /><Button icon={Trash2} className="danger" title={`移除 ${entry.name}`} onClick={() => { setError(''); setRemove(entry) }} /></div></div>)}</div>
    {!connections.length && <Empty>尚未配置 Rancher 连接</Empty>}
    {edit !== undefined && <ConnectionForm entry={edit} close={() => setEdit(undefined)} saved={saved} />}
    {remove && <Modal title="移除连接" close={() => setRemove(null)} busy={busy}><p>移除本地保存的「{remove.name}」连接及认证信息？</p><ErrorMessage error={error} /><div className="rc-modal-actions"><Button onClick={() => setRemove(null)} disabled={busy}>取消</Button><Button icon={Trash2} className="danger" disabled={busy} onClick={deleteConnection}>移除</Button></div></Modal>}
  </>
}

export function ConnectionSettings({ embedded = false, onOpenWorkbench }) {
  const view = useRancherView()
  const connections = useData(`connections:${view.revision}`, signal => api('/connections', { signal }))
  const [notice, setNotice] = useState('')
  const list = connections.data || []
  function saved(entry) {
    connectionsChanged(entry.id)
    setNotice(`${entry.name}：${entry.verification.message}，已保存连接`)
  }
  function open(id) { selectConnection(id); onOpenWorkbench?.(id) }
  return <div className={`rc-root rc-settings ${embedded ? 'rc-embedded' : ''}`}>
    <header className="rc-heading"><div className="rc-brand"><Settings2 /><h2>Rancher 连接设置</h2></div>{onOpenWorkbench && <Button icon={ArrowUpRight} onClick={() => open(list.find(item => item.id === view.connectionId)?.id || list[0]?.id || '')}>打开工作台</Button>}</header>
    <p className="rc-settings-note">{list.length} 个已保存连接 · 各连接独立配置认证与管理权限</p>
    <ErrorMessage error={connections.error} retry={connections.reload} />
    {notice && <p className="rc-success" role="status">{notice}</p>}
    {connections.loading && !connections.data ? <Empty>正在读取连接配置…</Empty> : <Connections connections={list} refresh={() => { connectionsChanged(); setNotice('') }} saved={saved} select={open} />}
  </div>
}

function ActionDialog({ action, scope, close, completed }) {
  const [replicas, setReplicas] = useState(String(action.row.replicas ?? 1))
  const [phase, setPhase] = useState('confirm')
  const [error, setError] = useState('')
  const monitor = useRef(null)
  useEffect(() => () => monitor.current?.abort(), [])
  const dismiss = () => { if (phase === 'monitoring') completed(`${action.label}已提交，已停止自动核对，请稍后刷新资源检查。`); monitor.current?.abort(); close() }
  const valid = /^\d+$/.test(replicas) && Number(replicas) <= 10000
  const messages = {
    'delete-pod': '删除后，受工作负载控制器管理的 Pod 会按副本策略重建。独立 Pod 不会自动恢复。',
    cordon: '封锁后将停止向此节点调度新 Pod，现有 Pod 继续运行。',
    uncordon: '解封后，此节点将恢复接受新 Pod。',
    'restart-deployment': '将触发 Deployment 滚动重启，请确认当前服务可用副本和更新策略。',
    'scale-deployment': '将修改目标副本数。设为 0 会停止此 Deployment 的所有 Pod。',
  }
  async function submit() {
    setPhase('submitting'); setError('')
    const controller = new AbortController()
    monitor.current = controller
    let accepted = false
    try {
      const result = await run({ ...scope, namespaces: undefined, operation: action.operation, name: action.row.name, namespace: action.row.namespace || undefined, uid: action.row.uid, replicas: Number(replicas) }, controller.signal)
      accepted = true
      completed(`${action.label}请求已提交，正在核对资源状态…`)
      setPhase('monitoring')
      if (['restart-deployment', 'scale-deployment'].includes(action.operation) && !Number.isInteger(result.generation)) throw new Error('服务端未返回资源版本')
      const readOperation = action.operation === 'delete-pod' ? 'pods' : ['cordon', 'uncordon'].includes(action.operation) ? 'nodes' : 'deployments'
      const deadline = Date.now() + 45000
      let verified = false
      while (!controller.signal.aborted && Date.now() < deadline) {
        const rows = await run({ ...scope, namespaces: undefined, namespace: action.row.namespace || undefined, operation: readOperation }, controller.signal)
        const row = rows.find(item => item.name === action.row.name)
        if (action.operation === 'delete-pod' && (!row || row.uid !== action.row.uid)) { verified = true; break }
        if (['cordon', 'uncordon'].includes(action.operation) && row?.uid === action.row.uid && row.unschedulable === (action.operation === 'cordon')) { verified = true; break }
        if (['restart-deployment', 'scale-deployment'].includes(action.operation) && row) {
          if (row.generation > result.generation) throw new Error('资源随后发生其他变更，无法确认本次操作')
          const desired = action.operation === 'scale-deployment' ? Number(replicas) : row.replicas
          if (row.generation === result.generation && row.observedGeneration >= result.generation && row.replicas === desired && row.current === desired && row.updated === desired && row.ready === desired && row.available === desired) { verified = true; break }
        }
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
      if (controller.signal.aborted) return
      if (!verified) throw new Error('等待超过 45 秒，请稍后刷新资源检查状态')
      completed(`${action.label} 已完成：${action.row.namespace ? `${action.row.namespace}/` : ''}${action.row.name}`, true)
      close()
    } catch (error) {
      if (controller.signal.aborted) return
      setPhase(accepted ? 'unverified' : 'confirm')
      setError(accepted ? `请求已提交，但状态未确认：${error.message}` : error.message)
      if (accepted) completed(`${action.label}已提交，状态未确认，请稍后刷新资源检查。`)
    }
  }
  return <Modal title={action.label} close={dismiss} busy={phase === 'submitting'}>
    <p className="rc-muted">{action.connectionName} · {action.clusterName}</p><p><strong>{action.row.namespace ? `${action.row.namespace}/` : ''}{action.row.name}</strong></p><p className="rc-muted">{messages[action.operation]}</p>
    {action.operation === 'scale-deployment' && <><p className="rc-muted">副本数：{action.row.replicas} → {valid ? replicas : '请输入有效数值'}</p><Field label="目标副本数"><Input type="number" className="rc-input" min={0} max={10000} step={1} value={replicas} onChange={e => setReplicas(e.target.value)} /></Field></>}
    {phase === 'monitoring' && <p className="rc-muted" role="status">请求已提交，正在核对资源状态…</p>}
    <ErrorMessage error={error} /><div className="rc-modal-actions"><Button onClick={dismiss} disabled={phase === 'submitting'}>{phase === 'confirm' ? '取消' : phase === 'monitoring' ? '稍后查看' : '关闭'}</Button>{['confirm', 'submitting'].includes(phase) && <Button icon={Check} className={action.operation === 'delete-pod' ? 'danger' : 'primary'} disabled={phase !== 'confirm' || (action.operation === 'scale-deployment' && !valid)} onClick={submit}>{phase === 'submitting' ? '提交中…' : '确认执行'}</Button>}</div>
  </Modal>
}

function PodDetails({ data, text, usage }) {
  return <div className="rc-detail">
    <section className="rc-detail-section"><h4>基本信息</h4><dl className="rc-facts"><dt>命名空间</dt><dd>{data.namespace}</dd><dt>节点</dt><dd>{data.node || '-'}</dd><dt>Pod IP</dt><dd className="rc-mono">{data.ip || '-'}</dd><dt>QoS</dt><dd>{data.qosClass || '-'}</dd><dt>创建时间</dt><dd>{date(data.createdAt)}</dd><dt>控制器</dt><dd>{data.owners?.map(owner => `${owner.kind}/${owner.name}`).join(', ') || '-'}</dd></dl></section>
    <section className="rc-detail-section"><h4>容器 <span className="rc-muted">{data.containerDetails?.length || 0}</span></h4>{data.containerDetails?.map(container => {
      const sample = usage?.containers?.find(item => item.name === container.name)
      return <div className="rc-container" key={container.name}><div className="rc-row"><strong>{container.name}</strong><Tag tone="neutral">{data.initContainerNames?.includes(container.name) ? 'Init container' : 'Container'}</Tag></div><span className="rc-mono">{container.image}</span><div className="rc-container-usage"><span>实际 CPU <strong>{cpuUsage(sample?.cpuCores)}</strong></span><span>实际内存 <strong>{memUsage(sample?.memoryBytes)}</strong></span></div><div className="rc-muted">{['requests', 'limits'].map(kind => `${kind === 'requests' ? '请求' : '上限'}: CPU ${container.resources?.[kind]?.cpu || '-'} / 内存 ${container.resources?.[kind]?.memory || '-'}`).join(' · ')}</div>{container.ports?.length > 0 && <span className="rc-muted">端口 {container.ports.map(port => `${port.containerPort}/${port.protocol || 'TCP'}`).join(', ')}</span>}</div>
    })}</section>
    <section className="rc-detail-section"><h4>状态条件</h4>{data.conditions?.length ? data.conditions.map(condition => <div className="rc-row" key={condition.type}><State good={condition.status === 'True'}>{condition.type}</State><span className="rc-muted">{condition.reason || condition.status}</span></div>) : <span className="rc-muted">暂无条件</span>}</section>
    <section className="rc-detail-section"><h4>标签</h4><div className="rc-labels">{Object.entries(data.labels || {}).map(([key, value]) => <Tag tone="quiet" key={key}>{key}={value}</Tag>)}</div></section>
    <details className="rc-raw"><summary>原始 JSON</summary><pre className="rc-code">{text}</pre></details>
  </div>
}

function useLogStream(input, enabled, paused, tick) {
  const key = JSON.stringify(input)
  const [state, setState] = useState({ key: '', text: '', status: '', error: '', truncated: false })
  useEffect(() => {
    if (!enabled || paused) {
      setState(old => old.key === key ? { ...old, status: paused ? '已暂停' : '', error: '' } : { key, text: '', status: paused ? '已暂停' : '', error: '', truncated: false })
      return
    }
    const abort = new AbortController()
    let chunks = '', trimmed = false
    setState({ key, text: '', status: '连接中…', error: '', truncated: false })
    const flush = () => {
      if (!chunks || abort.signal.aborted) return
      const next = chunks; chunks = ''
      setState(old => {
        let text = old.text + next
        if (text.length > 1048576) { text = text.slice(-1048576); text = text.slice(text.indexOf('\n') + 1); trimmed = true }
        const lines = text.split('\n')
        if (lines.length > 10001) { text = lines.slice(-10001).join('\n'); trimmed = true }
        return { ...old, text, truncated: old.truncated || trimmed }
      })
    }
    const timer = setInterval(flush, 100)
    streamLogs(input, abort.signal, event => {
      if (abort.signal.aborted) return
      if (event.type === 'log') {
        chunks += event.text
        if (chunks.length > 1048576) { chunks = chunks.slice(-1048576); chunks = chunks.slice(chunks.indexOf('\n') + 1); trimmed = true }
      } else { flush(); setState(old => ({ ...old, status: event.type === 'ready' ? '实时跟随中' : '日志流已结束' })) }
    }).catch(error => { if (!abort.signal.aborted) { flush(); setState(old => ({ ...old, status: '日志已断开', error: error.message })) } })
    return () => { clearInterval(timer); abort.abort() }
  }, [key, enabled, paused, tick])
  return state.key === key ? state : { text: '', status: '连接中…', error: '', truncated: false }
}

function LogViewer({ text, loading, live, scroll, setScroll, filename }) {
  const viewport = useRef()
  const virtualList = useRef()
  const [wrap, setWrap] = useState(true)
  const [numbers, setNumbers] = useState(true)
  const [fontSize, setFontSize] = useState('12')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const { lines, visible, matches, capped } = useMemo(() => {
    const lines = text ? text.replace(/\n$/, '').split('\n') : []
    const needle = query.toLowerCase()
    const matches = []
    let capped = false
    const rows = lines.map((line, index) => {
      const hits = []
      if (needle) {
        const lower = line.toLowerCase()
        let start = 0, at
        while ((at = lower.indexOf(needle, start)) !== -1) {
          if (matches.length >= 2000) { capped = true; break }
          hits.push({ at, id: matches.length }); matches.push(index); start = at + needle.length
        }
      }
      return { text: line, hits, index }
    })
    const visible = needle ? rows.filter(row => row.text.toLowerCase().includes(needle)) : rows
    return { lines: rows, visible, matches, capped }
  }, [text, query])
  const selected = matches.length ? Math.min(active, matches.length - 1) : 0
  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    if (!query || !matches.length) return
    const index = visible.findIndex(line => line.index === matches[selected])
    if (index !== -1) virtualList.current?.scrollToIndex({ index, align: 'center' })
    const frame = requestAnimationFrame(() => viewport.current?.querySelector(`[data-hit="${selected}"]`)?.scrollIntoView({ block: 'center', inline: 'nearest' }))
    return () => cancelAnimationFrame(frame)
  }, [selected, query, matches.length])
  useLayoutEffect(() => { if (scroll && visible.length) virtualList.current?.scrollToIndex({ index: visible.length - 1, align: 'end' }) }, [text, scroll, wrap, fontSize, visible.length])
  const move = direction => { if (matches.length) { setScroll(false); setActive((selected + direction + matches.length) % matches.length) } }
  const latest = () => { setScroll(true); virtualList.current?.scrollToIndex({ index: visible.length - 1, align: 'end' }) }
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="rc-log-reader">
    <div className="rc-log-reading-toolbar">
      <div className="rc-log-search"><Input aria-label="搜索日志" placeholder="搜索日志 · ⌘/Ctrl F" icon={<Search size={13} />} value={query}
        onChange={event => { setQuery(event.target.value); if (event.target.value) setScroll(false) }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1) } else if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery('') } }} /></div>
      {query && <><span className="rc-log-match-count" role="status">{matches.length ? selected + 1 : 0}/{matches.length}{capped ? '+' : ''}</span><Button icon={ArrowUp} title="上一个匹配" disabled={!matches.length} onClick={() => move(-1)} /><Button icon={ArrowDown} title="下一个匹配" disabled={!matches.length} onClick={() => move(1)} /><Button icon={X} title="清除日志搜索" onClick={() => setQuery('')} /></>}
      <span className="rc-spacer" /><Checkbox className="rc-check" label="自动换行" checked={wrap} onChange={setWrap} /><Checkbox className="rc-check" label="行号" checked={numbers} onChange={setNumbers} />
      <Select label="日志字号" value={fontSize} onChange={setFontSize} items={['11', '12', '13', '14', '16'].map(value => ({ value, label: `${value}px` }))} />
    </div>
    <div className="rc-log-viewport"
      onWheel={event => { if (event.deltaY < 0) setScroll(false) }}
      onKeyDown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) setScroll(false) }}
      onScrollCapture={event => { const element = event.target; if (element === viewport.current && element.scrollHeight - element.scrollTop - element.clientHeight > 32) setScroll(false) }}>
      {loading || !visible.length ? <div className="rc-code rc-logs" aria-label="Pod 日志" tabIndex={0}>{loading ? '加载中…' : query && lines.length ? '没有匹配的日志' : live ? '等待容器日志…' : '暂无内容'}</div> : <Virtuoso ref={virtualList} scrollerRef={element => { viewport.current = element }}
        className={`rc-code rc-logs ${wrap ? 'rc-log-wrap' : ''} ${numbers ? 'rc-log-numbers' : ''}`} style={{ fontSize: `${fontSize}px` }} aria-label="Pod 日志" tabIndex={0}
        data={visible} increaseViewportBy={200} followOutput={scroll ? 'auto' : false} itemContent={(index, line) => {
        const parts = []; let start = 0
        for (const hit of line.hits) { parts.push(line.text.slice(start, hit.at), <mark key={hit.id} data-hit={hit.id} className={hit.id === selected ? 'rc-log-hit-active' : ''}>{line.text.slice(hit.at, hit.at + query.length)}</mark>); start = hit.at + query.length }
        parts.push(line.text.slice(start))
        return <div className="rc-log-line" data-line={line.index + 1}><span>{parts.length > 1 || line.text ? parts : '\u200b'}</span></div>
      }} />}
    </div>
    <div className="rc-log-bottom"><span>{query ? `${visible.length.toLocaleString()} / ${lines.length.toLocaleString()}` : lines.length.toLocaleString()} 行 · {live ? '实时缓冲' : '当前快照'}{query ? ' · 仅显示匹配行' : ''}</span><span className="rc-spacer" /><Button icon={ChevronsDown} className="ghost" onClick={latest}>跳到最新</Button><Button icon={Download} className="ghost" disabled={!text} onClick={download}>下载日志</Button></div>
  </div>
}

function PodDialog({ pod, scope, close, context }) {
  const tabsId = useId()
  const [tab, setTab] = useState('logs')
  const [container, setContainer] = useState(pod.containerNames?.[0] || '')
  const [tail, setTail] = useState('200')
  const [since, setSince] = useState('')
  const [previous, setPrevious] = useState(false)
  const [copied, setCopied] = useState(false)
  const [follow, setFollow] = useState(true)
  const [paused, setPaused] = useState(false)
  const [scroll, setScroll] = useState(true)
  const [tick, setTick] = useState(0)
  const input = { ...scope, namespaces: undefined, namespace: pod.namespace, name: pod.name, operation: tab === 'logs' ? 'logs' : 'pod', container, tailLines: Number(tail), sinceSeconds: since ? Number(since) : undefined, previous }
  const live = tab === 'logs' && follow && !previous
  const result = useData(JSON.stringify(input), signal => run(input, signal), !live)
  const stream = useLogStream(input, live, paused, tick)
  const samples = useData(`pod-metrics:${scope.connectionId}:${scope.clusterId}:${pod.namespace}`, signal => run({ ...scope, namespaces: undefined, namespace: pod.namespace, operation: 'pod-metrics' }, signal), tab === 'detail')
  const sample = samples.data?.find(item => item.name === pod.name)
  const containers = [...(pod.containerNames || []), ...(pod.initContainerNames || [])]
  const text = tab === 'logs' ? live ? stream.text : result.data?.text || '' : JSON.stringify(result.data, null, 2)
  const reload = () => { setPaused(false); setTick(value => value + 1); result.reload() }
  useEffect(() => { setCopied(false); setPaused(false) }, [container, tail, since, previous, follow])
  return <Modal title={`${pod.namespace} / ${pod.name}`} close={close} wide drawer resizable onKeyDownCapture={event => {
    if (tab === 'logs' && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); const input = event.currentTarget.querySelector('[aria-label="搜索日志"]'); input?.focus(); input?.select() }
  }}>
    <div className="rc-pod-facts"><State good={healthy(pod, 'pods')} bad={!healthy(pod, 'pods')}>{pod.status}</State><span>就绪 <strong>{pod.ready}/{pod.containers}</strong></span><span>重启 <strong>{pod.restarts}</strong></span><span>{context}</span></div>
    <div className="rc-row"><Tabs id={tabsId} label="Pod 内容" items={[['logs', '日志', FileText], ['detail', '详情', Box]]} value={tab} onChange={setTab} /><span className="rc-spacer" /><Button icon={copied ? Check : Copy} title="复制内容" disabled={!text} onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true) } catch { setCopied(false) } }} /><Button icon={RefreshCw} title="刷新内容" disabled={!live && result.loading} onClick={reload} /></div>
    <section className="rc-pod-panel" role="tabpanel" id={`${tabsId}-${tab}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
    {tab === 'logs' && <div className="rc-log-source-toolbar"><Field label="容器"><Select label="容器" value={container} onChange={setContainer} items={containers.map(name => ({ value: name, label: name }))} /></Field><Field label="时间范围"><Select label="日志时间范围" value={since} onChange={setSince} items={[{ value: '', label: '不限时间' }, { value: '300', label: '最近 5 分钟' }, { value: '900', label: '最近 15 分钟' }, { value: '3600', label: '最近 1 小时' }, { value: '21600', label: '最近 6 小时' }, { value: '86400', label: '最近 24 小时' }]} /></Field><Field label="末尾行数"><Select label="末尾行数" value={tail} onChange={setTail} items={['100', '200', '500', '1000', '5000'].map(n => ({ value: n, label: n }))} /></Field><Checkbox className="rc-check" label="上一次容器日志" checked={previous} onChange={setPrevious} /></div>}
    {tab === 'detail' && <div className="rc-metrics-status">{samples.error ? `指标不可用：${samples.error}` : samples.loading ? '读取容器指标中…' : `指标采样 ${date(sample?.timestamp)} · 窗口 ${sample?.window || '—'}`}<Button icon={RefreshCw} title="刷新容器指标" onClick={samples.reload} disabled={samples.loading} /></div>}
    {tab === 'logs' && <div className="rc-log-toolbar"><Checkbox className="rc-check" label="实时跟随" checked={follow && !previous} disabled={previous} onChange={setFollow} /><Checkbox className="rc-check" label="自动滚动" checked={scroll} onChange={setScroll} />{live && <Button onClick={() => setPaused(value => !value)}>{paused ? '继续跟随' : '暂停日志'}</Button>}<span className="rc-log-status" role="status"><State good={live && stream.status === '实时跟随中'} bad={live && !!stream.error}>{live ? stream.status : previous ? '上次实例 · 快照' : '日志快照'}</State></span>{stream.truncated && live && <span className="rc-muted">已保留最近 10,000 行 / 1 MiB</span>}</div>}
    <ErrorMessage error={live ? stream.error : result.error} retry={reload} />{tab === 'logs' ? <LogViewer text={text} loading={!live && result.loading} live={live} scroll={scroll} setScroll={setScroll} filename={`${pod.namespace}_${pod.name}_${container || 'container'}.log`} /> : result.data ? <PodDetails data={result.data} text={text} usage={sample} /> : <pre className="rc-code">{result.loading ? '加载中…' : '暂无内容'}</pre>}
    </section>
  </Modal>
}

function NodeDialog({ node, close }) {
  return <Modal title={`节点 / ${node.name}`} close={close} wide drawer><div className="rc-detail">
    <section className="rc-detail-section"><h4>资源占用</h4><dl className="rc-facts"><dt>CPU 实际用量</dt><dd>{cpuUsage(node.cpuUsage)}</dd><dt>内存实际用量</dt><dd>{memUsage(node.memoryUsage)}</dd><dt>可分配 CPU</dt><dd>{cpuUsage(node.allocatable?.cpuCores)}</dd><dt>可分配内存</dt><dd>{memUsage(node.allocatable?.memoryBytes)}</dd><dt>总 CPU</dt><dd>{cpuUsage(node.capacity?.cpuCores)}</dd><dt>总内存</dt><dd>{memUsage(node.capacity?.memoryBytes)}</dd><dt>Pod 容量</dt><dd>{node.podCapacity ?? '—'}</dd><dt>采样时间</dt><dd>{date(node.usage?.timestamp)} · {node.usage?.window || '—'}</dd></dl></section>
    <section className="rc-detail-section"><h4>系统信息</h4><dl className="rc-facts"><dt>Internal IP</dt><dd>{node.ip}</dd><dt>版本</dt><dd>{node.version}</dd><dt>操作系统</dt><dd>{node.os || '—'}</dd><dt>架构</dt><dd>{node.architecture || '—'}</dd><dt>容器运行时</dt><dd>{node.runtime || '—'}</dd><dt>创建时间</dt><dd>{date(node.createdAt)}</dd></dl></section>
    <section className="rc-detail-section"><h4>节点条件</h4>{node.conditions.map(condition => <div className="rc-row" key={condition.type}><State good={condition.type === 'Ready' ? condition.status === 'True' : condition.type.endsWith('Pressure') ? condition.status === 'False' : false} bad={condition.type.endsWith('Pressure') && condition.status === 'True'}>{condition.type}: {condition.status}</State><span className="rc-muted">{condition.reason}</span></div>)}</section>
  </div></Modal>
}

function Workbench({ openSettings }) {
  const tabsId = useId()
  const view = useRancherView()
  const { connectionId, revision: connectionRevision } = view
  const connections = useData(`connections:${connectionRevision}`, signal => api('/connections', { signal }))
  const [clusterId, setClusterId] = useState('')
  const [namespace, setNamespace] = useState([])
  const [groupBy, setGroupBy] = useState('')
  const [collapsed, setCollapsed] = useState(new Set())
  const [tab, setTab] = useState('nodes')
  const [search, setSearch] = useState('')
  const [auto, setAuto] = useState(false)
  const [node, setNode] = useState('')
  const [action, setAction] = useState(null)
  const [pod, setPod] = useState(null)
  const [nodeDetail, setNodeDetail] = useState(null)
  const [notice, setNotice] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [sort, setSort] = useState({ key: '', descending: false })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [podPaging, setPodPaging] = useState({ key: '', index: 0, cursors: [null] })
  const tableRef = useRef()
  const list = connections.data || []
  const connection = list.find(item => item.id === connectionId)
  useEffect(() => { if (connections.data && !list.some(item => item.id === connectionId)) chooseConnection(list[0]?.id || '') }, [connections.data])
  const clusters = useData(`clusters:${connectionId}:${connectionRevision}`, signal => run({ connectionId, operation: 'clusters' }, signal), Boolean(connection))
  useEffect(() => { if (clusters.data) setClusterId(current => clusters.data.some(item => item.id === current) ? current : clusters.data[0]?.id || '') }, [clusters.data])
  const namespaces = useData(`namespaces:${connectionId}:${clusterId}:${connectionRevision}`, signal => run({ connectionId, clusterId, operation: 'namespaces' }, signal), Boolean(connection && clusterId))
  useEffect(() => {
    if (namespaces.data) setNamespace(current => {
      const valid = current.filter(name => namespaces.data.some(item => item.name === name))
      return valid.length === current.length ? current : valid
    })
  }, [namespaces.data])
  const clusterScoped = tab === 'nodes'
  const scope = { connectionId, clusterId, ...(clusterScoped ? {} : { namespaces: namespace }) }
  const podScopeKey = JSON.stringify({ ...scope, connectionRevision, node, pageSize })
  const activePodPaging = podPaging.key === podScopeKey ? podPaging : { key: podScopeKey, index: 0, cursors: [null] }
  const resourceKey = JSON.stringify({ ...scope, connectionRevision, tab, node: tab === 'pods' ? node : '', ...(tab === 'pods' ? { pageSize, cursor: activePodPaging.cursors[activePodPaging.index] } : {}) })
  const resources = useData(resourceKey, signal => tab === 'pods'
    ? pagePods({ ...scope, node, pageSize, cursor: activePodPaging.cursors[activePodPaging.index] }, signal)
    : run({ ...scope, operation: tab }, signal), Boolean(connection && clusterId), auto)
  const hasMetrics = tab === 'nodes' || tab === 'pods'
  const metricScope = { connectionId, clusterId, ...(tab === 'pods' ? { namespaces: namespace } : {}), operation: tab === 'nodes' ? 'node-metrics' : 'pod-metrics', connectionRevision }
  const metrics = useData(JSON.stringify(metricScope), signal => run(metricScope, signal), Boolean(connection && clusterId && hasMetrics), auto)
  function refresh() {
    if (tab === 'pods' && activePodPaging.index) setPodPaging({ key: podScopeKey, index: 0, cursors: [null] })
    else resources.reload()
    namespaces.reload()
    if (hasMetrics) metrics.reload()
  }
  useEffect(() => { setAction(null); setPod(null); setNodeDetail(null); setSearch(''); setStatusFilter(''); setSort({ key: '', descending: false }); setNotice('') }, [connectionId, clusterId, namespace, tab, node])
  useEffect(() => { setPage(1) }, [resourceKey, search, statusFilter, sort, pageSize, groupBy])
  useEffect(() => { setCollapsed(new Set()) }, [connectionId, clusterId, namespace, groupBy])
  function chooseConnection(value) {
    if (value !== connectionId) { selectConnection(value); setClusterId(''); setNamespace([]); setNode(''); setAction(null); setPod(null) }
  }
  function chooseCluster(value) { setClusterId(value); setNamespace([]); setNode('') }
  function chooseNamespace(value) { setNamespace(Array.isArray(value) ? value : value ? [value] : []); setNode('') }
  const metricMap = new Map((metrics.data || []).map(item => [`${item.namespace}/${item.name}`, item]))
  const allRows = (tab === 'pods' ? resources.data?.items || [] : resources.data || []).map(row => {
    const usage = metricMap.get(`${row.namespace}/${row.name}`)
    // A Pod sample can include restartable init containers; only compare to
    // application-container limits when the sampled container set matches.
    const comparable = row.containerNames?.length === usage?.containers?.length && row.containerNames?.every(name => usage.containers.some(item => item.name === name))
    return { ...row, usage, cpuUsage: usage?.cpuCores, memoryUsage: usage?.memoryBytes, resources: row.resources && { ...row.resources, limits: comparable ? row.resources.limits : {} } }
  })
  const rows = allRows.filter(row => JSON.stringify(row).toLowerCase().includes(search.toLowerCase()) && (!statusFilter || (tab === 'services' ? row.type === statusFilter : healthy(row, tab) === (statusFilter === 'healthy'))))
  if (sort.key) rows.sort((a, b) => {
    const left = a[sort.key], right = b[sort.key]
    if (left == null || right == null) return left == null && right == null ? 0 : left == null ? 1 : -1
    const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true })
    return sort.descending ? -order : order
  })
  const grouped = tab === 'pods' && groupBy
  const groupKey = row => row[groupBy] || (groupBy === 'node' ? '尚未调度' : '未指定命名空间')
  const groups = new Map()
  if (grouped) {
    for (const row of rows) { const key = groupKey(row); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row) }
    rows.splice(0, rows.length, ...[...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).flatMap(key => groups.get(key)))
  }
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const currentPage = tab === 'pods' ? activePodPaging.index + 1 : Math.min(page, pages)
  const offset = (currentPage - 1) * pageSize
  const visibleRows = tab === 'pods' ? rows : rows.slice(offset, offset + pageSize)
  const nextPodCursor = tab === 'pods' ? resources.data?.nextCursor : null
  const turnPage = direction => {
    if (tab !== 'pods') return setPage(currentPage + direction)
    setPodPaging(old => {
      const current = old.key === podScopeKey ? old : { key: podScopeKey, index: 0, cursors: [null] }
      if (direction < 0) return { ...current, index: Math.max(0, current.index - 1) }
      return { ...current, index: current.index + 1, cursors: [...current.cursors.slice(0, current.index + 1), nextPodCursor] }
    })
  }
  useEffect(() => { if (tableRef.current) { tableRef.current.scrollTop = 0; tableRef.current.scrollLeft = 0 } }, [resourceKey, search, statusFilter, sort, currentPage, pageSize])
  const writable = connection?.allowWrites && !resources.loading && !resources.error
  const cluster = clusters.data?.find(item => item.id === clusterId)
  const clusterName = cluster?.name || clusterId
  const resourceLabel = TABS.find(([key]) => key === tab)?.[1]
  const goodCount = allRows.filter(row => healthy(row, tab)).length
  function manage(operation, label, row) { setAction({ operation, label, row, scope: { ...scope }, connectionName: connection.name, clusterName }) }
  const buttons = (row, type) => type === 'nodes' ? <div className="rc-row">
    <Button icon={Activity} title={`查看 ${row.name} 节点详情`} onClick={() => setNodeDetail(row)} />
    <Button icon={Box} title={`查看 ${row.name} 的 Pods`} disabled={resources.loading} onClick={() => { setNamespace([]); setNode(row.name); setTab('pods') }} />
    <Button icon={row.unschedulable ? Unlock : Lock} title={row.unschedulable ? '解封节点' : '封锁节点'} disabled={!writable} onClick={() => manage(row.unschedulable ? 'uncordon' : 'cordon', row.unschedulable ? '解封节点' : '封锁节点', row)} />
  </div> : type === 'pods' ? <div className="rc-row">
    <Button icon={FileText} title={`查看 ${row.name} 日志与详情`} onClick={() => setPod(row)} />
    <Button icon={Trash2} title={`删除 ${row.name}`} className="danger" disabled={!writable} onClick={() => manage('delete-pod', '删除 Pod', row)} />
  </div> : <div className="rc-row"><Button icon={RotateCw} title={`重启 ${row.name}`} disabled={!writable} onClick={() => manage('restart-deployment', '滚动重启 Deployment', row)} /><Button icon={Scaling} title={`扩缩容 ${row.name}`} disabled={!writable} onClick={() => manage('scale-deployment', '扩缩容 Deployment', row)} /></div>
  const columns = tab === 'nodes' ? [['节点', 'name'], ['状态', 'ready'], ['调度', 'unschedulable'], ['CPU 用量', 'cpuUsage'], ['内存用量', 'memoryUsage'], ['可分配 CPU / 内存'], ['角色'], ['Internal IP', 'ip'], ['版本', 'version'], ['操作']]
    : tab === 'pods' ? [['Pod', 'name'], ['命名空间', 'namespace'], ['状态', 'status'], ['就绪', 'ready'], ['重启', 'restarts'], ['CPU 用量', 'cpuUsage'], ['内存用量', 'memoryUsage'], ['容器请求 CPU / 内存'], ['QoS', 'qosClass'], ['节点', 'node'], ['Pod IP', 'ip'], ['存活时间', 'createdAt'], ['操作']]
    : tab === 'deployments' ? [['Deployment', 'name'], ['命名空间', 'namespace'], ['就绪 / 目标', 'ready'], ['可用', 'available'], ['镜像'], ['操作']]
    : tab === 'services' ? [['服务', 'name'], ['命名空间', 'namespace'], ['类型', 'type'], ['Cluster IP', 'clusterIP'], ['端口'], ['外部地址']] : [['级别', 'type'], ['资源', 'object'], ['原因', 'reason'], ['事件'], ['次数', 'count'], ['最近发生', 'lastTimestamp']]
  return <>
    <header className="rc-heading"><div className="rc-brand"><RancherIcon /><h2>Rancher 工作台</h2><div className="rc-heading-meta"><span>{list.length} 个连接</span></div></div><div className="rc-row"><span className="rc-heading-meta">{connection && <><ShieldCheck />{connection.allowWrites ? '管理已启用' : '只读连接'}</>}</span><Button icon={Settings2} className="ghost" onClick={openSettings}>连接设置</Button></div></header>
    <ErrorMessage error={connections.error} retry={connections.reload} />
    <ErrorMessage error={clusters.error} retry={clusters.reload} />
    <div className="rc-scope"><Field label="Rancher 连接"><Select label="Rancher 连接" value={connectionId} onChange={chooseConnection} items={[{ value: '', label: '选择连接', disabled: true }, ...list.map(item => ({ value: item.id, label: `${item.name}${item.allowWrites ? '' : ' · 只读'}` }))]} /></Field>
      <Field label="集群"><Select label="集群" value={clusterId} disabled={!connection || clusters.loading} onChange={chooseCluster} items={[{ value: '', label: clusters.loading ? '正在加载集群…' : '选择集群', disabled: true }, ...(clusters.data || []).map(item => ({ value: item.id, label: `${item.name} · ${item.state || 'unknown'}` }))]} /></Field>
      <Field label="命名空间"><NamespaceSelect value={namespace} disabled={!clusterId || clusterScoped} clusterScoped={clusterScoped} onChange={chooseNamespace} items={(namespaces.data || []).map(item => item.name)} /></Field></div>
    {connection && <div className="rc-context"><span className="rc-connection-address" title={connection.url}>{connection.url}</span>{cluster?.version && <span>{cluster.version}</span>}{namespaces.data && <span>{namespaces.data.length} 个命名空间</span>}<span role="status" title={clusters.error || `可访问 ${clusters.data?.length || 0} 个集群`}><State good={!!clusters.data && !clusters.loading && !clusters.error} bad={!!clusters.error}>{clusters.loading ? '连接中…' : clusters.error ? '连接失败' : clusters.data ? `已连接 ${connection.name}` : '等待连接'}</State></span></div>}
    <Tabs id={tabsId} label="资源类型" items={TABS} value={tab} onChange={setTab} />
    <section className="rc-resources" role="tabpanel" id={`${tabsId}-${tab}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
      <ErrorMessage error={namespaces.error} retry={namespaces.reload} />
      {!connection ? <Empty>请先添加 Rancher 连接<Button icon={Plus} onClick={openSettings}>配置连接</Button></Empty> : !clusterId ? <Empty>{clusters.loading ? '正在加载集群…' : clusters.error ? '集群加载失败，请查看上方错误并重试' : '没有可访问的集群'}</Empty> : <>
        <div className="rc-toolbar"><div className="rc-resource-title"><h3>{resourceLabel}</h3><span>{tab === 'pods' ? `第 ${currentPage} 页 · ${allRows.length} 项` : `${allRows.length} 项`}</span></div><div className="rc-search"><Input icon={<Search size={15} />} className="rc-input" aria-label="筛选资源" placeholder={tab === 'pods' ? '筛选本页名称、命名空间、IP…' : '搜索名称、命名空间、IP…'} value={search} onChange={e => setSearch(e.target.value)} />{search && <Button icon={X} className="ghost" title="清除搜索" onClick={() => setSearch('')} />}</div>
          <Select className="rc-status-filter" label="资源状态筛选" value={statusFilter} onChange={setStatusFilter} items={[{ value: '', label: tab === 'services' ? '全部服务类型' : '全部状态' }, ...(tab === 'services' ? [...new Set(allRows.map(row => row.type))].sort().map(type => ({ value: type, label: type })) : [{ value: 'healthy', label: tab === 'events' ? 'Normal' : '正常' }, { value: 'attention', label: tab === 'events' ? 'Warning' : '待关注' }])]} />
          {tab === 'pods' && <><SegmentedTabs label="Pod 布局" className="rc-layout-tabs" value={groupBy} onChange={setGroupBy}
            items={[['', '平铺列表', Rows3], ['namespace', '按命名空间分组', Layers], ['node', '按节点分组', Network]].map(([value, label, Icon]) => ({ value, id: `${tabsId}-layout-${value || 'flat'}`, panelId: `${tabsId}-layout-${value || 'flat'}-panel`, label: <span className="rc-tab-label" title={label}><Icon size={14} aria-hidden="true" /><span className="rc-sr-only">{label}</span></span> }))} />{grouped && <Button title={collapsed.size ? '展开全部分组' : '折叠全部分组'} icon={collapsed.size ? ChevronDown : ChevronRight} onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(groups.keys()))} />}</>}
          {tab === 'pods' && node && <Button icon={X} title="清除节点筛选" onClick={() => setNode('')}>{node}</Button>}<div className="rc-refresh-control"><Checkbox className="rc-check" label="15 秒刷新" checked={auto} onChange={setAuto} /><Button icon={RefreshCw} className={`ghost ${resources.loading ? 'rc-spin' : ''}`} title="刷新资源" onClick={refresh} disabled={resources.loading} /></div></div>
        {notice && <p className={notice.done ? 'rc-success' : 'rc-muted'} role="status">{notice.message}</p>}<ErrorMessage error={resources.error} retry={resources.reload} />
        <div className="rc-summary"><span>{tab === 'pods' ? '本页' : '共'} <strong>{allRows.length}</strong> 项</span>{tab !== 'services' && <><span className="rc-summary-ok"><strong>{goodCount}</strong>{tab === 'nodes' ? '健康' : tab === 'events' ? 'Normal' : '正常'}</span><span className={allRows.length > goodCount ? 'rc-summary-alert' : ''}><strong>{allRows.length - goodCount}</strong>{tab === 'events' ? 'Warning' : '待关注'}</span></>}{tab === 'nodes' && <span><strong>{allRows.filter(row => row.unschedulable).length}</strong>已封锁</span>}{tab === 'pods' && <span>本页重启 <strong>{allRows.reduce((sum, row) => sum + row.restarts, 0)}</strong></span>}{tab === 'services' && <span><strong>{allRows.filter(row => row.type !== 'ClusterIP').length}</strong>对外服务</span>}<span className="rc-spacer" />{(search || statusFilter) && <span>{tab === 'pods' ? '本页匹配' : '匹配'} <strong>{rows.length}</strong> 项</span>}</div>
        <div className="rc-resource-body" {...(tab === 'pods' ? { role: 'tabpanel', id: `${tabsId}-layout-${groupBy || 'flat'}-panel`, 'aria-labelledby': `${tabsId}-layout-${groupBy || 'flat'}` } : {})}>
        {resources.loading && resources.data === null ? <LoadingRows /> : rows.length ? <div ref={tableRef} className={`rc-table-wrap ${resources.loading && tab !== 'pods' ? 'rc-loading' : ''}`} aria-busy={resources.loading}><table className={`rc-table ${['nodes', 'pods', 'deployments'].includes(tab) ? 'has-actions' : ''}`}><thead><tr>{columns.map(([label, key]) => <th key={label} aria-sort={key && sort.key === key ? sort.descending ? 'descending' : 'ascending' : undefined}>{key ? <Button className="ghost rc-sort" aria-label={`按${label}排序`} aria-pressed={sort.key === key} onClick={() => setSort({ key, descending: sort.key === key && !sort.descending })}>{label}{sort.key === key ? sort.descending ? <ArrowDown /> : <ArrowUp /> : <ArrowUpDown size={12} />}</Button> : label}</th>)}</tr></thead><tbody>{visibleRows.map((row, index) => <React.Fragment key={idOf(row)}>
          {grouped && (index === 0 || groupKey(visibleRows[index - 1]) !== groupKey(row)) && <tr className="rc-group-row"><td colSpan={columns.length}><div className="rc-group-content"><Button className="ghost rc-group-toggle" icon={collapsed.has(groupKey(row)) ? ChevronRight : ChevronDown} aria-expanded={!collapsed.has(groupKey(row))} title={`分组 ${groupKey(row)}`} onClick={() => setCollapsed(current => { const next = new Set(current); next.has(groupKey(row)) ? next.delete(groupKey(row)) : next.add(groupKey(row)); return next })}>{groupKey(row)}</Button><Tag tone="quiet">{groups.get(groupKey(row)).length} Pods · 本页</Tag><span className="rc-muted">{groups.get(groupKey(row)).filter(item => !healthy(item, 'pods')).length} 待关注</span><span className="rc-muted">CPU {cpuUsage(groups.get(groupKey(row)).some(item => item.cpuUsage != null) ? groups.get(groupKey(row)).reduce((sum, item) => sum + (item.cpuUsage || 0), 0) : null)} · 内存 {memUsage(groups.get(groupKey(row)).some(item => item.memoryUsage != null) ? groups.get(groupKey(row)).reduce((sum, item) => sum + (item.memoryUsage || 0), 0) : null)}（已有采样）</span><span className="rc-muted">当前显示 {visibleRows.filter(item => groupKey(item) === groupKey(row)).length} 项</span></div></td></tr>}
          {(!grouped || !collapsed.has(groupKey(row))) && <tr className={grouped ? 'rc-tree-child' : ''}>
          {tab === 'nodes' && <><td className="name" title={`${row.name}\n${row.os} · ${row.architecture}\n${row.runtime} · Pod 容量 ${row.podCapacity ?? '—'}`}>{row.name}</td><td><State good={healthy(row, tab)} bad={!healthy(row, tab)}>{row.ready ? 'Ready' : 'NotReady'}</State>{row.pressure?.length > 0 && <span className="rc-warning" title={row.pressure.join(', ')}> · 资源压力</span>}</td><td>{row.unschedulable ? <State>已封锁</State> : <span className="rc-muted">可调度</span>}</td><td><ResourceUsage kind="cpu" value={row.cpuUsage} total={row.allocatable?.cpuCores} stale={!!metrics.error} title={`采样 ${date(row.usage?.timestamp)} · 窗口 ${row.usage?.window || '—'}`} /></td><td><ResourceUsage kind="memory" value={row.memoryUsage} total={row.allocatable?.memoryBytes} stale={!!metrics.error} title={`采样 ${date(row.usage?.timestamp)} · 窗口 ${row.usage?.window || '—'}`} /></td><td title={`CPU: ${row.cpu} · 内存: ${row.memory}`}><strong>{cpu(quantity(row.cpu))}</strong><span className="rc-muted"> 核 / </span>{memory(row.memory)}</td><td><div className="rc-row">{(row.roles.length ? row.roles : ['worker']).map(role => <Tag tone="neutral" key={role}>{role}</Tag>)}</div></td><td className="rc-mono">{row.ip || '—'}</td><td className="rc-mono">{row.version}</td><td>{buttons(row, tab)}</td></>}
          {tab === 'pods' && <><td className="name" title={row.name}><Button className="ghost rc-link" onClick={() => setPod(row)}>{row.name}</Button></td><td><Button className="ghost rc-link" title={`筛选命名空间 ${row.namespace}`} onClick={() => chooseNamespace(row.namespace)}><Tag tone="neutral">{row.namespace}</Tag></Button></td><td><State good={healthy(row, tab)} bad={!healthy(row, tab)}>{row.status}</State></td><td>{row.ready}/{row.containers}</td><td className={row.restarts > 0 ? 'rc-warning' : 'rc-muted'}>{row.restarts}</td><td><ResourceUsage kind="cpu" value={row.cpuUsage} total={row.resources?.limits.cpuCores} stale={!!metrics.error} title={`容器上限合计 ${cpuUsage(row.resources?.limits.cpuCores)} · 采样 ${date(row.usage?.timestamp)}`} /></td><td><ResourceUsage kind="memory" value={row.memoryUsage} total={row.resources?.limits.memoryBytes} stale={!!metrics.error} title={`容器上限合计 ${memUsage(row.resources?.limits.memoryBytes)} · 采样 ${date(row.usage?.timestamp)}`} /></td><td className="rc-mono" title="普通容器请求合计；未完整配置时显示 —，初始化容器见详情">{cpuUsage(row.resources?.requests.cpuCores)} / {memUsage(row.resources?.requests.memoryBytes)}</td><td><Tag tone="quiet">{row.qosClass || '—'}</Tag></td><td>{row.node || '—'}</td><td className="rc-mono">{row.ip || '—'}</td><td title={date(row.createdAt)} className="rc-muted">{age(row.createdAt)}</td><td>{buttons(row, tab)}</td></>}
          {tab === 'deployments' && <><td className="name" title={row.name}>{row.name}</td><td><Tag tone="neutral">{row.namespace}</Tag></td><td><State good={healthy(row, tab)} bad={!healthy(row, tab)}>{row.ready} / {row.replicas}</State></td><td>{row.available}</td><td><span className="rc-ellipsis rc-mono" title={row.images.join(', ')}>{row.images.join(', ')}</span></td><td>{buttons(row, tab)}</td></>}
          {tab === 'services' && <><td className="name">{row.name}</td><td><Tag tone="neutral">{row.namespace}</Tag></td><td><Tag tone="neutral">{row.type}</Tag></td><td className="rc-mono">{row.clusterIP}</td><td className="rc-mono">{row.ports.map(port => `${port.port} → ${port.targetPort}/${port.protocol}${port.nodePort ? ` · ${port.nodePort}` : ''}`).join(', ')}</td><td className="rc-mono">{row.externalIPs?.map(item => item.ip || item.hostname).join(', ') || '—'}</td></>}
          {tab === 'events' && <><td><State bad={row.type === 'Warning'}>{row.type}</State></td><td>{row.object}<div className="rc-muted">{row.namespace}</div></td><td>{row.reason}</td><td className="rc-message">{row.message}</td><td>{row.count}</td><td>{date(row.lastTimestamp)}</td></>}
        </tr>}</React.Fragment>)}</tbody></table></div> : <Empty>{resources.error ? '资源读取失败，请重试' : search || statusFilter ? '没有匹配的资源' : '此范围下暂无资源'}</Empty>}
        </div>
        <footer className="rc-footer"><span>{resources.at ? `更新于 ${resources.at.toLocaleTimeString()}` : '尚未更新'}{resources.loading ? ' · 刷新中…' : ''}</span>
          {hasMetrics && <div className="rc-metrics-status" role="status"><Activity size={12} /><span title={metrics.error || `最早采样 ${date(metrics.data?.map(item => item.timestamp).filter(Boolean).sort()[0])}`}>{metrics.error ? `指标暂不可用${metrics.data ? '（保留上次采样）' : '，用量显示 —'}：${metrics.error}` : metrics.loading ? '正在读取 CPU / 内存指标…' : `已采样 ${allRows.filter(row => row.usage).length} / ${allRows.length} 项 · 最早采样 ${date(metrics.data?.map(item => item.timestamp).filter(Boolean).sort()[0])}`}</span>{metrics.error && <Button icon={RefreshCw} title="重试资源指标" onClick={metrics.reload} disabled={metrics.loading} />}<span className="rc-muted">{tab === 'nodes' ? '% / 可分配' : '% / 容器上限'}</span></div>}
          <div className="rc-pagination"><Select label="每页条数" value={pageSize} onChange={value => setPageSize(Number(value))} items={[25, 50, 100].map(size => ({ value: size, label: `${size} / 页` }))} /><span className="rc-page-range" aria-live="polite">{tab === 'pods' ? `${allRows.length} 项 / 本页` : `${rows.length ? `${offset + 1}–${Math.min(offset + pageSize, rows.length)}` : '0'} / ${rows.length}`}</span><Button icon={ChevronLeft} className="ghost" title="上一页" disabled={currentPage <= 1 || resources.loading} onClick={() => turnPage(-1)} /><span>{tab === 'pods' ? `第 ${currentPage} 页` : `${currentPage} / ${pages}`}</span><Button icon={ChevronRight} className="ghost" title="下一页" disabled={resources.loading || (tab === 'pods' ? !nextPodCursor : currentPage >= pages)} onClick={() => turnPage(1)} /></div></footer>
      </>}
    </section>
    {action && <ActionDialog action={action} scope={action.scope} close={() => setAction(null)} completed={(message, done = false) => { setNotice({ message, done }); resources.reload() }} />}
    {pod && <PodDialog pod={pod} scope={scope} context={`${connection?.name} · ${clusterName}`} close={() => setPod(null)} />}
    {nodeDetail && <NodeDialog node={allRows.find(item => item.name === nodeDetail.name) || nodeDetail} close={() => setNodeDetail(null)} />}
  </>
}

export function App() {
  const { connectionId } = useRancherView()
  const [settingsOpen, setSettingsOpen] = useState(false)
  return <div className="rc-root rc-workbench"><Workbench key={connectionId} openSettings={() => setSettingsOpen(true)} />
    {settingsOpen && <Modal title="Rancher 连接设置" close={() => setSettingsOpen(false)} wide><ConnectionSettings embedded onOpenWorkbench={() => setSettingsOpen(false)} /></Modal>}
  </div>
}
