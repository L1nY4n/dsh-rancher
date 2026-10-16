import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { check } from './errors.js'

export function normalizeUrl(value) {
  let url
  try { url = new URL(value) } catch { check(false, '请输入有效的 Rancher URL') }
  check(['https:', 'http:'].includes(url.protocol), '仅支持 HTTP / HTTPS')
  check(!url.username && !url.password && !url.search && !url.hash, 'URL 不能包含凭据、查询或片段')
  check(url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), '远程 Rancher 必须使用 HTTPS')
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v3$/, '')
  return url.href.replace(/\/+$/, '')
}

export class ConnectionStore {
  constructor(directory = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'rancher')) {
    this.directory = directory
    this.file = path.join(directory, 'connections.json')
    this.state = { connections: [] }
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      check(Array.isArray(this.state.connections), '连接配置文件格式错误')
      fs.chmodSync(this.file, 0o600)
    }
  }

  list() {
    return this.state.connections.map(({ token, password, secretKey, tlsFingerprint256, tlsCa, ...entry }) => ({
      ...entry,
      authType: entry.authType || (token ? 'token' : 'password'),
      hasCredential: Boolean(token || password || secretKey),
      hasToken: Boolean(token),
    }))
  }

  get(id) {
    const entry = this.state.connections.find(item => item.id === id)
    check(entry, 'Rancher 连接不存在', 404)
    return { ...entry }
  }

  prepare(input) {
    check(input && typeof input === 'object', '连接配置必须是对象')
    const old = input.id ? this.get(input.id) : undefined
    const name = String(input.name || '').trim()
    check(name && name.length <= 80, '连接名称必填且不超过 80 个字符')
    const url = normalizeUrl(input.url)
    const authType = input.authType || old?.authType || 'token'
    check(['token', 'password', 'access-secret'].includes(authType), '不支持的 Rancher 登录方式')
    const sameUrl = !old || url === old.url
    const token = input.token === '' || input.token === undefined ? old?.token : input.token
    const username = input.username === '' || input.username === undefined ? old?.username : input.username
    const password = input.password === '' || input.password === undefined ? old?.password : input.password
    const accessKey = input.accessKey === '' || input.accessKey === undefined ? old?.accessKey : input.accessKey
    const secretKey = input.secretKey === '' || input.secretKey === undefined ? old?.secretKey : input.secretKey
    check(sameUrl || input.token || input.password || input.secretKey, '更改服务器地址时需要重新填写认证信息')
    if (authType === 'token') check(typeof token === 'string' && token.trim() && !/[\r\n]/.test(token), '请输入有效的 API Token')
    if (authType === 'password') {
      check(typeof username === 'string' && username.trim() && !/[\r\n]/.test(username), '请输入 Rancher 用户名')
      check(typeof password === 'string' && password.trim() && !/[\r\n]/.test(password), '请输入 Rancher 密码')
    }
    if (authType === 'access-secret') {
      check(typeof accessKey === 'string' && accessKey.trim() && !/[\r\n]/.test(accessKey), '请输入 Access Key')
      check(typeof secretKey === 'string' && secretKey.trim() && !/[\r\n]/.test(secretKey), '请输入 Secret Key')
    }
    check(input.allowWrites === undefined || typeof input.allowWrites === 'boolean', 'allowWrites 必须是布尔值')
    const entry = { id: old?.id || randomUUID(), name, url, authType, allowWrites: input.allowWrites ?? old?.allowWrites ?? false }
    if (authType === 'token') entry.token = token.trim()
    if (authType === 'password') { entry.username = username.trim(); entry.password = password }
    if (authType === 'access-secret') { entry.accessKey = accessKey.trim(); entry.secretKey = secretKey }
    return entry
  }

  save(input) {
    const entry = this.prepare(input)
    const connections = this.state.connections.filter(item => item.id !== entry.id).concat(entry)
    this.persist({ connections })
    return this.list().find(item => item.id === entry.id)
  }

  remove(id) {
    this.get(id)
    this.persist({ connections: this.state.connections.filter(item => item.id !== id) })
    return { removed: true }
  }

  persist(state) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const tmp = path.join(this.directory, `.connections-${randomUUID()}.tmp`)
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      fs.renameSync(tmp, this.file)
      this.state = state
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    }
  }
}
