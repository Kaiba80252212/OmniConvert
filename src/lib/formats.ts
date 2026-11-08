// The format catalogue and the FFmpeg argument builder.
// Everything here is shared by the browser app and the Node verification harness,
// so a format only ships if a real conversion of it was tested.

export type MediaKind = 'image' | 'audio' | 'video'
export type InputKind = MediaKind | 'unknown'

export interface Format {
  id: string
  label: string
  ext: string
  kind: MediaKind
  mime: string
  note: string
}

export const IMAGE_FORMATS: Format[] = [
  { id: 'jpg', label: 'JPG', ext: 'jpg', kind: 'image', mime: 'image/jpeg', note: 'Smallest · universal' },
  { id: 'png', label: 'PNG', ext: 'png', kind: 'image', mime: 'image/png', note: 'Lossless · alpha' },
  { id: 'webp', label: 'WEBP', ext: 'webp', kind: 'image', mime: 'image/webp', note: 'Modern · tiny' },
  { id: 'gif', label: 'GIF', ext: 'gif', kind: 'image', mime: 'image/gif', note: '256 colours' },
  { id: 'bmp', label: 'BMP', ext: 'bmp', kind: 'image', mime: 'image/bmp', note: 'Uncompressed' },
  { id: 'tiff', label: 'TIFF', ext: 'tiff', kind: 'image', mime: 'image/tiff', note: 'Print · archival' },
]

export const AUDIO_FORMATS: Format[] = [
  { id: 'mp3', label: 'MP3', ext: 'mp3', kind: 'audio', mime: 'audio/mpeg', note: 'Plays everywhere' },
  { id: 'wav', label: 'WAV', ext: 'wav', kind: 'audio', mime: 'audio/wav', note: 'PCM · lossless' },
  { id: 'flac', label: 'FLAC', ext: 'flac', kind: 'audio', mime: 'audio/flac', note: 'Lossless · compact' },
  { id: 'm4a', label: 'M4A', ext: 'm4a', kind: 'audio', mime: 'audio/mp4', note: 'AAC · Apple ready' },
  { id: 'ogg', label: 'OGG', ext: 'ogg', kind: 'audio', mime: 'audio/ogg', note: 'Vorbis · open' },
  { id: 'opus', label: 'OPUS', ext: 'opus', kind: 'audio', mime: 'audio/opus', note: 'Best at low bitrate' },
  { id: 'aiff', label: 'AIFF', ext: 'aiff', kind: 'audio', mime: 'audio/aiff', note: 'Apple PCM' },
]

export const VIDEO_FORMATS: Format[] = [
  { id: 'mp4', label: 'MP4', ext: 'mp4', kind: 'video', mime: 'video/mp4', note: 'H.264 + AAC' },
  { id: 'webm', label: 'WEBM', ext: 'webm', kind: 'video', mime: 'video/webm', note: 'VP9 + Opus' },
  { id: 'mkv', label: 'MKV', ext: 'mkv', kind: 'video', mime: 'video/x-matroska', note: 'H.264 · container' },
  { id: 'mov', label: 'MOV', ext: 'mov', kind: 'video', mime: 'video/quicktime', note: 'QuickTime' },
  { id: 'gif-anim', label: 'GIF', ext: 'gif', kind: 'video', mime: 'image/gif', note: 'Silent loop' },
  { id: 'avi', label: 'AVI', ext: 'avi', kind: 'video', mime: 'video/x-msvideo', note: 'Legacy players' },
]

const ALL_FORMATS = [...IMAGE_FORMATS, ...AUDIO_FORMATS, ...VIDEO_FORMATS]

export function findFormat(id: string): Format | undefined {
  return ALL_FORMATS.find((f) => f.id === id)
}

/** Formats offered for a given input kind. Video inputs can also extract audio. */
export function targetsFor(kind: InputKind): Format[] {
  switch (kind) {
    case 'image':
      return IMAGE_FORMATS
    case 'audio':
      return AUDIO_FORMATS
    case 'video':
      return [...VIDEO_FORMATS, ...AUDIO_FORMATS]
    default:
      return [...VIDEO_FORMATS, ...AUDIO_FORMATS, ...IMAGE_FORMATS]
  }
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'jfif', 'webp', 'avif', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'ico', 'svg'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'wave', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aiff', 'aif', 'wma', 'amr', 'alac', 'm4r', 'mka'])
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts', 'ogv', 'gif'])

export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx === -1 ? '' : name.slice(idx + 1).toLowerCase()
}

export function detectKind(file: File): InputKind {
  const ext = extensionOf(file.name)
  // Animated GIFs behave like video in FFmpeg, and are usually converted to MP4/WebM.
  if (ext === 'gif') return 'video'
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('video/')) return 'video'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (VIDEO_EXT.has(ext)) return 'video'
  return 'unknown'
}

/** Pick a sensible default target that is not the input's own format. */
export function defaultTarget(kind: InputKind, inputExt: string): Format {
  const preferred: Record<InputKind, string> = { image: 'jpg', audio: 'mp3', video: 'mp4', unknown: 'mp4' }
  const list = targetsFor(kind)
  const preferredFormat = list.find((f) => f.id === preferred[kind])
  if (preferredFormat && preferredFormat.ext !== inputExt) return preferredFormat
  const alt = list.find((f) => f.ext !== inputExt)
  return alt ?? list[0]
}

export interface ConvertOptions {
  /** 1-100. Mapped to image quality, video CRF or audio bitrate. */
  quality: number
  /** Cap the output height in pixels. 0 keeps the original resolution. */
  maxHeight: number
  /** Seconds to skip at the start. */
  trimStart: number
  /** Seconds to stop at. 0 means "until the end". */
  trimEnd: number
  /** Drop the audio track from video outputs. */
  mute: boolean
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  quality: 78,
  maxHeight: 0,
  trimStart: 0,
  trimEnd: 0,
  mute: false,
}

