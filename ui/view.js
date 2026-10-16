import { useSyncExternalStore } from 'react'

let snapshot = { connectionId: '', revision: 0 }
const listeners = new Set()

export function selectConnection(connectionId) {
  if (snapshot.connectionId === connectionId) return
  snapshot = { ...snapshot, connectionId }
  for (const notify of listeners) notify()
}

export function connectionsChanged(connectionId = snapshot.connectionId) {
  snapshot = { connectionId, revision: snapshot.revision + 1 }
  for (const notify of listeners) notify()
}

export function useRancherView() {
  return useSyncExternalStore(notify => { listeners.add(notify); return () => listeners.delete(notify) }, () => snapshot)
}
