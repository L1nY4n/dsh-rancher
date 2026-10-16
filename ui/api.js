export async function api(path, { body, signal, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(`/api/rancher${path}`, { method, signal, credentials: 'same-origin', redirect: 'error',
    headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload.data
}

export const run = (input, signal) => api('/run', { body: input, signal })

export async function streamLogs(input, signal, consume) {
  const response = await fetch('/api/rancher/logs/stream', { method: 'POST', signal, credentials: 'same-origin', redirect: 'error',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  if (!response.ok) { const payload = await response.json(); throw new Error(payload.error || `HTTP ${response.status}`) }
  if (!response.body) throw new Error('当前环境不支持流式日志')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let pending = '', ended = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) {
        if (!line) continue
        const event = JSON.parse(line)
        if (event.type === 'error') throw new Error(event.error)
        if (event.type === 'end') ended = true
        consume(event)
      }
      if (done) break
    }
    if (!ended) throw new Error('日志连接中断，请重连')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
