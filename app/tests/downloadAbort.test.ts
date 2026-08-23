import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { Writable } from 'stream'
import type { Response } from 'express-serve-static-core'
import { downloadAssets } from '../src/stream/download'
import { Asset, AssetType, KeyType, SharedLink } from '../src/types'

/*
Isolate this suite's staging dirs in a dedicated tmp dir so the
before/after assertions can't race other test files that also create
ipp-zip-* dirs under the real os.tmpdir().
*/
const { TEST_TMP } = vi.hoisted(() => {
  return { TEST_TMP: (process.env.TMPDIR || '/tmp') + '/ipp-download-abort-test-' + process.pid }
})
vi.mock('os', async importOriginal => {
  const orig = await importOriginal<typeof import('os')>()
  return { ...orig, tmpdir: () => TEST_TMP }
})

beforeAll(async () => {
  await fs.mkdir(TEST_TMP, { recursive: true })
})

afterAll(async () => {
  await fs.rm(TEST_TMP, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function stagingDirs (): Promise<string[]> {
  const entries = await fs.readdir(TEST_TMP).catch(() => [] as string[])
  return entries.filter(name => name.startsWith('ipp-zip-'))
}

/**
 * Open fds pointing at deleted staging tempfiles. An aborted archiver used to
 * keep the in-flight entry's read stream open forever; on tmpfs that pins the
 * deleted file's space (issue #284). Linux-only introspection - returns []
 * elsewhere, making the assertions no-ops.
 */
async function deletedStagingFds (): Promise<string[]> {
  const fds = await fs.readdir('/proc/self/fd').catch(() => [] as string[])
  const leaked: string[] = []
  for (const fd of fds) {
    const target = await fs.readlink('/proc/self/fd/' + fd).catch(() => '')
    if (target.includes('ipp-zip-') && target.includes('(deleted)')) leaked.push(target)
  }
  return leaked
}

/** Wait for archiver's post-abort drain to release fds, then return leftovers. */
async function settledDeletedStagingFds (timeoutMs = 3000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  let leaked = await deletedStagingFds()
  while (leaked.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    leaked = await deletedStagingFds()
  }
  return leaked
}

function makeAsset (id: string): Asset {
  return {
    id,
    key: 'testkey',
    keyType: KeyType.key,
    type: AssetType.image,
    isTrashed: false,
    originalFileName: id + '.jpg',
    originalMimeType: 'image/jpeg'
  }
}

const share: SharedLink = {
  key: 'testkey',
  keyType: KeyType.key,
  type: 'ALBUM',
  description: 'Test album',
  assets: []
}

/*
Minimal stand-in for the Express response: a real Writable (so 'close',
writableFinished and destroy behave like the real thing) plus the header
setters downloadAssets calls.
*/
class FakeRes extends Writable {
  received = 0

  constructor () {
    super()
    // Node's http stack handles response stream errors internally; a bare
    // Writable would crash the test process on destroy(err) instead.
    this.on('error', () => { /* swallowed, like http.ServerResponse */ })
  }

  setHeader (_name: string, _value: string) { return this }

  _write (chunk: Buffer, _enc: string, cb: (error?: Error | null) => void) {
    this.received += chunk.length
    cb()
  }
}

function asResponse (res: FakeRes): Response {
  return res as unknown as Response
}

/** Fetch stub that returns the full body immediately. */
function instantFetch (bytes: number) {
  return vi.fn(async () => new globalThis.Response(new Uint8Array(bytes), { status: 200 }))
}

/**
 * Fetch stub whose body sends one chunk then stays open forever, erroring
 * only when the passed-in signal aborts - like a real streaming download
 * that gets cancelled. Records each request's signal for assertions.
 */
function trickleFetch (signals: AbortSignal[]) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal
    signals.push(signal)
    const stream = new ReadableStream({
      start (controller) {
        controller.enqueue(new Uint8Array(1024))
        signal.addEventListener('abort', () => {
          try { controller.error(signal.reason ?? new Error('aborted')) } catch { /* already errored */ }
        })
      }
    })
    return new globalThis.Response(stream, { status: 200 })
  })
}

describe('downloadAssets abort handling', () => {
  it('streams a zip and cleans up the staging dir on the happy path', async () => {
    vi.stubGlobal('fetch', instantFetch(2048))
    const res = new FakeRes()
    await downloadAssets(asResponse(res), share, [makeAsset('a1'), makeAsset('a2')])
    expect(res.received).toBeGreaterThan(0)
    expect(res.writableFinished).toBe(true)
    expect(await stagingDirs()).toEqual([])
  })

  it('resolves, cleans up and cancels upstream fetches when the client aborts mid-staging', async () => {
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', trickleFetch(signals))
    const res = new FakeRes()
    const done = downloadAssets(asResponse(res), share, [makeAsset('a1'), makeAsset('a2')])
    // Give staging a moment to start, then drop the client connection
    await new Promise(resolve => setTimeout(resolve, 50))
    res.destroy(new Error('client aborted'))
    await done
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every(s => s.aborted)).toBe(true)
    expect(await stagingDirs()).toEqual([])
    expect(await settledDeletedStagingFds()).toEqual([])
  }, 10_000)

  it('resolves and cleans up when the client aborts while the zip is streaming', async () => {
    // Large enough that archiver can't flush everything into a destroyed
    // response; without disconnect handling finalize() would hang forever.
    vi.stubGlobal('fetch', instantFetch(5 * 1024 * 1024))
    const res = new FakeRes()
    const origWrite = res._write.bind(res)
    let first = true
    res._write = (chunk, enc, cb) => {
      origWrite(chunk, enc, cb)
      if (first) {
        first = false
        setImmediate(() => res.destroy(new Error('client aborted')))
      }
    }
    await downloadAssets(asResponse(res), share, [makeAsset('a1'), makeAsset('a2')])
    expect(await stagingDirs()).toEqual([])
    // The regression from issue #284's follow-up: the staging dir was removed
    // but archiver still held an open fd on a deleted tempfile.
    expect(await settledDeletedStagingFds()).toEqual([])
  }, 10_000)

  it('cleans up and destroys the response when an upstream fetch keeps failing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new globalThis.Response('nope', { status: 500 })))
    const res = new FakeRes()
    await downloadAssets(asResponse(res), share, [makeAsset('a1')])
    expect(res.destroyed).toBe(true)
    expect(await stagingDirs()).toEqual([])
    expect(await settledDeletedStagingFds()).toEqual([])
  }, 10_000)
})
