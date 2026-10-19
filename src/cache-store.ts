import { Database } from 'bun:sqlite'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface StoredCacheEntry {
  body: Uint8Array
  headers: [string, string][]
  storedAt: number
  maxAge: number
  swr: number
  tags: string[]
}

export interface PersistentCacheOptions {
  directory: string
  namespace: string
  maxDiskBytes: number
  maxDiskEntries: number
}

interface NamespaceRow {
  generation: number
}

interface EntryRow {
  body: Uint8Array
  headers: string
  stored_at: number
  max_age: number
  swr: number
  tags: string
}

/**
 * The disk tier for the Bun ISR provider. SQLite gives separate Bun processes
 * atomic invalidation and write ordering without serializing response bodies
 * through a user-controlled filename.
 */
export class PersistentCacheStore {
  private readonly databasePath: string
  private db: Database | undefined
  private unavailable = false
  private initialized: Promise<void> | undefined

  constructor(private readonly options: PersistentCacheOptions) {
    this.databasePath = join(options.directory, 'astro-bun-isr.sqlite')
  }

  async ready(): Promise<boolean> {
    if (this.unavailable) return false
    this.initialized ??= this.open()
    try {
      await this.initialized
      return true
    } catch {
      this.unavailable = true
      return false
    }
  }

  async revision(): Promise<number | undefined> {
    if (!(await this.ready())) return undefined
    try {
      return this.namespaceRow().generation
    } catch {
      this.unavailable = true
      return undefined
    }
  }

  async get(key: string): Promise<StoredCacheEntry | undefined> {
    if (!(await this.ready())) return undefined
    try {
      const row = this.db!.query<EntryRow, [string, string]>(
        'SELECT body, headers, stored_at, max_age, swr, tags FROM isr_entries WHERE namespace = ? AND cache_key = ?',
      ).get(this.options.namespace, key)
      if (!row) return undefined
      this.db!.query(
        'UPDATE isr_entries SET last_access = ? WHERE namespace = ? AND cache_key = ?',
      ).run(Date.now(), this.options.namespace, key)
      return this.deserialize(row)
    } catch {
      // A corrupt entry is never served. Disable the optional tier and let SSR
      // continue; the original database remains available for diagnosis.
      this.unavailable = true
      return undefined
    }
  }

  async warm(maxEntries: number, maxBytes: number): Promise<Array<[string, StoredCacheEntry]>> {
    if (!(await this.ready())) return []
    try {
      const rows = this.db!.query<EntryRow & { cache_key: string }, [string]>(
        `SELECT cache_key, body, headers, stored_at, max_age, swr, tags
           FROM isr_entries WHERE namespace = ? ORDER BY last_access DESC`,
      )
      const warm: Array<[string, StoredCacheEntry]> = []
      let bytes = 0
      for (const row of rows.iterate(this.options.namespace)) {
        const entry = this.deserialize(row)
        if (warm.length >= maxEntries || bytes + entry.body.byteLength > maxBytes) break
        warm.push([row.cache_key, entry])
        bytes += entry.body.byteLength
      }
      return warm
    } catch {
      this.unavailable = true
      return []
    }
  }

  /** Returns the new revision when the conditional write committed. */
  async set(
    key: string,
    entry: StoredCacheEntry,
    expectedRevision: number,
  ): Promise<number | undefined> {
    if (!(await this.ready())) return undefined
    const db = this.db!
    try {
      db.run('BEGIN IMMEDIATE')
      const current = this.namespaceRow().generation
      if (current !== expectedRevision) {
        db.run('ROLLBACK')
        return undefined
      }
      const revision = current + 1
      const now = Date.now()
      db.query(
        `INSERT INTO isr_entries
          (namespace, cache_key, body, headers, stored_at, max_age, swr, tags, byte_size, last_access)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, cache_key) DO UPDATE SET
           body = excluded.body, headers = excluded.headers, stored_at = excluded.stored_at,
           max_age = excluded.max_age, swr = excluded.swr, tags = excluded.tags,
           byte_size = excluded.byte_size, last_access = excluded.last_access`,
      ).run(
        this.options.namespace,
        key,
        entry.body,
        JSON.stringify(entry.headers),
        entry.storedAt,
        entry.maxAge,
        entry.swr,
        JSON.stringify(entry.tags),
        entry.body.byteLength,
        now,
      )
      db.query('UPDATE isr_namespaces SET generation = ? WHERE namespace = ?').run(
        revision,
        this.options.namespace,
      )
      this.trimToDiskBudget()
      db.run('COMMIT')
      return revision
    } catch {
      if (db.inTransaction) db.run('ROLLBACK')
      this.unavailable = true
      return undefined
    }
  }

  async invalidate(path?: string, tags?: string[]): Promise<number | undefined> {
    if (!(await this.ready())) return undefined
    const db = this.db!
    try {
      db.run('BEGIN IMMEDIATE')
      if (path || tags?.length) {
        const rows = db
          .query<{ cache_key: string; tags: string }, [string]>(
            'SELECT cache_key, tags FROM isr_entries WHERE namespace = ?',
          )
          .all(this.options.namespace)
        const wanted = new Set(tags)
        for (const row of rows) {
          const entryTags = JSON.parse(row.tags) as string[]
          const entryPath = new URL(row.cache_key).pathname + new URL(row.cache_key).search
          if (entryPath === path || entryTags.some((tag) => wanted.has(tag))) {
            db.query('DELETE FROM isr_entries WHERE namespace = ? AND cache_key = ?').run(
              this.options.namespace,
              row.cache_key,
            )
          }
        }
      } else {
        db.query('DELETE FROM isr_entries WHERE namespace = ?').run(this.options.namespace)
      }
      const revision = this.namespaceRow().generation + 1
      db.query('UPDATE isr_namespaces SET generation = ? WHERE namespace = ?').run(
        revision,
        this.options.namespace,
      )
      db.run('COMMIT')
      return revision
    } catch {
      if (db.inTransaction) db.run('ROLLBACK')
      this.unavailable = true
      return undefined
    }
  }

