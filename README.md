# OmniConvert

A media converter that runs entirely in the browser. Drop images, audio or video, pick an output format per file, and download the result — no uploads, no accounts, no watermark.

A full FFmpeg build (5.1.4, compiled to WebAssembly) does the conversion inside the tab, so files never leave the device.

## Output formats

| Media | Formats |
| --- | --- |
| Image | JPG · PNG · WEBP · GIF · BMP · TIFF |
| Audio | MP3 · WAV · FLAC · M4A (AAC) · OGG (Vorbis) · OPUS · AIFF |
| Video | MP4 (H.264/AAC) · WEBM (VP9/Opus) · MKV · MOV · GIF · AVI |

Video inputs can also be converted to any audio format (audio extraction) or to an image format (first frame). Animation GIFs are treated as video, so they can become MP4 or WebM.

The input side is whatever this FFmpeg build can decode. Note that HEIC/HEIF, AVIF and SVG are **not** decoded by it.

## Features

- **Monochrome glass UI** — translucent blurred panels with no gradients or accent colours, and an animated dark/light switch that follows the system preference and remembers the choice.
- **Batch queue** — add many files, choose a format per file, convert them all in one run.
- **Quality, resolution, trim, mute** — one quality slider that maps to image quality, video CRF or audio bitrate, plus downscaling, trimming and audio stripping.
- **Live progress** per file, size before/after with the saving, individual and batch downloads.
- **Skeleton loading states** — pulsing placeholders while the wasm engine boots and while thumbnails decode.
- **Recent downloads** — the last six finished files stay downloadable from a history list even after their queue cards are cleared. History lives in the tab's memory, so it empties on reload.
- **Private by construction** — your files never leave the device. The only network calls are the page itself and the pinned FFmpeg engine files fetched from a CDN on first use.
- **Recovers from engine crashes** — if the wasm engine aborts, the next conversion starts a fresh one.

## Development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # typecheck + production build
npm run lint
```

The FFmpeg engine is loaded at runtime from a pinned unpkg.com release (`@ffmpeg/core@0.12.10` / `@ffmpeg/ffmpeg@0.12.15`, see `src/lib/engine.ts`) because the ~31 MB wasm core exceeds Workers' per-asset size limit and cannot ship as a static asset. Keep the pinned versions there in sync with `package.json`.

## Verifying conversions

`src/lib/formats.ts` holds the format catalogue and the FFmpeg argument builder. Both the app and the test harness use it, so a format only ships if a real conversion of it was tested:

```bash
npm run test:formats          # runs every offered conversion
npm run test:formats -- ogg   # filters by label
```

The harness boots the same wasm core in Node with browser shims (`scripts/ffmpeg-node.mjs`), builds sample media, runs each conversion and checks that non-empty output was produced.

## Limits

- The first conversion downloads about 32 MB of engine (from the pinned CDN) into the tab.
- File size is bounded by device memory, not by a server quota. Very long videos can exhaust the wasm heap.
- Conversion is single-threaded: it does not use `SharedArrayBuffer`, so the app needs no COOP/COEP headers and works on any static host.
