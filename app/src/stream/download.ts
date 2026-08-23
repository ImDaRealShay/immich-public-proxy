import { assetFetchUrl, authHeadersForAsset } from '../immich'
import { Response } from 'express-serve-static-core'
import { Asset, SharedLink } from '../types'
import { getNumericConfigOption } from '../config/access'
import { log } from '../utils/log'
import archiver, { Archiver } from 'archiver'
import { sanitize } from '../utils/sanitize'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { promises as fs, createWriteStream } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveDownloadEndpoint, ImageEndpoint } from '../gallery/sizing'
import { title } from '../share'
import { getFilename } from '../gallery/filename'
import { createLimiter } from '../utils/limiter'
import { createIdleTimeoutStream } from '../utils/idleTimeoutStream'

const STAGING_DIR_PREFIX = 'ipp-zip-'

/**
 * Download all assets in a share as a zip file.
 */
export async function downloadAll (res: Response, share: SharedLink) {
  await downloadAssets(res, share, share.assets)
}

/**
 * Delete staging directories left over from a prior run that crashed before
 * its `finally` block could clean up. Intended to run once at startup.
 *
 * A live download holds its staging dir open for the duration of the zip;
 * `maxAgeMs` should comfortably exceed any realistic download time so we
 * never delete a dir from a still-running download in another worker.
 */
export async function sweepStaleStagingDirs (maxAgeMs = 60 * 60 * 1000) {
  const root = tmpdir()
  const cutoff = Date.now() - maxAgeMs
  const entries = await fs.readdir(root).catch(() => [] as string[])
  for (const name of entries) {
    if (!name.startsWith(STAGING_DIR_PREFIX)) continue
    const path = join(root, name)
    const stat = await fs.stat(path).catch(() => null)
    if (!stat || stat.mtimeMs >= cutoff) continue
    await fs.rm(path, { recursive: true, force: true }).catch(e => {
      log.warn(`Failed to sweep stale staging dir ${path}: ${e instanceof Error ? e.message : String(e)}`)
    })
  }
}

type StagedAsset = { tempfile: string, asset: Asset, endpoint: ImageEndpoint, servedMime?: string }
type Failure = { asset: Asset, url: string, status?: number, error?: unknown }
type StageOutcome = StagedAsset | { failure: Failure } | null

type StagingOptions = {
  stagingDir: string
  concurrency: number
  maxAttempts: number
  headerTimeoutMs: number
  idleTimeoutMs: number
}

/**
 * Stream the given assets back as a zip file.
 *
 * Immich's own download service (server/src/services/download.service.ts)
 * zips files directly from local disk - no HTTP, retries, or timeouts needed.
 * We're a proxy fetching over HTTP, so the shape diverges:
 *
 *   - Bounded concurrency against the upstream Immich server.
 *   - Two-phase fetch per asset: get headers (retried with linear backoff,
 *     bounded by a 20s header-receipt timeout), then stream the body to a
 *     temp file under an idle timeout that resets on every chunk -
 *     slow-but-steady downloads survive, truly stalled ones fail fast.
 *   - Stage everything to disk first so we can detect failure BEFORE any
 *     bytes hit the client. Once we've started streaming the zip we can't
 *     recover gracefully; aborting means killing the response socket and
 *     leaving a visibly broken download. This is the alternative to silently
 *     omitting failed assets - the user gets a clear "broken" signal instead
 *     of a zip quietly missing files.
 *
 * The only thing we share with Immich here is using zip STORE (no
 * compression), since photos and videos are already compressed.
 */
export async function downloadAssets (res: Response, share: SharedLink, assets: Asset[]) {
  res.setHeader('Content-Type', 'application/zip')
  let filename = (sanitize(title(share)) || 'photos') + '.zip'
  filename = encodeURI(filename)
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
  // Hint to intermediate proxies (Nginx, etc.) not to buffer this response.
  res.setHeader('X-Accel-Buffering', 'no')
  const archive = archiver('zip', { store: true })
  // Without a listener, an archiver 'error' emission would crash the process.
  archive.on('error', e => log(`Archiver error for share ${share.key}: ${e.message}`))
  archive.pipe(res)

  const options: StagingOptions = {
    stagingDir: await fs.mkdtemp(join(tmpdir(), STAGING_DIR_PREFIX)),
    concurrency: Math.max(1, getNumericConfigOption('ipp.downloadFromImmichConcurrencyLimit', 20)),
    maxAttempts: 3,
    headerTimeoutMs: 20_000,
    idleTimeoutMs: 20_000
  }

  const controller = new AbortController()
  let clientGone = false
  let resolveClosed!: () => void
  const resClosed = new Promise<void>(resolve => { resolveClosed = resolve })
  res.once('close', () => {
    if (res.writableFinished) return
    clientGone = true
    controller.abort()
    resolveClosed()
  })

  try {
    const stages = stageAssetsToDisk(share, assets, options, controller.signal)
    const failure = await archiveStaged(archive, stages, controller)
    if (clientGone) {
      log(`Zip download for share ${share.key} cancelled by client`)
      teardownArchive(archive, res)
      return
    }
    if (failure) {
      abortDownload(archive, res, share, failure)
      return
    }
    // finalize() resolves when archiver has finished writing the zip output,
    // which means every queued tempfile has been read. Safe to delete after.
    // Raced against client disconnect because finalize() never settles once
    // the response is destroyed. The inline rejection handler also stops a
    // late finalize failure becoming an unhandled rejection after a lost race.
    const finished = archive.finalize().then(() => 'done' as const, () => 'error' as const)
    const outcome = await Promise.race([finished, resClosed.then(() => 'closed' as const)])
    if (outcome !== 'done') {
      if (outcome === 'closed') log(`Zip download for share ${share.key} cancelled by client`)
      // 'error' was already logged by the archiver error listener
      teardownArchive(archive, res)
    }
  } finally {
    await fs.rm(options.stagingDir, { recursive: true, force: true }).catch(() => { /* best effort */ })
  }
}

