import http from 'node:http'
import https from 'node:https'
import { ApiError, check } from './errors.js'

const MAX_RESPONSE = 8 * 1024 * 1024

export function segment(value, label = '名称') {
  check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,252}$/.test(value) && !value.includes('..'), `${label}无效`)
  return encodeURIComponent(value)
}

export class RancherClient {
  constructor(connection) {
    this.connection = connection
    this.base = new URL(connection.url + '/')
    this.sessionToken = null
  }

  redact(text) {
    return [this.connection.token, this.sessionToken, this.connection.password, this.connection.secretKey].filter(Boolean)
      .reduce((value, secret) => value.split(secret).join('[REDACTED]'), String(text))
      .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]')
  }

  async authorization(signal) {
    signal?.throwIfAborted()
    if (this.connection.authType === 'password') {
      if (this.sessionToken) return `Bearer ${this.sessionToken}`
      const response = await this.request('v3-public/localProviders/local?action=login', {
        method: 'POST', body: { username: this.connection.username, password: this.connection.password, responseType: 'json' }, signal, noAuth: true,
      })
      check(typeof response.token === 'string' && response.token, 'Rancher 登录未返回会话 Token', 502)
      this.sessionToken = response.token
      return `Bearer ${this.sessionToken}`
    }
    if (this.connection.authType === 'access-secret') {
      check(this.connection.accessKey && this.connection.secretKey, 'Access Key / Secret Key 未配置', 400)
      return `Basic ${Buffer.from(`${this.connection.accessKey}:${this.connection.secretKey}`).toString('base64')}`
    }
    check(this.connection.token, 'API Token 未配置', 400)
    return `Bearer ${this.connection.token}`
  }

  async request(endpoint, { method = 'GET', body, text = false, signal, contentType = 'application/json', noAuth = false } = {}) {
    const target = new URL(endpoint.replace(/^\//, ''), this.base)
    check(target.origin === this.base.origin && target.pathname.startsWith(this.base.pathname), '拒绝向其它服务器发送凭据')
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const transport = target.protocol === 'https:' ? https : http
    const authorization = noAuth ? undefined : await this.authorization(signal)
    return new Promise((resolve, reject) => {
      const request = transport.request(target, {
        // Rancher installations commonly use private/self-signed certificates.
        // Scope this policy to this request; never change the host's TLS defaults.
        method, signal, agent: false, rejectUnauthorized: false,
        // Kubernetes log subresources return plain text, but their request
        // content negotiation still accepts the Kubernetes resource media
        // types rather than `text/plain`.
        headers: { ...(authorization ? { authorization } : {}), accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) }) },
      }, response => {
        let size = 0
        const chunks = []
        response.on('data', chunk => {
          size += chunk.length
          if (size > MAX_RESPONSE) request.destroy(new ApiError(502, '响应过大，请缩小命名空间或标签筛选范围'))
          else chunks.push(chunk)
        })
        response.on('error', error => request.destroy(error))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          const status = response.statusCode || 502
          if (status >= 300 && status < 400) return reject(new ApiError(502, 'Rancher 返回重定向，请配置最终服务器地址'))
          if (status < 200 || status >= 300) {
            let message
            try { message = JSON.parse(raw).message } catch { /* Do not expose proxy HTML or headers. */ }
            return reject(new ApiError(status, this.redact(message || `Rancher HTTP ${status}`).slice(0, 600)))
          }
          if (text) return resolve(this.redact(raw))
          if (!raw) return resolve({})
          try { resolve(JSON.parse(raw)) } catch { reject(new ApiError(502, 'Rancher 未返回 JSON，请检查服务器地址')) }
        })
      })
      // An absolute deadline also bounds a slow trickle response.
      const timeout = setTimeout(() => request.destroy(new ApiError(504, 'Rancher 请求超时（20 秒）')), 20_000)
      request.on('close', () => clearTimeout(timeout))
      request.on('error', error => reject(error instanceof ApiError ? error : new ApiError(502, this.redact(error.message))))
      request.end(payload)
    })
  }

  async list(endpoint, query = {}, signal) {
    const initial = new URL(endpoint.replace(/^\//, ''), this.base)
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') initial.searchParams.set(key, value)
    const kubernetes = initial.pathname.includes('/k8s/clusters/')
    initial.searchParams.set('limit', kubernetes ? '500' : '100')
    let current = initial
    const result = []
    const visited = new Set()
    for (let page = 0; page < 40; page++) {
      check(current.origin === initial.origin && current.pathname === initial.pathname, '分页链接超出当前资源范围', 502)
      check(!visited.has(current.href), 'Rancher 返回重复分页链接', 502)
      visited.add(current.href)
      const endpoint = current.pathname.slice(this.base.pathname.length) + current.search
      const response = await this.request(endpoint, { signal })
      const items = response.items ?? response.data
      check(Array.isArray(items), 'Rancher 资源列表格式错误', 502)
      result.push(...items)
      if (kubernetes && response.metadata?.continue) {
        current = new URL(initial)
        current.searchParams.set('continue', response.metadata.continue)
      } else if (!kubernetes && response.pagination?.next) {
        current = new URL(response.pagination.next, current)
      } else return result
    }
    throw new ApiError(502, '资源超过分页上限，请缩小筛选范围')
  }

  async stream(endpoint, { signal, consume }) {
    const target = new URL(endpoint.replace(/^\//, ''), this.base)
    check(target.origin === this.base.origin && target.pathname.startsWith(this.base.pathname), '拒绝向其它服务器发送凭据')
    const authorization = await this.authorization(signal)
    const transport = target.protocol === 'https:' ? https : http
    let upstream
    const request = transport.request(target, { method: 'GET', signal, agent: false, rejectUnauthorized: false,
      // The response is consumed as a text stream, while the Kubernetes API
      // expects a supported resource media type in `Accept`.
      headers: { authorization, accept: 'application/json' } })
    // Only the handshake has a deadline: quiet containers may have no new lines for hours.
    const timeout = setTimeout(() => request.destroy(new ApiError(504, 'Rancher 日志连接超时（20 秒）')), 20_000)
    try {
      upstream = await new Promise((resolve, reject) => {
        request.once('response', resolve)
        request.once('error', reject)
        request.end()
      })
      const status = upstream.statusCode || 502
      if (status < 200 || status >= 300) {
        let raw = ''
        for await (const chunk of upstream) {
          raw += chunk.toString('utf8')
          if (raw.length > 65536) break
        }
        let message
        try { message = JSON.parse(raw).message } catch {}
        throw new ApiError(status >= 300 && status < 400 ? 502 : status,
          this.redact(message || (status < 400 ? 'Rancher 返回重定向，请配置最终服务器地址' : `Rancher HTTP ${status}`)).slice(0, 600))
      }
      clearTimeout(timeout)
      await consume({ type: 'ready' })
      upstream.setEncoding('utf8')
      // Redact complete lines so credentials split across network chunks cannot escape.
      // Oversized lines are dropped whole to keep server memory bounded.
      let pending = '', dropping = false
      for await (const chunk of upstream) {
        signal?.throwIfAborted()
        const parts = chunk.split('\n')
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index]
          if (!dropping) {
            if (pending.length + part.length > 65536) { pending = ''; dropping = true }
            else pending += part
          }
          if (index < parts.length - 1) {
            await consume({ type: 'log', text: dropping ? '[日志行超过 64 KiB，已省略]\n' : this.redact(pending) + '\n' })
            pending = ''; dropping = false
          }
        }
      }
      if (pending || dropping) await consume({ type: 'log', text: dropping ? '[日志行超过 64 KiB，已省略]\n' : this.redact(pending) })
      await consume({ type: 'end' })
    } catch (error) {
      throw error instanceof ApiError ? error : new ApiError(502, this.redact(error.message))
    } finally {
      clearTimeout(timeout)
      upstream?.destroy()
      request.destroy()
    }
  }

  k8s(cluster, resource) {
    return `k8s/clusters/${segment(cluster, '集群 ID')}/${resource}`
  }
}
