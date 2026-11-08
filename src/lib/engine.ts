// Owns the single FFmpeg WebAssembly instance: lazy loading, progress,
// sequential conversion and recovery if the wasm engine ever crashes.
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { buildArgs, extensionOf, outputName, type ConvertOptions, type Format, type InputKind } from './formats'

export type EnginePhase = 'idle' | 'loading' | 'ready' | 'error'

export interface EngineState {
  phase: EnginePhase
  error?: string
}

let state: EngineState = { phase: 'idle' }
const listeners = new Set<() => void>()

function publish(next: EngineState) {
  state = next
  listeners.forEach((listener) => listener())
}

export function subscribeEngine(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getEngineState(): EngineState {
  return state
}

let engine: FFmpeg | null = null
let pending: Promise<FFmpeg> | null = null
let fileCounter = 0

// The FFmpeg core wasm is ~31 MB: larger than a Workers static asset can be
// (25 MiB per file, 10 MiB total on Sites), so it cannot ship with the site.
// Instead the engine files are fetched from a pinned CDN release at runtime
// and handed to ffmpeg.wasm as same-origin blob URLs (a cross-origin Worker
// script or wasm import would be blocked by the browser). Keep these versions
// in sync with @ffmpeg/core / @ffmpeg/ffmpeg in package.json.
const CDN_CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/'
const CDN_FFMPEG = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/'

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`failed to load ${url} (HTTP ${response.status})`)
  return response.text()
}

async function toBlobURL(url: string, type: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`failed to load ${url} (HTTP ${response.status})`)
  // Stream the body in chunks: Response.blob() rejects with "Failed to fetch"
  // on the ~32 MB wasm in some browsers even though the download itself works.
  const reader = response.body?.getReader()
  if (!reader) throw new Error(`failed to load ${url} (no response body)`)
  const chunks: Uint8Array<ArrayBuffer>[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(new Uint8Array(value))
  }
  return URL.createObjectURL(new Blob(chunks, { type }))
}

/**
 * worker.js imports ./const.js and ./errors.js with relative paths, which
 * cannot resolve once it becomes a blob URL. Inline all three modules into
 * one worker script (their `export` / `import` lines are stripped).
 */
async function classWorkerBlobURL(): Promise<string> {
  const [constText, errorsText, workerText] = await Promise.all([
    fetchText(`${CDN_FFMPEG}const.js`),
    fetchText(`${CDN_FFMPEG}errors.js`),
    fetchText(`${CDN_FFMPEG}worker.js`),
  ])
  const combined = [
    constText.replace(/^export /gm, ''),
    errorsText.replace(/^export /gm, ''),
    workerText.replace(/^import \{[^}]*\} from "\.\/(?:const|errors)\.js";\s*$/gm, ''),
  ].join('\n')
  return URL.createObjectURL(new Blob([combined], { type: 'text/javascript' }))
}

let engineURLs: Promise<{ coreURL: string; wasmURL: string; classWorkerURL: string }> | null = null

function loadEngineURLs() {
  if (!engineURLs) {
    engineURLs = Promise.all([
      toBlobURL(`${CDN_CORE}ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${CDN_CORE}ffmpeg-core.wasm`, 'application/wasm'),
      classWorkerBlobURL(),
    ]).then(([coreURL, wasmURL, classWorkerURL]) => ({ coreURL, wasmURL, classWorkerURL }))
  }
  return engineURLs
}

async function boot(): Promise<FFmpeg> {
  try {
    const instance = new FFmpeg()
    await instance.load(await loadEngineURLs())
    engine = instance
    publish({ phase: 'ready' })
    return instance
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    publish({ phase: 'error', error: message })
    throw new Error(`The conversion engine could not start (${message}). Reload the page and try again.`)
  } finally {
    pending = null
  }
}

/** Load the engine once, sharing the in-flight promise between callers. */
export function warmUp(): Promise<FFmpeg> {
  if (engine) return Promise.resolve(engine)
  if (!pending) {
    publish({ phase: 'loading' })
    pending = boot()
  }
  return pending
}

function dropEngine() {
  try {
    engine?.terminate()
  } catch {
    /* already gone */
  }
  engine = null
  pending = null
  publish({ phase: 'idle' })
}

const FATAL = /Aborted|RuntimeError|memory access out of bounds|out of memory|unreachable/i

function readableError(log: string[], target: Format): string {
  const interesting = [...log]
    .reverse()
    .filter((line) => /error|invalid|unknown|no such|could not|failed|unsupported|not found/i.test(line))
  const detail = interesting[0]?.replace(/^\[[^\]]+\]\s*/, '').trim()
  if (detail) return detail
  const last = [...log].reverse().find((line) => line.trim())
  return last ? last.replace(/^\[[^\]]+\]\s*/, '').trim() : `Could not write a ${target.label} file from this input.`
}

export interface Converted {
  blob: Blob
  name: string
}

export async function convertFile(
  file: File,
  target: Format,
  options: ConvertOptions,
  inputKind: InputKind,
  onProgress: (fraction: number) => void,
): Promise<Converted> {
  const instance = await warmUp()
  const tag = ++fileCounter
  const input = `in_${tag}.${extensionOf(file.name) || 'bin'}`
  const output = `out_${tag}.${target.ext}`
  const log: string[] = []

  const onLog = (event: { message: string }) => {
    log.push(event.message)
    if (log.length > 80) log.shift()
  }
  const onProgressEvent = (event: { progress: number }) => {
    if (Number.isFinite(event.progress)) {
      onProgress(Math.max(0, Math.min(0.99, event.progress)))
    }
  }

  instance.on('log', onLog)
  instance.on('progress', onProgressEvent)

  try {
    await instance.writeFile(input, new Uint8Array(await file.arrayBuffer()))
    const code = await instance.exec(buildArgs(input, output, target, options, inputKind))
    if (code !== 0) {
      throw new Error(readableError(log, target))
    }
    const data = (await instance.readFile(output)) as Uint8Array
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    return {
      blob: new Blob([buffer], { type: target.mime }),
      name: outputName(file.name, target),
    }
  } catch (error) {
    if (error instanceof Error && FATAL.test(`${error.message} ${log.join(' ')}`)) {
      dropEngine()
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    instance.off('log', onLog)
    instance.off('progress', onProgressEvent)
    await instance.deleteFile(input).catch(() => undefined)
    await instance.deleteFile(output).catch(() => undefined)
  }
}
