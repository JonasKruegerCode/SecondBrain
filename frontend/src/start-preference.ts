const DATABASE = 'secondbrain.preferences.v1'
const STORE = 'preferences'
const KEY = 'start-page'
const LEGACY_KEY = 'secondbrain.startpage'

interface StartPreference {
  version: 1
  pageId: string
}

let databasePromise: Promise<IDBDatabase> | undefined

// Match the backend's Unicode page-ID syntax and 160-character bound.
function validPageId(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || (
    Array.from(value).length <= 160 && /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(value)
  ))
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    let abandoned = false
    const request = indexedDB.open(DATABASE, 1)
    request.onblocked = () => {
      abandoned = true
      reject(new Error('Start-page preference storage is blocked by another tab.'))
    }
    request.onupgradeneeded = () => {
      if (abandoned) {
        request.transaction?.abort()
        return
      }
      request.result.createObjectStore(STORE)
    }
    request.onerror = () => {
      abandoned = true
      reject(request.error ?? new Error('Could not open start-page preference storage.'))
    }
    request.onsuccess = () => {
      const database = request.result
      if (abandoned) {
        database.close()
        return
      }
      database.onversionchange = () => {
        database.close()
        if (databasePromise === pending) databasePromise = undefined
      }
      database.onclose = () => {
        if (databasePromise === pending) databasePromise = undefined
      }
      resolve(database)
    }
  })
  databasePromise = pending
  void pending.catch(() => {
    if (databasePromise === pending) databasePromise = undefined
  })
  return pending
}

function writeTransaction(database: IDBDatabase): IDBTransaction {
  try {
    return database.transaction(STORE, 'readwrite', { durability: 'strict' })
  } catch (error) {
    // Only an unsupported construction signature permits a weaker transaction.
    if (error instanceof TypeError || (
      error instanceof DOMException && error.name === 'NotSupportedError'
    )) return database.transaction(STORE, 'readwrite')
    throw error
  }
}

async function transact(operation: (store: IDBObjectStore, fail: (error: unknown) => void) => void): Promise<void> {
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = writeTransaction(database)
    let failure: unknown
    const fail = (error: unknown): void => {
      failure = error
      try {
        transaction.abort()
      } catch {
        reject(error)
      }
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Start-page preference transaction aborted.'))
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('Start-page preference transaction failed.'))
    try {
      operation(transaction.objectStore(STORE), fail)
    } catch (error) {
      fail(error)
    }
  })
}

export async function readStartPage(): Promise<string> {
  let pageId = ''
  await transact((store, fail) => {
    const request = store.get(KEY)
    request.onsuccess = () => {
      try {
        const record: unknown = request.result
        if (record === undefined) {
          // get() cannot distinguish an absent key from a stored undefined.
          const presence = store.getKey(KEY)
          presence.onsuccess = () => {
            try {
              if (presence.result !== undefined) throw new Error('The saved start-page preference is malformed.')
              // Read legacy storage only while holding the migration transaction.
              // A denied getter aborts without creating an authoritative empty value.
              const legacy = localStorage.getItem(LEGACY_KEY)
              pageId = validPageId(legacy) ? legacy : ''
              store.put({ version: 1, pageId } satisfies StartPreference, KEY)
            } catch (error) {
              fail(error)
            }
          }
        } else {
          if (record === null || typeof record !== 'object' ||
            !('version' in record) || record.version !== 1 ||
            !('pageId' in record) || !validPageId(record.pageId)) {
            throw new Error('The saved start-page preference is malformed.')
          }
          pageId = record.pageId
        }
      } catch (error) {
        fail(error)
      }
    }
  })
  return pageId
}

export async function saveStartPage(id: string): Promise<void> {
  if (!validPageId(id)) throw new Error('Invalid start-page ID.')
  await transact(store => {
    store.put({ version: 1, pageId: id } satisfies StartPreference, KEY)
  })
}
