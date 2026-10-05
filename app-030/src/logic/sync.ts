/**
 * 跨标签页变更广播。两个标签页同时开着同一项目时，一个页面落盘 / 删除后，
 * 另一个页面必须收到通知并与磁盘对齐，不能让用户在两个页面看到互相矛盾的内容。
 *
 * 优先用 BroadcastChannel；不支持时退回 localStorage storage 事件
 * （storage 事件只在其它标签页触发，天然没有回声）。
 */

export type SyncMessage =
  | { kind: 'project-committed'; id: string; rev: number; clientId: string }
  | { kind: 'project-deleted'; id: string; clientId: string }
  | { kind: 'rule-committed'; version: string; rev: number; clientId: string }
  | { kind: 'rule-deleted'; version: string; clientId: string }
  | { kind: 'operator-changed'; value: string; clientId: string }

const CHANNEL_NAME = 'app030-uniform-tally-sync'
const STORAGE_KEY = 'app030-sync'

export function makeClientId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export type SyncBus = {
  post(message: SyncMessage): void
  close(): void
}

export function openSyncBus(onMessage: (message: SyncMessage) => void, clientId: string): SyncBus {
  let channel: BroadcastChannel | null = null
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = (event: MessageEvent<SyncMessage>) => {
      const message = event.data
      if (message && message.clientId !== clientId) onMessage(message)
    }
  }

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    try {
      const message = JSON.parse(event.newValue) as SyncMessage
      if (message && message.clientId !== clientId) onMessage(message)
    } catch {
      // 忽略无法解析的同步帧
    }
  }
  if (!channel) window.addEventListener('storage', onStorage)

  return {
    post(message: SyncMessage): void {
      if (channel) {
        channel.postMessage(message)
        return
      }
      try {
        // 同页不触发 storage 事件；写入值每次变化即可推送到其它标签页
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...message, at: Date.now() }))
      } catch {
        // 隐私模式等场景 localStorage 不可用：跨页同步降级为关闭页面后重新打开
      }
    },
    close(): void {
      if (channel) channel.close()
      else window.removeEventListener('storage', onStorage)
    }
  }
}