const audioBitrate = (quality: number, max = 320) => {
  const raw = 96 + (quality / 100) * 224
  return Math.min(max, Math.max(96, Math.round(raw / 16) * 16))
}

const videoCrf = (quality: number, best = 18, worst = 34) =>
  Math.round(worst - (Math.min(100, Math.max(1, quality)) / 100) * (worst - best))

const jpegQscale = (quality: number) => Math.round(31 - (Math.min(100, Math.max(1, quality)) / 100) * 29)

function scaleFilter(maxHeight: number): string {
  return maxHeight > 0 ? `scale=-2:${Math.round(maxHeight)}` : ''
}

function imageEncoderArgs(target: Format, o: ConvertOptions): string[] {
  switch (target.id) {
    case 'jpg':
      return ['-c:v', 'mjpeg', '-q:v', String(jpegQscale(o.quality)), '-pix_fmt', 'yuvj420p']
    case 'png':
      return ['-c:v', 'png', '-pred', 'mixed', '-compression_level', '7']
    case 'webp':
      return ['-c:v', 'libwebp', '-quality', String(Math.round(o.quality)), '-compression_level', '4']
    case 'gif':
      return ['-c:v', 'gif']
    case 'bmp':
      return ['-c:v', 'bmp']
    case 'tiff':
      return ['-c:v', 'tiff', '-pix_fmt', 'rgb24']
    default:
      return []
  }
}

function audioEncoderArgs(target: Format, o: ConvertOptions): string[] {
  const bitrate = `${audioBitrate(o.quality)}k`
  switch (target.id) {
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-b:a', bitrate]
    case 'wav':
      return ['-c:a', 'pcm_s16le']
    case 'flac':
      return ['-c:a', 'flac', '-compression_level', '8']
    case 'm4a':
      return ['-c:a', 'aac', '-b:a', bitrate, '-movflags', '+faststart']
    case 'ogg':
      // Vorbis rejects fixed bitrates at some sample rates, so use its VBR scale instead.
      return ['-c:a', 'libvorbis', '-q:a', String(Math.round((o.quality / 100) * 10))]
    case 'opus':
      return ['-c:a', 'libopus', '-b:a', `${audioBitrate(o.quality, 256)}k`]
    case 'aiff':
      return ['-c:a', 'pcm_s16be']
    default:
      return []
  }
}

function videoEncoderArgs(target: Format, o: ConvertOptions): string[] {
  const scale = scaleFilter(o.maxHeight)
  const filters: string[] = []
  if (scale) filters.push(scale)

  switch (target.id) {
    case 'mp4':
    case 'mkv':
    case 'mov': {
      const args = [
        ...(filters.length ? ['-vf', filters.join(',')] : []),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        String(videoCrf(o.quality)),
        '-pix_fmt',
        'yuv420p',
      ]
      if (o.mute) args.push('-an')
      else args.push('-c:a', 'aac', '-b:a', '160k')
      if (target.id !== 'mkv') args.push('-movflags', '+faststart')
      return args
    }
    case 'webm':
      return [
        ...(filters.length ? ['-vf', filters.join(',')] : []),
        '-c:v',
        'libvpx-vp9',
        '-crf',
        String(videoCrf(o.quality, 20, 45)),
        '-b:v',
        '0',
        '-deadline',
        'good',
        '-cpu-used',
        '4',
        ...(o.mute ? ['-an'] : ['-c:a', 'libopus', '-b:a', '128k']),
      ]
    case 'avi':
      return [
        ...(filters.length ? ['-vf', filters.join(',')] : []),
        '-c:v',
        'mpeg4',
        '-q:v',
        String(Math.max(2, jpegQscale(o.quality) - 1)),
        ...(o.mute ? ['-an'] : ['-c:a', 'libmp3lame', '-b:a', '160k']),
      ]
    case 'gif-anim': {
      const height = o.maxHeight > 0 ? Math.round(o.maxHeight) : 480
      return [
        '-vf',
        `fps=12,scale=-2:${height}:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`,
        '-loop',
        '0',
        '-an',
      ]
    }
    default:
      return []
  }
}

/**
 * Build the FFmpeg argument list for one conversion.
 * Input seeking (`-ss` before `-i`) keeps trims fast, and `-t` after it keeps
 * the length exact regardless of container timestamps.
 */
export function buildArgs(
  input: string,
  output: string,
  target: Format,
  o: ConvertOptions,
  inputKind: InputKind,
): string[] {
  const args: string[] = []
  const start = Math.max(0, o.trimStart || 0)
  const end = o.trimEnd > 0 ? o.trimEnd : 0
  if (start > 0) args.push('-ss', String(start))
  args.push('-i', input)
  if (end > start) args.push('-t', String(end - start))

  if (target.kind === 'image') {
    const filters = scaleFilter(o.maxHeight)
    args.push('-frames:v', '1', '-an', '-sn')
    if (filters) args.push('-vf', filters)
    args.push(...imageEncoderArgs(target, o))
  } else if (target.kind === 'audio') {
    args.push('-vn', '-sn', ...audioEncoderArgs(target, o))
  } else {
    args.push(...videoEncoderArgs(target, o))
  }

  if (inputKind === 'unknown' && target.kind === 'audio') {
    // Nothing extra: `-vn` already handles audio-only extraction.
  }

  args.push(output)
  return args
}

export function outputName(fileName: string, target: Format): string {
  const base = fileName.replace(/\.[^./\\]+$/, '') || 'converted'
  return `${base}.${target.ext}`
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}
