// Kubernetes quantities: CPU is expressed in cores, memory in bytes.
export function quantity(value) {
  if (value === undefined || value === null || value === '') return null
  const match = String(value).match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))([eE][+-]?\d+|[numkKMGTPE]|[KMGTPE]i)?$/)
  if (!match) return null
  const suffix = match[2] || ''
  const factors = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 }
  const factor = suffix.endsWith('i') ? 1024 ** ('KMGTPE'.indexOf(suffix[0]) + 1) : /^[eE][+-]?\d+$/.test(suffix) ? 10 ** Number(suffix.slice(1)) : factors[suffix] ?? 1
  const result = Number(match[1]) * factor
  return Number.isFinite(result) ? result : null
}

export const usageView = usage => ({ cpuCores: quantity(usage?.cpu), memoryBytes: quantity(usage?.memory) })

export function sumUsage(usages) {
  return Object.fromEntries(['cpuCores', 'memoryBytes'].map(key => [key,
    usages.length && usages.every(item => item[key] !== null) ? usages.reduce((sum, item) => sum + item[key], 0) : null]))
}

// Application containers only. Init/sidecar resources remain visible individually
// in Pod details; these totals are not scheduler-effective Pod reservations.
export function containerResources(containers = []) {
  return Object.fromEntries(['requests', 'limits'].map(kind => [kind,
    sumUsage(containers.map(container => usageView(container.resources?.[kind])))]))
}