/**
 * Kick off staging for every asset at once; the limiter caps how many run
 * concurrently. Returns the promise array in input order so the consumer can
 * archive in order.
 */
function stageAssetsToDisk (share: SharedLink, assets: Asset[], options: StagingOptions, signal: AbortSignal): Promise<StageOutcome>[] {
  const limit = createLimiter(options.concurrency)
  return assets.map((asset, index) => limit(() => stageOne(share, asset, index, options, signal)))
}

/**
 * Walk the staged assets in input order, adding each to the archive as soon
 * as it lands. The first failure aborts the download signal (so unstarted
 * stages bail out and in-flight fetches are cancelled) and is returned to the
 * caller. We wait for in-flight stages to settle before returning so the
 * staging dir is safe to delete.
 */
async function archiveStaged (archive: Archiver, stages: Promise<StageOutcome>[], controller: AbortController): Promise<Failure | null> {
  let failure: Failure | null = null
  for (const stage of stages) {
    const result = await stage
    if (result === null) break // aborted by an earlier stage
    if ('failure' in result) {
      controller.abort()
      failure = result.failure
      break
    }
    // archive.file queues the entry; archiver lazily opens and reads it.
    archive.file(result.tempfile, { name: getFilename(result.asset, result.endpoint.servedSize, result.servedMime) })
  }

  // After abort, wait for any in-flight stages to settle before we delete
  // the staging dir. stageOne never rejects (errors become failure objects),
  // so a plain Promise.all is safe.
  if (controller.signal.aborted) await Promise.all(stages)
  return failure
}

function abortDownload (archive: Archiver, res: Response, share: SharedLink, failure: Failure) {
  const detail = failure.status !== undefined
    ? `HTTP ${failure.status}`
    : (failure.error instanceof Error ? failure.error.message : String(failure.error))
  log(`Aborting zip download for share ${share.key}: failed to fetch asset ${failure.asset.id} from ${failure.url} (${detail})`)
  teardownArchive(archive, res)
}

/**
 * Tear down an aborted archive so it releases its resources. `abort()` alone
 * is not enough; it kills the queue but leaves any in-flight entry paused,
 * holding an open read fd on its tempfile forever #284
 */
function teardownArchive (archive: Archiver, res: Response) {
  archive.abort()
  archive.unpipe(res)
  res.destroy()
  archive.resume()
}

/**
 * Fetch one asset's upstream bytes into a temp file. Two phases:
 *   1. fetchHeadersWithRetry - get the response headers, retried on
 *      transient failure.
 *   2. streamBodyToTempFile - drain the body to disk under an idle timeout.
 *
 * Returns the staged asset on success, a wrapped Failure on error, or null
 * if we observed the abort flag and bailed without doing work.
 */
async function stageOne (share: SharedLink, asset: Asset, index: number, options: StagingOptions, signal: AbortSignal): Promise<StageOutcome> {
  if (signal.aborted) return null

  const endpoint = resolveDownloadEndpoint(asset, share.allowDownload !== false)
  const url = assetFetchUrl(asset, endpoint.subpath, endpoint.sizeQueryParam)
  const reqAuthHeaders = await authHeadersForAsset(asset)

  const fetched = await fetchHeadersWithRetry(url, reqAuthHeaders, options.maxAttempts, options.headerTimeoutMs, signal, asset)
  if (fetched === null) return null
  if ('failure' in fetched) return { failure: { ...fetched.failure, asset, url } }

  // Album "grid" assets (timeline-sourced) lack originalFileName/Mime, so
  // getFilename would fall back to an id-based name. The `/original` response
  // carries the real name in Content-Disposition and the mime in Content-Type,
  // so recover them from the headers we already fetched - no extra calls.
  const stagedAsset = asset.originalFileName ? asset : enrichFromHeaders(asset, fetched.response)

  // Playback-fallback downloads serve Immich's transcode; carry the response
  // content-type so the zip entry's extension matches the actual bytes.
  const servedMime = endpoint.subpath === '/video/playback'
    ? (fetched.response.headers.get('content-type') || '').split(';')[0].trim() || undefined
    : undefined

  // Use the array index in the path so we never collide on duplicate IDs.
  const tempfile = join(options.stagingDir, `${index}-${asset.id}`)
  const streamed = await streamBodyToTempFile(fetched.response, tempfile, options.idleTimeoutMs)
  if ('failure' in streamed) return { failure: { asset, url, error: streamed.failure } }

  return { tempfile, asset: stagedAsset, endpoint, servedMime }
}

