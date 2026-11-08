import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  AUDIO_FORMATS,
  DEFAULT_OPTIONS,
  IMAGE_FORMATS,
  VIDEO_FORMATS,
  defaultTarget,
  detectKind,
  extensionOf,
  findFormat,
  formatBytes,
  targetsFor,
  type ConvertOptions,
  type InputKind,
  type MediaKind,
} from './lib/formats'
import { convertFile, getEngineState, subscribeEngine, warmUp } from './lib/engine'

type Theme = 'dark' | 'light'

const THEME_KEY = 'omniconvert-theme'

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    /* storage blocked — fall through to the system preference */
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme)

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    root.style.colorScheme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0a0a0c' : '#e7e7ea')
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* storage blocked */
    }
  }, [theme])

  const toggle = useCallback(() => {
    const root = document.documentElement
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    root.classList.add('theme-changing')
    window.setTimeout(() => root.classList.remove('theme-changing'), reduce ? 0 : 640)
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }, [])

  return { theme, toggle }
}

type Status = 'queued' | 'converting' | 'done' | 'error'

interface QueueItem {
  id: string
  file: File
  kind: InputKind
  targetId: string
  status: Status
  progress: number
  error?: string
  result?: { url: string; name: string; size: number }
  preview?: { url: string; type: 'image' | 'video' }
}

interface RecentEntry {
  id: string
  name: string
  url: string
  size: number
  source: string
  format: string
  at: number
}

const MAX_RECENT = 6

function clockTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const FORMAT_COUNT = IMAGE_FORMATS.length + AUDIO_FORMATS.length + VIDEO_FORMATS.length

function buildItem(file: File): QueueItem {
  const kind = detectKind(file)
  const target = defaultTarget(kind, extensionOf(file.name))
  const previewType: 'image' | 'video' | null = file.type.startsWith('image/')
    ? 'image'
    : file.type.startsWith('video/')
      ? 'video'
      : null
  return {
    id: crypto.randomUUID(),
    file,
    kind,
    targetId: target.id,
    status: 'queued',
    progress: 0,
    preview: previewType ? { url: URL.createObjectURL(file), type: previewType } : undefined,
  }
}