  /** Deletes only if no concurrent writer advanced this namespace. */
  async delete(key: string, expectedRevision: number): Promise<number | undefined> {
    if (!(await this.ready())) return undefined
    const db = this.db!
    try {
      db.run('BEGIN IMMEDIATE')
      const current = this.namespaceRow().generation
      if (current !== expectedRevision) {
        db.run('ROLLBACK')
        return undefined
      }
      const revision = current + 1
      db.query('DELETE FROM isr_entries WHERE namespace = ? AND cache_key = ?').run(
        this.options.namespace,
        key,
      )
      db.query('UPDATE isr_namespaces SET generation = ? WHERE namespace = ?').run(
        revision,
        this.options.namespace,
      )
      db.run('COMMIT')
      return revision
    } catch {
      if (db.inTransaction) db.run('ROLLBACK')
      this.unavailable = true
      return undefined
    }
  }

  private async open(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true })
    try {
      this.openDatabase()
    } catch {
      // Preserve an unreadable database for diagnosis and fail open to SSR.
      this.unavailable = true
    }
  }

  private openDatabase(): void {
    const db = new Database(this.databasePath, { create: true, strict: true })
    try {
      db.run('PRAGMA journal_mode = WAL')
      db.run('PRAGMA busy_timeout = 5000')
      db.run('PRAGMA synchronous = NORMAL')
      db.run('PRAGMA auto_vacuum = INCREMENTAL')
      db.run(`CREATE TABLE IF NOT EXISTS isr_namespaces (
        namespace TEXT PRIMARY KEY,
        generation INTEGER NOT NULL
      )`)
      db.run(`CREATE TABLE IF NOT EXISTS isr_entries (
        namespace TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        body BLOB NOT NULL,
        headers TEXT NOT NULL,
        stored_at INTEGER NOT NULL,
        max_age REAL NOT NULL,
        swr REAL NOT NULL,
        tags TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        last_access INTEGER NOT NULL,
        PRIMARY KEY(namespace, cache_key)
      )`)
      db.run('CREATE INDEX IF NOT EXISTS isr_entries_access ON isr_entries(last_access)')
      const pageSize =
        db.query<{ page_size: number }, []>('PRAGMA page_size').get()?.page_size ?? 4096
      const maxPages = Math.max(
        256,
        Math.ceil((this.options.maxDiskBytes + this.options.maxDiskEntries * 8192) / pageSize),
      )
      db.run(`PRAGMA max_page_count = ${maxPages}`)
      const integrity = db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
      if (integrity?.integrity_check !== 'ok') throw new Error('SQLite integrity check failed')
      db.query('INSERT OR IGNORE INTO isr_namespaces(namespace, generation) VALUES (?, 0)').run(
        this.options.namespace,
      )
      this.db = db
    } catch (error) {
      db.close()
      throw error
    }
  }

  private namespaceRow(): NamespaceRow {
    const row = this.db!.query<NamespaceRow, [string]>(
      'SELECT generation FROM isr_namespaces WHERE namespace = ?',
    ).get(this.options.namespace)
    if (!row) throw new Error('ISR namespace was not initialized')
    return row
  }

  private trimToDiskBudget(): void {
    const db = this.db!
    let total =
      db
        .query<{ total: number | null }, []>('SELECT SUM(byte_size) AS total FROM isr_entries')
        .get()?.total ?? 0
    let count =
      db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM isr_entries').get()?.count ?? 0
    while (total > this.options.maxDiskBytes || count > this.options.maxDiskEntries) {
      const oldest = db
        .query<{ namespace: string; cache_key: string; byte_size: number }, []>(
          'SELECT namespace, cache_key, byte_size FROM isr_entries ORDER BY last_access ASC LIMIT 1',
        )
        .get()
      if (!oldest) return
      db.query('DELETE FROM isr_entries WHERE namespace = ? AND cache_key = ?').run(
        oldest.namespace,
        oldest.cache_key,
      )
      total -= oldest.byte_size
      count--
    }
    db.run('PRAGMA incremental_vacuum')
  }

  private deserialize(row: EntryRow): StoredCacheEntry {
    const entry = {
      body: new Uint8Array(row.body),
      headers: JSON.parse(row.headers) as [string, string][],
      storedAt: row.stored_at,
      maxAge: row.max_age,
      swr: row.swr,
      tags: JSON.parse(row.tags) as string[],
    }
    if (
      !Number.isSafeInteger(entry.storedAt) ||
      !Number.isFinite(entry.maxAge) ||
      entry.maxAge <= 0 ||
      !Number.isFinite(entry.swr) ||
      entry.swr < 0 ||
      !Array.isArray(entry.headers) ||
      !entry.headers.every(
        (header) =>
          Array.isArray(header) &&
          header.length === 2 &&
          header.every((value) => typeof value === 'string'),
      ) ||
      !Array.isArray(entry.tags) ||
      !entry.tags.every((tag) => typeof tag === 'string')
    )
      throw new TypeError('Invalid cached ISR entry')
    return entry
  }
}
