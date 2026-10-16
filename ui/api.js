export async function api(path, { body, signal, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(`/api/rancher${path}`, { method, signal, credentials: 'same-origin', redirect: 'error',
    headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload.data
}

export const run = (input, signal) => api('/run', { body: input, signal })
export const pagePods = (input, signal) => api('/pods/page', { body: input, signal })

async function readStream(path, input, signal, consume, label) {
  const response = await fetch(`/api/rancher/${path}`, { method: 'POST', signal, credentials: 'same-origin', redirect: 'error',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  if (!response.ok) { const payload = await response.json(); throw new Error(payload.error || `HTTP ${response.status}`) }
  if (!response.body) throw new Error(`当前环境不支持流式${label}`)
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
    if (!ended) throw new Error(`${label}连接中断，请重试`)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export const streamLogs = (input, signal, consume) => readStream('logs/stream', input, signal, consume, '日志')

export async function streamPods(input, signal, publish) {
  const rows = []
  await readStream('pods/stream', input, signal, event => {
    if (event.type === 'page') {
      rows.push(...event.items)
      publish([...rows])
    }
  }, 'Pod 列表')
  return rows
}
