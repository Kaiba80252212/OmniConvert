// Boots the browser FFmpeg core in Node with the browser APIs it expects,
// so conversions can be verified headlessly. Each instance is isolated: a wasm
// crash in one conversion cannot poison the next.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = path.resolve('node_modules/@ffmpeg/core/dist/esm')
const corePath = path.join(dir, 'ffmpeg-core.js')
const coreURL = pathToFileURL(corePath).href
const wasmURL = pathToFileURL(path.join(dir, 'ffmpeg-core.wasm')).href

const toPath = (url) => decodeURIComponent(String(url).replace(/^file:\/\//, '').split('#')[0])

globalThis.self = globalThis
globalThis.self.location = { href: coreURL }
globalThis.fetch = async (url) => {
  const p = toPath(url)
  const buf = fs.readFileSync(p)
  return new Response(buf, {
    status: 200,
    headers: { 'content-type': p.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' },
  })
}
class XHR {
  responseType = ''
  status = 0
  open(_m, url) {
    this.url = url
  }
  send() {
    const buf = fs.readFileSync(toPath(this.url))
    this.status = 200
    if (this.responseType === 'arraybuffer') {
      this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    } else {
      this.responseText = buf.toString('utf8')
    }
  }
}
globalThis.XMLHttpRequest = XHR

const createCore = (await import(coreURL)).default
const payload = Buffer.from(JSON.stringify({ wasmURL, workerURL: wasmURL })).toString('base64')

export async function createInstance() {
  const core = await createCore({ mainScriptUrlOrBlob: `${coreURL}#${payload}` })
  let log = []
  core.setLogger(({ message }) => log.push(message))
  core.setProgress(() => {})
  return {
    core,
    exec(...args) {
      log = []
      core.reset()
      const ret = core.exec(...args)
      return { ret, log: [...log] }
    },
    writeFile(p, data) {
      core.FS.writeFile(p, data)
    },
    readFile(p) {
      return core.FS.readFile(p)
    },
    unlink(p) {
      try {
        core.FS.unlink(p)
      } catch {}
    },
    mkdir(p) {
      try {
        core.FS.mkdir(p)
      } catch {}
    },
  }
}
