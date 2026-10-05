/**
 * 本机离线存储（IndexedDB）。量体现场无网也能录入，数据不出本地。
 *
 * 持久化语义（重要）：
 * - 所有写操作都等「事务 oncomplete」才 resolve——请求 onsuccess 只代表写请求本身成功，
 *   事务随后仍可能 abort 并整笔回滚。提示“已保存”之前必须等到事务提交。
 * - 项目 / 规则文档带 rev 版本号，写入时带期望值做乐观并发控制，两个标签页同时改时
 *   后写不会静默覆盖先写。
 * - 删除写墓碑（tombstone），防止另一个标签页里排队的旧写把已删除文档“复活”。
 */

const DB_NAME = 'app030-uniform-tally'
const DB_VERSION = 2

export const STORE_PROJECTS = 'projects'
export const STORE_RULES = 'rules'
export const STORE_META = 'meta'
export const STORE_TOMBSTONES = 'tombstones'

export type MetaEntry = { key: string; value: string }
export type RevDocument = { rev?: number }
export type Tombstone = { key: string; at: number }

export class StorageConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageConflictError'
  }
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageError'
  }
}

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (!idbAvailable()) {
    return Promise.reject(new StorageError('当前浏览器不支持 IndexedDB，无法在本机离线保存数据'))
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(STORE_RULES)) db.createObjectStore(STORE_RULES, { keyPath: 'version' })
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' })
        // v2：删除墓碑，阻止其它标签页里排队的旧写入复活已删项目/规则
        if (!db.objectStoreNames.contains(STORE_TOMBSTONES)) db.createObjectStore(STORE_TOMBSTONES, { keyPath: 'key' })
      }
      request.onsuccess = () => {
        const db = request.result
        // 其它标签页要升级数据库时主动让位，并重置连接，避免升级被本页永久阻塞
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        resolve(db)
      }
      request.onerror = () => reject(new StorageError(request.error?.message ?? 'IndexedDB 打开失败'))
      request.onblocked = () => reject(new StorageError('IndexedDB 被其它标签页占用，请关闭其它标签页后重试'))
    })
  }
  return dbPromise
}

/** 读请求：等 request 成功即可（读不存在事务提交后回滚的问题） */
async function runRead<T>(storeName: string, build: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly')
    const request = build(transaction.objectStore(storeName))
    request.onsuccess = () => resolve(request.result as T)
    request.onerror = () => reject(new StorageError(request.error?.message ?? 'IndexedDB 读取失败'))
    transaction.onerror = () => reject(new StorageError(transaction.error?.message ?? 'IndexedDB 读取事务失败'))
    transaction.onabort = () => reject(new StorageError(transaction.error?.message ?? 'IndexedDB 读取事务中止'))
  })
}

/**
 * 写事务：在同一个事务里依次执行多个写动作，事务 oncomplete 才 resolve，
 * onabort / onerror 一律 reject（不能在请求 onsuccess 就当作落盘成功）。
 */
async function runWrite(storeNames: string[], act: (stores: IDBObjectStore[]) => void): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeNames, 'readwrite')
    const stores = storeNames.map((name) => transaction.objectStore(name))
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      reject(new StorageError(message))
    }
    transaction.oncomplete = () => {
      if (settled) return
      settled = true
      resolve()
    }
    transaction.onerror = () => fail(transaction.error?.message ?? 'IndexedDB 写入事务失败')
    transaction.onabort = () => fail(transaction.error?.message ?? 'IndexedDB 写入事务中止，本次修改没有落盘')
    try {
      act(stores)
    } catch (error) {
      transaction.abort()
      fail(error instanceof Error ? error.message : String(error))
    }
  })
}

function tombstoneKey(storeName: string, key: string): string {
  return `${storeName}::${key}`
}

export function idbGetAll<T>(storeName: string): Promise<T[]> {
  return runRead<T[]>(storeName, (store) => store.getAll())
}

export function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  return runRead<T | undefined>(storeName, (store) => store.get(key))
}

export function idbPut<T>(storeName: string, value: T): Promise<void> {
  return runWrite([storeName], ([store]) => {
    store.put(value)
  })
}