/**
 * Fill in originalFileName / originalMimeType from an asset response's
 * `Content-Disposition` / `Content-Type` headers, for assets that arrived
 * without them (lazy album grid assets). Returns a shallow copy so the cached
 * share asset is never mutated.
 */
function enrichFromHeaders (asset: Asset, response: globalThis.Response): Asset {
  const fileName = filenameFromContentDisposition(response.headers.get('content-disposition'))
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim() || undefined
  if (!fileName && !mime) return asset
  return {
    ...asset,
    originalFileName: asset.originalFileName || fileName,
    originalMimeType: asset.originalMimeType || mime
  }
}

/**
 * Extract a filename from a `Content-Disposition` header. Prefers the RFC 5987
 * `filename*=UTF-8''...` form (percent-decoded) over the plain `filename=`.
 * Returns undefined when neither is present.
 */
export function filenameFromContentDisposition (header: string | null): string | undefined {
  if (!header) return undefined
  const extended = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i)
  if (extended) {
    const raw = extended[1].trim().replace(/^"|"$/g, '')
    try {
      return decodeURIComponent(raw)
    } catch (e) {
      return raw
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i)
  return plain ? plain[1].trim() : undefined
}

type HeaderFetchOutcome =
  | { response: globalThis.Response }
  | { failure: { status?: number, error?: unknown } }
  | null

/**
 * GET `url` until we have response headers or run out of attempts. Retries
 * use linear backoff to avoid hammering a struggling upstream.
 *
 * AbortController + clearable timer (rather than `AbortSignal.timeout`)
 * because the signal we pass to fetch stays bound to the response body - if
 * the timeout fires after headers arrive but while the body is still
 * streaming, the body read errors out. We clear the header timer as soon
 * as we have a response; downstream the idle-timeout transform guards
 * against stalled bodies.
 *
 * The download-wide `signal` is combined into the fetch signal so that an
 * aborted download (asset failure or client disconnect) cancels the header
 * wait and any in-flight body stream immediately.
 */
async function fetchHeadersWithRetry (
  url: string,
  headers: Record<string, string>,
  maxAttempts: number,
  headerTimeoutMs: number,
  signal: AbortSignal,
  asset: Asset
): Promise<HeaderFetchOutcome> {
  let lastStatus: number | undefined
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) return null
    const controller = new AbortController()
    const headerTimer = setTimeout(() => controller.abort(new Error(`No response headers within ${headerTimeoutMs}ms`)), headerTimeoutMs)
    try {
      const data = await fetch(url, { signal: AbortSignal.any([controller.signal, signal]), headers })
      clearTimeout(headerTimer)
      if (data.ok) return { response: data }
      await data.body?.cancel()
      lastStatus = data.status
      lastError = undefined
    } catch (e) {
      clearTimeout(headerTimer)
      lastError = e
      lastStatus = undefined
    }
    if (attempt < maxAttempts && !signal.aborted) {
      const reason = lastStatus !== undefined
        ? `HTTP ${lastStatus}`
        : (lastError instanceof Error ? lastError.message : String(lastError))
      log(`Retrying asset ${asset.id} (attempt ${attempt + 1}/${maxAttempts}) after ${reason}`)
      await new Promise(resolve => setTimeout(resolve, 500 * attempt))
    }
  }
  return { failure: { status: lastStatus, error: lastError } }
}

/**
 * Stream `response.body` to `tempfile`, guarded by an idle timeout. The
 * idle stream destroys itself if no chunk arrives within `idleMs`, killing
 * the pipeline with a clear error.
 */
async function streamBodyToTempFile (response: globalThis.Response, tempfile: string, idleMs: number): Promise<{ ok: true } | { failure: unknown }> {
  if (!response.body) return { failure: new Error('Upstream response has no body') }
  // `response.body` is the global/undici ReadableStream<Uint8Array>;
  // Readable.fromWeb expects node:stream/web's ReadableStream<any>. The
  // two are structurally compatible at runtime but TS sees them as
  // distinct nominal types, so a cast is needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = Readable.fromWeb(response.body as any)
  try {
    await pipeline(body, createIdleTimeoutStream(idleMs), createWriteStream(tempfile))
    return { ok: true }
  } catch (e) {
    return { failure: e }
  }
}
