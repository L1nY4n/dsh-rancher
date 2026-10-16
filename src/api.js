import { ApiError, check } from './errors.js'
import { once } from 'node:events'

const PREFIX = '/api/rancher'

export function admission(req, connection) {
  try {
    if (typeof connection?.admit === 'function') return connection.admit(req)?.rejection
    if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req)
    // An installed but incompatible host auth service must not become a bypass.
    if (connection !== undefined) return 503
    const host = new URL(`http://${req.headers.host}`)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return 403
    if (req.headers['sec-fetch-site'] === 'cross-site') return 403
    for (const key of ['origin', 'referer']) {
      if (req.headers[key] === undefined) continue
      const origin = new URL(req.headers[key])
      if (key === 'referer' && origin.protocol === 'dsh-app:' && origin.host === 'app'
          && !req.headers.origin && !req.headers['sec-fetch-site']) continue
      if (origin.origin !== host.origin) return 403
    }
    return undefined
  } catch { return 503 }
}

async function readBody(req) {
  check(req.headers['content-type']?.split(';')[0].trim() === 'application/json', '请求需要 application/json', 415)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    check(size <= 64 * 1024, '请求体过大', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ApiError(400, '请求 JSON 格式错误') }
}

export function createApi({ store, manager, getConnection = () => undefined }) {
  return async (req, res) => {
    const send = (status, data) => {
      if (res.destroyed) return
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(JSON.stringify(data))
    }
    const abort = new AbortController()
    const disconnected = () => { if (!res.writableEnded) abort.abort() }
    res.on('close', disconnected)
    try {
      const rejection = admission(req, getConnection())
      if (rejection !== undefined) return send(rejection, { error: rejection === 401 ? '请先登录 DSH' : '请求未通过 DSH 访问校验' })
      const url = new URL(req.url, 'http://localhost')
      const route = url.pathname.slice(PREFIX.length)
      if (req.method === 'GET' && route === '/connections') return send(200, { data: store.list() })
      if (req.method === 'POST' && route === '/connections/test') return send(200, { data: await manager.testConnection(await readBody(req), abort.signal) })
      if (req.method === 'POST' && route === '/connections') {
        const input = await readBody(req)
        const verification = await manager.testConnection(input, abort.signal)
        return send(200, { data: { ...store.save(input), verification } })
      }
      if (req.method === 'DELETE' && route.startsWith('/connections/')) return send(200, { data: store.remove(decodeURIComponent(route.slice('/connections/'.length))) })
      if (req.method === 'POST' && route === '/logs/stream') {
        const input = await readBody(req)
        await manager.streamLogs(input, abort.signal, async event => {
          abort.signal.throwIfAborted()
          if (!res.headersSent) {
            res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' })
            res.flushHeaders()
          }
          if (!res.write(JSON.stringify(event) + '\n')) await once(res, 'drain', { signal: abort.signal })
        })
        return res.end()
      }
      if (req.method === 'POST' && route === '/pods/stream') {
        const input = await readBody(req)
        await manager.streamPods(input, abort.signal, async event => {
          abort.signal.throwIfAborted()
          if (!res.headersSent) {
            res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' })
            res.flushHeaders()
          }
          if (!res.write(JSON.stringify(event) + '\n')) await once(res, 'drain', { signal: abort.signal })
        })
        return res.end(JSON.stringify({ type: 'end' }) + '\n')
      }
      if (req.method === 'POST' && route === '/pods/page') return send(200, { data: await manager.pagePods(await readBody(req), abort.signal) })
      if (req.method === 'POST' && route === '/run') return send(200, { data: await manager.run(await readBody(req), abort.signal) })
      return send(404, { error: '接口不存在' })
    } catch (error) {
      if (res.headersSent) {
        if (!res.destroyed) res.end(JSON.stringify({ type: 'error', error: error instanceof ApiError ? error.message : '日志流中断，请重连' }) + '\n')
        return
      }
      // Upstream errors are sanitized in RancherClient. Never serialize request bodies.
      return send(error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : '插件请求失败，请检查本地配置文件及 DSH 日志' })
    } finally {
      res.off('close', disconnected)
    }
  }
}
