/**
 * 本机离线存储（IndexedDB）。量体现场无网也能录入，数据不出本地。
 *
 * 可靠性约定：
 * 1. 所有写操作只有在 IDBTransaction.oncomplete（已真正落盘）后才 resolve；
 *    request.onsuccess 只代表请求进入队列，事务仍可能整体 abort。
 * 2. 写失败一律 reject，绝不静默吞掉——调用方必须把失败如实反馈给界面，
 *    不允许出现“提示保存成功、刷新后却是旧内容”。
 * 3. 一次业务动作涉及多个对象库时走同一个原子事务（如删除项目 + 落墓碑）。
 */

import type { PersonTombstone, ProjectTombstone } from './types'

const DB_NAME = 'app030-uniform-tally'
const DB_VERSION = 1

export const STORE_PROJECTS = 'projects'
export const STORE_RULES = 'rules'
export const STORE_META = 'meta'

export const META_PERSON_TOMBSTONES = 'personTombstones'
export const META_PROJECT_TOMBSTONES = 'projectTombstones'

export type MetaEntry = { key: string; value: string }
/** meta 库中以 JSON 序列化保存的值（墓碑列表等） */
export type MetaJsonEntry<T> = { key: string; value: T }

/** 期望的修订号与库中不一致：说明其它标签页已经写过，当前快照过期 */
export class RevisionConflictError extends Error {
  constructor(public readonly actualRev: number) {
    super('本机数据已被其它标签页修改')
    this.name = 'RevisionConflictError'
  }
}

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (!idbAvailable()) {
    return Promise.reject(new Error('当前浏览器不支持 IndexedDB，无法在本机离线保存数据'))
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(STORE_RULES)) db.createObjectStore(STORE_RULES, { keyPath: 'version' })
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'))
      request.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用，请关闭旧标签页后重试'))
    })
  }
  return dbPromise
}

async function runTransaction<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  build: (stores: IDBObjectStore[]) => IDBRequest | null
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode)
    const stores = storeNames.map((name) => transaction.objectStore(name))
    let requestResult: unknown
    let settled = false
    transaction.oncomplete = () => {
      if (settled) return
      settled = true
      resolve(requestResult as T)
    }
    transaction.onerror = () => {
      if (settled) return
      settled = true
      reject(transaction.error ?? new Error('IndexedDB 事务失败，事务未完成'))
    }
    transaction.onabort = () => {
      if (settled) return
      settled = true
      reject(transaction.error ?? new Error('IndexedDB 事务被中止，请重试'))
    }
    try {
      const request = build(stores)
      if (request) {
        request.onsuccess = () => {
          requestResult = request.result
        }
      }
    } catch (error) {
      if (settled) return
      settled = true
      transaction.abort()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function runRead<T>(storeName: string, build: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return runTransaction<T>([storeName], 'readonly', (stores) => build(stores[0]))
}

/** 写入 / 删除动作在单个读写事务内完成，事务提交后才 resolve。 */
function runWrite(
  storeNames: string[],
  build: (stores: IDBObjectStore[]) => void
): Promise<void> {
  return runTransaction<void>(storeNames, 'readwrite', (stores) => {
    build(stores)
    return null
  })
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
  return runWrite([storeName], ([store]) => {
    store.delete(key)
  })
}

/**
 * 项目的 compare-and-swap 写入：
 * 仅当库中现有 rev === expectedRev 时才提交，否则抛 RevisionConflictError，
 * 由上层读取最新值做行级合并后重试，杜绝两个标签页互相整包覆盖。
 *
 * sideWrites 在同一事务内、CAS 校验通过后执行——人员墓碑必须与项目快照同事务提交，
 * 避免“墓碑还没写进去，旧标签页的旧快照先把人写回来了”。
 */
export async function idbPutProjectCas<T extends { id: string; rev?: number }>(
  value: T,
  expectedRev: number,
  sideWrites?: (metaStore: IDBObjectStore) => void
): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const storeNames = sideWrites ? [STORE_PROJECTS, STORE_META] : [STORE_PROJECTS]
    const transaction = db.transaction(storeNames, 'readwrite')
    let settled = false
    transaction.oncomplete = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    transaction.onerror = () => {
      if (!settled) {
        settled = true
        reject(transaction.error ?? new Error('IndexedDB 事务失败，数据未写入本机'))
      }
    }
    transaction.onabort = () => {
      if (!settled) {
        settled = true
        reject(transaction.error ?? new Error('IndexedDB 写入被中止，数据未保存，请重试'))
      }
    }
    const projectStore = transaction.objectStore(STORE_PROJECTS)
    const getReq = projectStore.get(value.id)
    getReq.onsuccess = () => {
      const current = getReq.result as T | undefined
      const actualRev = current?.rev ?? 0
      if (actualRev !== expectedRev) {
        // 先回滚本事务，再把“当前修订号”交给上层
        if (!settled) {
          settled = true
          transaction.abort()
          reject(new RevisionConflictError(actualRev))
        }
        return
      }
      projectStore.put(value)
      if (sideWrites) sideWrites(transaction.objectStore(STORE_META))
    }
    getReq.onerror = () => {
      if (!settled) {
        settled = true
        reject(getReq.error ?? new Error('IndexedDB 读取失败'))
      }
    }
  })
}

/** 原子删除项目：项目删除与墓碑写入同一事务，要么一起生效要么一起失败 */
export function idbDeleteProjectWithTombstones(
  id: string,
  projectTombstonesValue: ProjectTombstone[],
  personTombstonesValue: PersonTombstone[]
): Promise<void> {
  return runWrite([STORE_PROJECTS, STORE_META], ([projectStore, metaStore]) => {
    projectStore.delete(id)
    metaStore.put({ key: META_PROJECT_TOMBSTONES, value: projectTombstonesValue } satisfies MetaJsonEntry<
      ProjectTombstone[]
    >)
    metaStore.put({ key: META_PERSON_TOMBSTONES, value: personTombstonesValue } satisfies MetaJsonEntry<
      PersonTombstone[]
    >)
  })
}

export function idbGetMetaJson<T>(key: string, fallback: T): Promise<T> {
  return runRead<MetaJsonEntry<T> | undefined>(STORE_META, (store) => store.get(key)).then((entry) =>
    entry ? entry.value : fallback
  )
}

export function idbPutMetaJson<T>(key: string, value: T): Promise<void> {
  return runWrite([STORE_META], ([store]) => {
    store.put({ key, value } satisfies MetaJsonEntry<T>)
  })
}

/** 仅供自动化测试：清空全部对象库并关闭缓存连接，模拟“清空浏览器数据” */
export async function __idbWipeForTest(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const names = [STORE_PROJECTS, STORE_RULES, STORE_META]
    const transaction = db.transaction(names, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('wipe 失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('wipe 中止'))
    for (const name of names) transaction.objectStore(name).clear()
  })
  db.close()
  dbPromise = null
}