export function idbPutMany<T>(storeName: string, values: T[]): Promise<void> {
  return runWrite([storeName], ([store]) => {
    for (const value of values) store.put(value)
  })
}

export function idbDelete(storeName: string, key: string): Promise<void> {
  return runWrite([storeName, STORE_TOMBSTONES], ([store, tombstones]) => {
    store.delete(key)
    tombstones.put({ key: tombstoneKey(storeName, key), at: Date.now() } satisfies Tombstone)
  })
}

/**
 * 带乐观并发控制的文档提交：
 * - 已被删除（有墓碑）→ StorageConflictError，调用方按“已被其它页面删除”处理；
 * - 磁盘 rev 比期望值新 → StorageConflictError，调用方决定合并重试还是读回磁盘；
 * - 其余情况 rev + 1 写入，等事务 oncomplete 后返回提交后的 rev。
 *
 * 检查与写入必须在同一个事务内完成，否则两个并发提交可能同时通过检查。
 * 事务级监听在发起请求前一次性挂好；冲突是检查方主动 abort 的，用 intent 区分，
 * 避免 abort 回调把 StorageConflictError 包装成普通存储错误。
 */
export async function idbCommitDoc<T extends RevDocument>(
  storeName: string,
  value: T,
  primaryKey: string,
  expectedRev: number
): Promise<number> {
  const db = await openDb()
  return new Promise<number>((resolve, reject) => {
    const transaction = db.transaction([storeName, STORE_TOMBSTONES], 'readwrite')
    const store = transaction.objectStore(storeName)
    const tombstones = transaction.objectStore(STORE_TOMBSTONES)
    const tKey = tombstoneKey(storeName, primaryKey)
    let settled = false
    let intent: 'conflict-deleted' | 'conflict-stale' | 'fail' | null = null
    let failMessage = ''
    let nextRev = 0

    const rejectWith = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const conflict = (kind: 'conflict-deleted' | 'conflict-stale'): void => {
      intent = kind
      transaction.abort()
    }
    transaction.oncomplete = () => {
      if (settled) return
      settled = true
      resolve(nextRev)
    }
    transaction.onerror = () => {
      rejectWith(new StorageError(transaction.error?.message ?? (failMessage || 'IndexedDB 写入事务失败')))
    }
    transaction.onabort = () => {
      if (intent === 'conflict-deleted') {
        rejectWith(new StorageConflictError('该数据已在另一个标签页中被删除'))
        return
      }
      if (intent === 'conflict-stale') {
        rejectWith(new StorageConflictError('该数据已在另一个标签页中被修改，请刷新后重试'))
        return
      }
      rejectWith(new StorageError(transaction.error?.message ?? (failMessage || 'IndexedDB 写入事务中止，本次修改没有落盘')))
    }

    const tombRequest = tombstones.get(tKey)
    tombRequest.onsuccess = () => {
      const existingRequest = store.get(primaryKey)
      existingRequest.onsuccess = () => {
        const existing = existingRequest.result as T | undefined
        const currentRev = existing?.rev ?? 0
        // 墓碑 + 文档不存在 + 拿着旧 rev 提交 = 陈旧写入想复活已删文档 → 拒绝。
        // expectedRev === 0 是全新创建（包括删后用同版本号重建规则），放行并清墓碑。
        if (tombRequest.result && !existing && expectedRev > 0) {
          conflict('conflict-deleted')
          return
        }
        if (currentRev > expectedRev) {
          conflict('conflict-stale')
          return
        }
        nextRev = currentRev + 1
        const putRequest = store.put({ ...value, rev: nextRev })
        // 新写入成功后清除可能残留的旧墓碑
        tombstones.delete(tKey)
        putRequest.onerror = () => {
          failMessage = putRequest.error?.message ?? 'IndexedDB 写入失败'
          intent = 'fail'
          transaction.abort()
        }
      }
      existingRequest.onerror = () => {
        failMessage = existingRequest.error?.message ?? 'IndexedDB 读取失败'
        intent = 'fail'
        transaction.abort()
      }
    }
    tombRequest.onerror = () => {
      failMessage = tombRequest.error?.message ?? 'IndexedDB 墓碑检查失败'
      intent = 'fail'
      transaction.abort()
    }
  })
}