function triggerDownload(url: string, name: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export default function App() {
  const [items, setItems] = useState<QueueItem[]>([])
  const [options, setOptions] = useState<ConvertOptions>(DEFAULT_OPTIONS)
  const [running, setRunning] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemsRef = useRef<QueueItem[]>([])
  const runningRef = useRef(false)
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const recentRef = useRef<RecentEntry[]>([])

  const engine = useSyncExternalStore(subscribeEngine, getEngineState, getEngineState)
  const { theme, toggle: toggleTheme } = useTheme()

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  // Boot the engine on first paint so the queue has a real loading state to show.
  useEffect(() => {
    void warmUp().catch(() => undefined)
  }, [])

  // Keep the browser from opening a file when it is dropped outside the dropzone.
  useEffect(() => {
    const block = (event: DragEvent) => event.preventDefault()
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  // Release every object URL when the app unmounts.
  useEffect(() => {
    return () => {
      for (const item of itemsRef.current) {
        if (item.preview) URL.revokeObjectURL(item.preview.url)
        if (item.result) URL.revokeObjectURL(item.result.url)
      }
      for (const entry of recentRef.current) URL.revokeObjectURL(entry.url)
    }
  }, [])

  const patch = useCallback((id: string, next: Partial<QueueItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...next } : item)))
  }, [])

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const incoming = Array.from(fileList)
    if (!incoming.length) return
    setItems((prev) => [...prev, ...incoming.map(buildItem)])
    // Warm the engine up now so the first conversion starts instantly.
    void warmUp().catch(() => undefined)
  }, [])

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const item = prev.find((entry) => entry.id === id)
      if (item?.preview) URL.revokeObjectURL(item.preview.url)
      if (item?.result) URL.revokeObjectURL(item.result.url)
      return prev.filter((entry) => entry.id !== id)
    })
  }, [])

  const clearAll = useCallback(() => {
    setItems((prev) => {
      for (const item of prev) {
        if (item.preview) URL.revokeObjectURL(item.preview.url)
        if (item.result) URL.revokeObjectURL(item.result.url)
      }
      return []
    })
  }, [])

  /** Keep a finished file downloadable after its queue card is gone. */
  const remember = useCallback((entry: RecentEntry) => {
    const previous = recentRef.current
    const list = [entry, ...previous.filter((old) => old.name !== entry.name || old.size !== entry.size)].slice(
      0,
      MAX_RECENT,
    )
    const kept = new Set(list.map((item) => item.url))
    for (const old of previous) if (!kept.has(old.url)) URL.revokeObjectURL(old.url)
    recentRef.current = list
    setRecent(list)
  }, [])

  const forget = useCallback((id: string) => {
    const entry = recentRef.current.find((item) => item.id === id)
    if (!entry) return
    URL.revokeObjectURL(entry.url)
    const list = recentRef.current.filter((item) => item.id !== id)
    recentRef.current = list
    setRecent(list)
  }, [])

  const forgetAll = useCallback(() => {
    for (const entry of recentRef.current) URL.revokeObjectURL(entry.url)
    recentRef.current = []
    setRecent([])
  }, [])

  const setTarget = useCallback((id: string, targetId: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item
        if (item.result) URL.revokeObjectURL(item.result.url)
        return { ...item, targetId, status: 'queued', progress: 0, error: undefined, result: undefined }
      }),
    )
  }, [])

  const runQueue = useCallback(async () => {
    if (runningRef.current) return
    const pending = itemsRef.current.filter((item) => item.status === 'queued' || item.status === 'error')
    if (!pending.length) return

    runningRef.current = true
    setRunning(true)

    for (const queued of pending) {
      const current = itemsRef.current.find((item) => item.id === queued.id)
      const target = current && findFormat(current.targetId)
      if (!current || !target) continue

      patch(current.id, { status: 'converting', progress: 0, error: undefined })
      try {
        const { blob, name } = await convertFile(
          current.file,
          target,
          options,
          current.kind,
          (fraction) => patch(current.id, { progress: fraction }),
        )
        const url = URL.createObjectURL(blob)
        remember({
          id: crypto.randomUUID(),
          name,
          url: URL.createObjectURL(blob),
          size: blob.size,
          source: current.file.name,
          format: target.label,
          at: Date.now(),
        })
        setItems((prev) =>
          prev.map((item) => {
            if (item.id !== current.id) return item
            if (item.result) URL.revokeObjectURL(item.result.url)
            return {
              ...item,
              status: 'done',
              progress: 1,
              result: { url, name, size: blob.size },
              preview: item.preview ?? { url, type: blob.type.startsWith('video/') ? 'video' : 'image' },
            }
          }),
        )
      } catch (error) {
        patch(current.id, {
          status: 'error',
          progress: 0,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    runningRef.current = false
    setRunning(false)
  }, [options, patch, remember])

  const downloadAll = useCallback(() => {
    const finished = itemsRef.current.filter((item) => item.result)
    finished.forEach((item, index) => {
      window.setTimeout(() => {
        if (item.result) triggerDownload(item.result.url, item.result.name)
      }, index * 320)
    })
  }, [])

  const pendingCount = items.filter((item) => item.status === 'queued' || item.status === 'error').length
  const finishedItems = items.filter((item) => item.result)
  const doneCount = items.filter((item) => item.status === 'done').length
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0)
  const convertedBytes = finishedItems.reduce((sum, item) => sum + (item.result?.size ?? 0), 0)
  const hasTimed = items.some((item) => findFormat(item.targetId)?.kind !== 'image')
  const hasVideo = items.some((item) => findFormat(item.targetId)?.kind === 'video')

  return (
    <div className="app-shell">
      <div className="glow glow-a" aria-hidden />
      <div className="glow glow-b" aria-hidden />

      <header className="site-header">
        <a className="brand" href="#top">
          <span className="brand-mark" aria-hidden>
            <SwapIcon />
          </span>
          <span className="brand-name">OmniConvert</span>
        </a>
        <div className="header-right">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <span className="pill">
            <span className="pill-dot" aria-hidden />
            100% on-device
          </span>
          <span className={`engine-chip ${engine.phase}`} title={engine.error ?? 'FFmpeg WebAssembly engine'}>
            <span className="engine-dot" aria-hidden />
            {engine.phase === 'ready'
              ? 'Engine ready'
              : engine.phase === 'loading'
                ? 'Loading engine…'
                : engine.phase === 'error'
                  ? 'Engine offline'
                  : 'Engine on standby'}
          </span>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <h1>
            Convert <span className="hero-em">any media</span>
            <br />
            without uploading it.
          </h1>
          <p className="lede">
            Drop images, audio or video and get back the exact format you need. A full FFmpeg engine runs inside this
            tab, so your files are read, converted and saved on your own device — never sent to a server.
          </p>
          <div className="hero-stats">
            <div className="stat">
              <span className="stat-value">{FORMAT_COUNT}</span>
              <span className="stat-label">output formats</span>
            </div>
            <div className="stat">
              <span className="stat-value">0</span>
              <span className="stat-label">uploads</span>
            </div>
            <div className="stat">
              <span className="stat-value">Any</span>
              <span className="stat-label">input FFmpeg reads</span>
            </div>
          </div>
        </section>

        <section
          className={`dropzone ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files)
          }}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              inputRef.current?.click()
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Add media files to convert"
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) addFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <span className="dz-icon" aria-hidden>
            <UploadIcon />
          </span>
          <span className="dz-headline">{dragging ? 'Drop to add them' : 'Drop your media here'}</span>
          <span className="dz-sub">or click to browse · images, audio & video · nothing leaves this device</span>
          <span className="dz-chips" aria-hidden>
            {['PNG', 'JPG', 'WEBP', 'MP3', 'WAV', 'FLAC', 'MP4', 'WEBM', 'MOV', 'GIF'].map((chip) => (
              <span key={chip} className="chip">
                {chip}
              </span>
            ))}
          </span>
        </section>

        {engine.phase === 'error' && (
          <div className="banner" role="alert">
            <AlertIcon />
            <span>{engine.error ?? 'The engine failed to start.'}</span>
            <button className="btn btn-small" onClick={() => void warmUp().catch(() => undefined)}>
              Retry
            </button>
          </div>
        )}

        {!items.length && engine.phase === 'loading' && <QueueSkeleton />}

        {items.length > 0 && (
          <section className="queue">
            <div className="queue-head">
              <h2 className="queue-title">
                Queue <span className="queue-count">{items.length}</span>
                <span className="queue-meta">
                  {formatBytes(totalBytes)} in
                  {doneCount > 0 && ` · ${formatBytes(convertedBytes)} out`}
                </span>
              </h2>
              <div className="queue-actions">
                <button className="btn btn-primary" onClick={() => void runQueue()} disabled={running || !pendingCount}>
                  {running ? <span className="spinner" aria-hidden /> : <BoltIcon />}
                  {running ? 'Converting…' : pendingCount ? `Convert ${pendingCount}` : 'Converted'}
                </button>
                <button className="btn" onClick={downloadAll} disabled={!finishedItems.length}>
                  <DownloadIcon />
                  Download all
                </button>
                <button className="btn btn-quiet" onClick={clearAll} disabled={running}>
                  Clear
                </button>
              </div>
            </div>

            <div className="settings">
              <div className="field">
                <label htmlFor="quality">
                  Quality <span className="field-value">{options.quality}%</span>
                </label>
                <input
                  id="quality"
                  type="range"
                  min={1}
                  max={100}
                  value={options.quality}
                  onChange={(event) => setOptions((prev) => ({ ...prev, quality: Number(event.target.value) }))}
                  className="slider"
                />
                <span className="hint">Image quality · video CRF · audio bitrate</span>
              </div>

              <div className="field">
                <label htmlFor="scale">Resolution</label>
                <select
                  id="scale"
                  className="select"
                  value={options.maxHeight}
                  onChange={(event) => setOptions((prev) => ({ ...prev, maxHeight: Number(event.target.value) }))}
                >
                  <option value={0}>Keep original</option>
                  <option value={2160}>2160p · 4K</option>
                  <option value={1440}>1440p</option>
                  <option value={1080}>1080p</option>
                  <option value={720}>720p</option>
                  <option value={480}>480p</option>
                  <option value={360}>360p</option>
                </select>
                <span className="hint">Downscale video and images</span>
              </div>

              <div className={`field ${hasTimed ? '' : 'is-muted'}`}>
                <label>Trim clip</label>
                <div className="trim-row">
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    className="input-number"
                    placeholder="Start"
                    aria-label="Trim start in seconds"
                    value={options.trimStart || ''}
                    disabled={!hasTimed}
                    onChange={(event) => setOptions((prev) => ({ ...prev, trimStart: Number(event.target.value) || 0 }))}
                  />
                  <span className="trim-sep">→</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    className="input-number"
                    placeholder="End"
                    aria-label="Trim end in seconds"
                    value={options.trimEnd || ''}
                    disabled={!hasTimed}
                    onChange={(event) => setOptions((prev) => ({ ...prev, trimEnd: Number(event.target.value) || 0 }))}
                  />
                  <span className="trim-unit">s</span>
                </div>
                <span className="hint">Seconds · applies to audio & video</span>
              </div>

              <div className={`field ${hasVideo ? '' : 'is-muted'}`}>
                <label htmlFor="mute">Audio track</label>
                <div className="switch-row">
                  <button
                    id="mute"
                    type="button"
                    role="switch"
                    aria-checked={options.mute}
                    className={`switch ${options.mute ? 'is-on' : ''}`}
                    disabled={!hasVideo}
                    onClick={() => setOptions((prev) => ({ ...prev, mute: !prev.mute }))}
                  >
                    <span className="switch-knob" aria-hidden />
                  </button>
                  <span className="switch-label">{options.mute ? 'Remove audio' : 'Keep audio'}</span>
                </div>
                <span className="hint">For video outputs</span>
              </div>
            </div>

            <ul className="list">
              {items.map((item) => {
                const target = findFormat(item.targetId)
                const delta = item.result ? Math.round((1 - item.result.size / item.file.size) * 100) : 0
                return (
                  <li key={item.id} className={`card is-${item.status}`}>
                    <Thumb preview={item.preview} kind={item.kind} />

                    <div className="card-body">
                      <div className="card-top">
                        <span className="file-name" title={item.file.name}>
                          {item.file.name}
                        </span>
                        <span className="file-meta">
                          {formatBytes(item.file.size)}
                          {item.result && (
                            <>
                              <span className="arrow" aria-hidden>
                                →
                              </span>
                              {formatBytes(item.result.size)}
                              <span className={`delta ${delta >= 0 ? 'is-down' : 'is-up'}`}>
                                {delta >= 0 ? `−${delta}%` : `+${Math.abs(delta)}%`}
                              </span>
                            </>
                          )}
                        </span>
                      </div>

                      <div className="card-controls">
                        <span className={`kind-tag kind-${item.kind}`}>
                          {item.kind === 'unknown' ? 'FILE' : item.kind}
                        </span>
                        <ArrowIcon />
                        <FormatSelect
                          value={item.targetId}
                          kind={item.kind}
                          disabled={item.status === 'converting'}
                          onChange={(id) => setTarget(item.id, id)}
                        />
                        <span className="format-note">{target?.note}</span>
                      </div>

                      <div className="status-line">
                        {item.status === 'converting' && (
                          <>
                            <span className="progress">
                              <span className="progress-fill" style={{ transform: `scaleX(${Math.max(0.04, item.progress)})` }} />
                            </span>
                            <span className="status-text">{Math.round(item.progress * 100)}%</span>
                          </>
                        )}
                        {item.status === 'queued' && <span className="status-text muted">Ready to convert</span>}
                        {item.status === 'done' && (
                          <span className="status-text done">
                            <CheckIcon /> Done
                          </span>
                        )}
                        {item.status === 'error' && (
                          <span className="status-text failed" title={item.error}>
                            <AlertIcon /> {item.error}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="card-actions">
                      {item.status === 'done' && item.result ? (
                        <DownloadLink url={item.result.url} name={item.result.name} />
                      ) : (
                        <button
                          className="icon-btn"
                          title="Convert this file"
                          aria-label={`Convert ${item.file.name}`}
                          disabled={running || item.status === 'converting'}
                          onClick={() => void runQueue()}
                        >
                          {item.status === 'converting' ? <span className="spinner" aria-hidden /> : <BoltIcon />}
                        </button>
                      )}
                      <button
                        className="icon-btn"
                        title="Remove"
                        aria-label={`Remove ${item.file.name}`}
                        disabled={item.status === 'converting'}
                        onClick={() => removeItem(item.id)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>

            <p className="queue-foot">
              The first conversion loads the FFmpeg engine (about 32 MB, from a pinned CDN) into this tab. Large videos
              are limited by your device's memory, not by a server.
            </p>
          </section>
        )}

        {recent.length > 0 && (
          <section className="queue recent" aria-label="Recent downloads">
            <div className="queue-head">
              <h2 className="queue-title">
                Recent downloads
                <span className="queue-meta">{recent.length}</span>
              </h2>
              <div className="queue-actions">
                <button className="btn btn-quiet" onClick={forgetAll}>
                  Clear history
                </button>
              </div>
            </div>

            <ul className="list recent-list">
              {recent.map((entry) => (
                <li className="card is-done" key={entry.id}>
                  <div className="thumb">
                    <span className="thumb-icon">
                      <CheckIcon />
                    </span>
                  </div>
                  <div className="card-body">
                    <div className="card-top">
                      <span className="file-name" title={entry.name}>
                        {entry.name}
                      </span>
                      <span className="file-meta">{formatBytes(entry.size)}</span>
                    </div>
                    <span className="file-sub">
                      {entry.source} → {entry.format} · saved {clockTime(entry.at)}
                    </span>
                  </div>
                  <div className="card-actions">
                    <DownloadLink url={entry.url} name={entry.name} />
                    <button
                      className="icon-btn"
                      title="Remove from history"
                      aria-label={`Remove ${entry.name} from history`}
                      onClick={() => forget(entry.id)}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="features">
          <article className="feature">
            <span className="feature-icon" aria-hidden>
              <LockIcon />
            </span>
            <h3>Never leaves your device</h3>
            <p>There is no upload step and no server. Files are decoded, converted and handed back as a local download.</p>
          </article>
          <article className="feature">
            <span className="feature-icon" aria-hidden>
              <ChipIcon />
            </span>
            <h3>Real FFmpeg, in the tab</h3>
            <p>H.264, H.265, VP9, AAC, MP3, Vorbis, Opus, FLAC and WebP encoders — the same tools used by studios.</p>
          </article>
          <article className="feature">
            <span className="feature-icon" aria-hidden>
              <LayersIcon />
            </span>
            <h3>Batch and tweak</h3>
            <p>Queue a whole folder, pick a format per file, downscale, trim or strip audio, then download everything.</p>
          </article>
          <article className="feature">
            <span className="feature-icon" aria-hidden>
              <InfinityIcon />
            </span>
            <h3>No accounts, no limits</h3>
            <p>No sign-up, no watermark, no daily counter. Convert as often as you like, offline included.</p>
          </article>
        </section>
      </main>

      <footer className="site-footer">
        <span>OmniConvert · FFmpeg 5.1 compiled to WebAssembly</span>
        <span>{FORMAT_COUNT} output formats · files stay in your browser</span>
      </footer>
    </div>
  )
}

function FormatSelect({
  value,
  kind,
  disabled,
  onChange,
}: {
  value: string
  kind: InputKind
  disabled: boolean
  onChange: (id: string) => void
}) {
  const allowed = targetsFor(kind)
  const groups: { label: string; kind: MediaKind }[] = [
    { label: 'Image', kind: 'image' },
    { label: 'Audio', kind: 'audio' },
    { label: 'Video', kind: 'video' },
  ]
  return (
    <span className="select-wrap">
      <select
        className="format-select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Output format"
      >
        {groups.map((group) => {
          const formats = allowed.filter((format) => format.kind === group.kind)
          if (!formats.length) return null
          return (
            <optgroup key={group.kind} label={group.label}>
              {formats.map((format) => (
                <option key={format.id} value={format.id}>
                  {format.label}
                </option>
              ))}
            </optgroup>
          )
        })}
      </select>
      <ChevronIcon />
    </span>
  )
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const isLight = theme === 'light'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isLight}
      aria-label="Light theme"
      title={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
      className={`theme-switch ${isLight ? 'is-light' : 'is-dark'}`}
      onClick={onToggle}
    >
      <span className="theme-track" aria-hidden>
        <span className="theme-thumb">
          <span className="theme-glyph is-moon">
            <MoonIcon />
          </span>
          <span className="theme-glyph is-sun">
            <SunIcon />
          </span>
        </span>
      </span>
      <span className="theme-label">{isLight ? 'Light' : 'Dark'}</span>
    </button>
  )
}

function DownloadLink({ url, name }: { url: string; name: string }) {
  const [saved, setSaved] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <a
      className="btn btn-primary btn-download"
      href={url}
      download={name}
      title={`Download ${name}`}
      onClick={() => {
        setSaved(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setSaved(false), 1800)
      }}
    >
      {saved ? <CheckIcon /> : <DownloadIcon />}
      {saved ? 'Saved' : 'Download'}
    </a>
  )
}

function Thumb({ preview, kind }: { preview: QueueItem['preview']; kind: InputKind }) {
  // Track which preview has finished decoding instead of resetting state in an effect.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)

  if (!preview) {
    return (
      <div className="thumb">
        <span className="thumb-icon">{kind === 'audio' ? <WaveIcon /> : <FileIcon />}</span>
      </div>
    )
  }

  const ready = loadedUrl === preview.url
  const markReady = () => setLoadedUrl(preview.url)

  return (
    <div className={`thumb ${ready ? 'is-ready' : 'is-pending'}`}>
      {preview.type === 'image' ? (
        <img src={preview.url} alt="" loading="lazy" onLoad={markReady} onError={markReady} />
      ) : (
        <video src={preview.url} muted playsInline preload="metadata" onLoadedData={markReady} onError={markReady} />
      )}
      {!ready && <span className="thumb-skeleton skeleton" aria-hidden />}
    </div>
  )
}

function QueueSkeleton() {
  return (
    <section className="queue queue-skeleton" aria-busy="true">
      <div className="queue-head">
        <div className="queue-title">
          <span className="skeleton skeleton-title" aria-hidden />
          <span className="skeleton-caption">Preparing the conversion engine…</span>
        </div>
        <div className="queue-actions" aria-hidden>
          <span className="skeleton skeleton-btn" />
          <span className="skeleton skeleton-btn" />
        </div>
      </div>

      <div className="settings skeleton-settings" aria-hidden>
        {[0, 1, 2, 3].map((index) => (
          <div className="field" key={index}>
            <span className="skeleton skeleton-line narrow" />
            <span className="skeleton skeleton-field" />
          </div>
        ))}
      </div>

      <ul className="list" aria-hidden>
        {[0, 1].map((index) => (
          <li className="card skeleton-card" key={index}>
            <span className="skeleton skeleton-thumb" />
            <div className="card-body">
              <span className="skeleton skeleton-line wide" />
              <span className="skeleton skeleton-line narrow" />
            </div>
            <span className="skeleton skeleton-btn" />
          </li>
        ))}
      </ul>
    </section>
  )
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function SwapIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path {...stroke} d="M4 8h13l-3-3M20 16H7l3 3" />
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
      <path {...stroke} d="M12 16V4m0 0L7 9m5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path {...stroke} d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14" />
    </svg>
  )
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path {...stroke} d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path {...stroke} d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13M10 11v6m4-6v6" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
      <path {...stroke} d="m5 13 4 4 10-10" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
      <path {...stroke} d="M12 8v5m0 3v.5M10.3 4.3 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden className="arrow-icon">
      <path {...stroke} d="M5 12h13m0 0-4-4m4 4-4 4" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden className="chevron">
      <path {...stroke} d="m6 9 6 6 6-6" />
    </svg>
  )
}

function WaveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      <path {...stroke} d="M4 12h2m3-5v10m4-13v16m4-11v6m3-3h0" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      <path {...stroke} d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5" />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden>
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden>
      <path
        d="M20 14.4A8.5 8.5 0 0 1 9.6 4a8.5 8.5 0 1 0 10.4 10.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path {...stroke} d="M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3" />
    </svg>
  )
}

function ChipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path {...stroke} d="M8 4v3m8-3v3M8 17v3m8-3v3M4 8h3m-3 8h3m10-8h3m-3 8h3M8 8h8v8H8z" />
    </svg>
  )
}

function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path {...stroke} d="m12 3 9 5-9 5-9-5 9-5Zm9 9-9 5-9-5m18 4-9 5-9-5" />
    </svg>
  )
}

function InfinityIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path {...stroke} d="M7 16c2.5 0 3.5-2 5-4s2.5-4 5-4a4 4 0 0 1 0 8c-2.5 0-3.5-2-5-4s-2.5-4-5-4a4 4 0 0 0 0 8Z" />
    </svg>
  )
}
