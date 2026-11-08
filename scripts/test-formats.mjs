// Real-conversion test harness: builds tiny sample media, then runs every format
// the UI offers through the argument builder in src/lib/formats.ts.
import zlib from 'node:zlib'
import { createInstance } from './ffmpeg-node.mjs'
import {
  AUDIO_FORMATS,
  IMAGE_FORMATS,
  VIDEO_FORMATS,
  DEFAULT_OPTIONS,
  buildArgs,
} from '../src/lib/formats.ts'

const TMP = '/tmp/fmt'
const only = process.argv[2]

// ---------- sample PNG (96x64 gradient) ----------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1)
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = Math.round((x / w) * 255)
      raw[row + 2 + x * 3] = Math.round((y / h) * 255)
      raw[row + 3 + x * 3] = 180
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- sample WAV (1s, 32kHz mono 16-bit sine) ----------
function makeWav(seconds = 1, rate = 32000) {
  const frames = seconds * rate
  const data = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const PNG = new Uint8Array(makePng(96, 64))
const WAV = new Uint8Array(makeWav())

const opt = (patch = {}) => ({ ...DEFAULT_OPTIONS, ...patch })

// Each attempt gets its own instance, sample files and empty working directory.
async function attempt(label, args, output, seedClip) {
  if (only && !label.toLowerCase().includes(only.toLowerCase())) return null
  const ff = await createInstance()
  ff.mkdir(TMP)
  ff.writeFile(`${TMP}/source.png`, PNG)
  ff.writeFile(`${TMP}/tone.wav`, WAV)
  if (seedClip) {
    const seeded = ff.exec(
      '-framerate',
      '10',
      '-i',
      `${TMP}/source.png`,
      '-i',
      `${TMP}/tone.wav`,
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      `${TMP}/clip.mp4`,
    )
    if (seeded.ret !== 0) return { label, ok: false, size: 0, log: `seed failed: ${seeded.log.slice(-3).join(' | ')}` }
  }
  let ret = -1
  let log = []
  try {
    const res = ff.exec(...args)
    ret = res.ret
    log = res.log
  } catch (err) {
    return { label, ok: false, size: 0, log: `crash: ${err.message}` }
  }
  let size = 0
  try {
    size = ff.readFile(output).length
  } catch {
    size = 0
  }
  return {
    label,
    ok: ret === 0 && size > 0,
    size,
    log: log.slice(-4).join(' | '),
  }
}

const results = []
const run = async (...a) => {
  const r = await attempt(...a)
  if (!r) return
  results.push(r)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(26)} ${String(r.size).padStart(7)} B${r.ok ? '' : `   ${r.log}`}`)
}

for (const target of IMAGE_FORMATS) {
  await run(`png → ${target.label}`, buildArgs(`${TMP}/source.png`, `${TMP}/out.${target.ext}`, target, opt(), 'image'), `${TMP}/out.${target.ext}`)
}
await run(
  'png → JPG @ 32px',
  buildArgs(`${TMP}/source.png`, `${TMP}/cap.jpg`, IMAGE_FORMATS[0], opt({ maxHeight: 32 }), 'image'),
  `${TMP}/cap.jpg`,
)

for (const target of AUDIO_FORMATS) {
  await run(`wav → ${target.label}`, buildArgs(`${TMP}/tone.wav`, `${TMP}/out.${target.ext}`, target, opt(), 'audio'), `${TMP}/out.${target.ext}`)
}
await run(
  'wav → MP3 trimmed',
  buildArgs(`${TMP}/tone.wav`, `${TMP}/trim.mp3`, AUDIO_FORMATS[0], opt({ trimStart: 0.2, trimEnd: 0.5 }), 'audio'),
  `${TMP}/trim.mp3`,
)

for (const target of VIDEO_FORMATS) {
  await run(
    `mp4 → ${target.label}`,
    buildArgs(`${TMP}/clip.mp4`, `${TMP}/out.${target.ext}`, target, opt(), 'video'),
    `${TMP}/out.${target.ext}`,
    true,
  )
}
for (const target of [AUDIO_FORMATS[0], AUDIO_FORMATS[1]]) {
  await run(
    `mp4 → ${target.label} (extract)`,
    buildArgs(`${TMP}/clip.mp4`, `${TMP}/audio.${target.ext}`, target, opt(), 'video'),
    `${TMP}/audio.${target.ext}`,
    true,
  )
}
await run(
  'mp4 → PNG frame',
  buildArgs(`${TMP}/clip.mp4`, `${TMP}/frame.png`, IMAGE_FORMATS[1], opt(), 'video'),
  `${TMP}/frame.png`,
  true,
)
await run(
  'mp4 → MP4 muted @48px',
  buildArgs(`${TMP}/clip.mp4`, `${TMP}/mute.mp4`, VIDEO_FORMATS[0], opt({ mute: true, maxHeight: 48 }), 'video'),
  `${TMP}/mute.mp4`,
  true,
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} conversions produced output`)
process.exit(failed.length ? 1 : 0)
