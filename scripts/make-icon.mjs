#!/usr/bin/env node
/**
 * Draws the app icon from the website's command mark and compiles every size.
 *
 * `resources/workbench-mark.svg` preserves the exact website glyph as an
 * outline, without depending on the current machine's font fallback. The
 * committed PNG, ICO, ICNS and tray assets all come from that one outline.
 *
 * Every size is rasterized natively instead of downscaling a 1024px master.
 * Downscaling smears a 16px icon into grey mush; drawing it at 16px keeps the
 * crossbar landing on whole pixels, which is the only reason the mark survives
 * in the dock's smallest rendering.
 *
 *   node scripts/make-icon.mjs            # write resources/icon.icns
 *   node scripts/make-icon.mjs --ico      # write resources/icon.ico
 *   node scripts/make-icon.mjs --preview  # contact sheet of every variant
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The captured outline only uses absolute M/L/C/Z commands. Flatten its cubic
 * curves once, then cache each scanline's intersections: a point-in-polygon
 * walk for every supersample would repeat the same curve work millions of
 * times. Sixteen subdivisions per cubic keep the error below a master-image
 * pixel; supersampling handles coverage at the actual output resolution.
 *
 * This deliberately rejects new SVG features instead of silently dropping
 * artwork when someone replaces the source with an unsupported export.
 */
function websiteMark() {
  const svg = fs.readFileSync(path.join(root, 'resources/workbench-mark.svg'), 'utf8')
  const source = svg.match(/<path d="([^"]+)"/)?.[1]
  if (!source || /[a-z]/i.test(source.replace(/[MLCZ]/gi, ''))) throw new Error('Unsupported mark outline')
  const tokens = source.match(/[MLCZ]|-?\d+(?:\.\d+)?/gi)
  const contours = []
  let contour, point, command
  let i = 0
  const pair = () => [Number(tokens[i++]), Number(tokens[i++])]
  while (i < tokens.length) {
    if (/^[MLCZ]$/i.test(tokens[i])) command = tokens[i++]
    if (command === 'M') {
      point = pair()
      contour = [point]
      contours.push(contour)
      command = 'L'
    } else if (command === 'L') {
      point = pair()
      contour.push(point)
    } else if (command === 'C') {
      const from = point, a = pair(), b = pair(), end = pair()
      for (let step = 1; step <= 16; step++) {
        const t = step / 16, u = 1 - t
        contour.push([0, 1].map((axis) => u ** 3 * from[axis] + 3 * u * u * t * a[axis] + 3 * u * t * t * b[axis] + t ** 3 * end[axis]))
      }
      point = end
    } else if (command === 'z' || command === 'Z') {
      command = null
    } else throw new Error('Unsupported mark command')
  }
  const lines = new Map()
  return (x, y) => {
    // The website glyph occupies 600 units in the padded 1024-unit app tile.
    if (x < 212 || x > 812 || y < 212 || y > 812) return false
    let cuts = lines.get(y)
    if (!cuts) {
      const gy = (y - 212) * 595 / 600 - 659
      cuts = []
      for (const points of contours) {
        for (let j = 0; j < points.length; j++) {
          const a = points[j], b = points[(j + 1) % points.length]
          if ((a[1] > gy) !== (b[1] > gy)) {
            const gx = a[0] + (gy - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            cuts.push((gx - 115) * 600 / 595 + 212)
          }
        }
      }
      cuts.sort((a, b) => a - b)
      lines.set(y, cuts)
    }
    for (let j = 0; j < cuts.length; j += 2) if (x >= cuts[j] && x < cuts[j + 1]) return true
    return false
  }
}
const inWebsiteMark = websiteMark()

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** Encodes straight (non-premultiplied) 8-bit RGBA pixels as a PNG. */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none — the shapes are flat, so filtering buys nothing
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// Geometry, in a 1024-unit design space
// ---------------------------------------------------------------------------

/**
 * Apple's macOS icon grid: the artwork is an 824pt rounded square centred in a
 * 1024pt canvas. The padding is not optional decoration — it is what makes the
 * icon sit at the same visual weight as its neighbours in the dock. Filling the
 * full canvas would make Workbench look permanently one size too big.
 */
const TILE = { center: 512, half: 412 }

/** Superellipse exponent. ~5 is the usual approximation of Apple's squircle. */
const SQUIRCLE_N = 5

/**
 * The mark: `W_` — a W with a prompt caret parked after it, the way it looks
 * once you have typed the first letter at a shell.
 *
 * Every stroke is a capsule, a segment swept by a circle. A W built from
 * rectangles needs its diagonals mitred at the valleys or they cross into a
 * lump; sweeping a circle along the centreline makes the joins for free, and
 * the caret reusing the same radius is what keeps the two halves of the mark
 * reading as one alphabet rather than a letter next to a bar.
 *
 * The weight is fixed by the 16px rendering at both ends: much thinner and the
 * four strokes grey out into a smudge, much thicker and the valleys close up
 * into a solid block.
 */
const STROKE = 38

/** Centreline vertices — down to a valley and back up, twice. */
const W_VERTS = [
  [188, 352],
  [297, 664],
  [380, 448],
  [463, 664],
  [572, 352]
]

/**
 * The caret rests on the valleys' baseline, a stroke's width clear of the W.
 *
 * It is wide — wider than the gap that precedes it — because a short one reads
 * as a hyphen dropped in the corner rather than a cursor waiting at the end of
 * the word, and because it is the first thing to dissolve at 16px.
 */
const CARET = { x0: 686, y0: 664, x1: 836, y1: 664 }

/** The same W with nothing after it, shifted back to stand on its own centre. */
const SOLID_W_VERTS = W_VERTS.map(([x, y]) => [x + 132, y])

/** Consecutive vertices, as the segments between them. */
function strokesOf(verts) {
  return verts.slice(1).map(([x1, y1], i) => ({ x0: verts[i][0], y0: verts[i][1], x1, y1 }))
}

const W_STROKES = strokesOf(W_VERTS)
const SOLID_W_STROKES = strokesOf(SOLID_W_VERTS)

function inSquircle(x, y, half) {
  const dx = Math.abs(x - TILE.center) / half
  const dy = Math.abs(y - TILE.center) / half
  return Math.pow(dx, SQUIRCLE_N) + Math.pow(dy, SQUIRCLE_N) <= 1
}

/** A segment thickened into a round-capped stroke: distance to it, clamped. */
function inCapsule(x, y, seg, r) {
  const dx = seg.x1 - seg.x0
  const dy = seg.y1 - seg.y0
  const len2 = dx * dx + dy * dy
  const along = len2 === 0 ? 0 : ((x - seg.x0) * dx + (y - seg.y0) * dy) / len2
  const t = Math.min(Math.max(along, 0), 1)
  const ox = x - (seg.x0 + t * dx)
  const oy = y - (seg.y0 + t * dy)
  return ox * ox + oy * oy <= r * r
}

function inStrokes(x, y, segs, r) {
  return segs.some((seg) => inCapsule(x, y, seg, r))
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

const INK = [0xf2, 0xf2, 0xf4]
const CLAUDE = [0xd9, 0x77, 0x57] // --agent-claude
const CODEX = [0x10, 0xa3, 0x7f] // --agent-codex

/**
 * The tile is near-black with a gentle top-down lift. A flat fill looks dead
 * next to macOS's own icons, which are all lit from above; a strong gradient
 * looks like 2013. This is about as far as it can go and stay quiet.
 */
const DARK_TILE = { top: [0x27, 0x27, 0x2b], bottom: [0x0d, 0x0d, 0x0f] }
const LIGHT_TILE = { top: [0xfa, 0xfa, 0xfb], bottom: [0xe2, 0xe2, 0xe6] }

/** Where the caret is cut in two, for the variant that splits it by agent. */
const CARET_MID = (CARET.x0 + CARET.x1) / 2

/** `parts` are drawn in order; each returns whether the point is inside it. */
const VARIANTS = {
  website: {
    label: 'Website — command mark',
    tile: { top: [250, 250, 250], bottom: [250, 250, 250] },
    parts: [{ color: [22, 22, 22], hit: inWebsiteMark }],
  },
  solid: {
    label: 'A — solid W',
    parts: [{ color: INK, hit: (x, y) => inStrokes(x, y, SOLID_W_STROKES, STROKE) }],
  },
  prompt: {
    label: 'F — W_ at a prompt',
    parts: [
      { color: INK, hit: (x, y) => inStrokes(x, y, W_STROKES, STROKE) },
      { color: INK, hit: (x, y) => inCapsule(x, y, CARET, STROKE) },
    ],
  },
  promptAccent: {
    label: 'G — W_ with lit caret',
    parts: [
      { color: INK, hit: (x, y) => inStrokes(x, y, W_STROKES, STROKE) },
      { color: CLAUDE, hit: (x, y) => inCapsule(x, y, CARET, STROKE) },
    ],
  },
  invert: {
    label: 'H — W_ inverted',
    tile: LIGHT_TILE,
    parts: [
      { color: [0x16, 0x16, 0x18], hit: (x, y) => inStrokes(x, y, W_STROKES, STROKE) },
      { color: [0x16, 0x16, 0x18], hit: (x, y) => inCapsule(x, y, CARET, STROKE) },
    ],
  },
  duo: {
    label: 'D — W_ split between the two agents',
    parts: [
      { color: INK, hit: (x, y) => inStrokes(x, y, W_STROKES, STROKE) },
      { color: CLAUDE, hit: (x, y) => inCapsule(x, y, CARET, STROKE) && x < CARET_MID },
      { color: CODEX, hit: (x, y) => inCapsule(x, y, CARET, STROKE) && x >= CARET_MID },
    ],
  },
}

function tileColor(y, variant) {
  const { top, bottom } = variant.tile ?? DARK_TILE
  const t = Math.min(Math.max((y - (TILE.center - TILE.half)) / (TILE.half * 2), 0), 1)
  return [0, 1, 2].map((i) => top[i] + (bottom[i] - top[i]) * t)
}

// ---------------------------------------------------------------------------
// Rasterizer
// ---------------------------------------------------------------------------

/** Supersampling factor per axis. 4 is enough for shapes this geometric. */
const SS = 4

function render(size, variant) {
  const scale = 1024 / size
  const rgba = Buffer.alloc(size * size * 4)
  // The rim highlight is the difference between the tile and a slightly inset
  // copy of it, so it hugs the curve instead of being a straight line.
  const inset = TILE.half - 3

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0
      let rim = 0
      const cover = new Array(variant.parts.length).fill(0)

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale
          const y = (py + (sy + 0.5) / SS) * scale
          if (!inSquircle(x, y, TILE.half)) continue
          tile++
          if (!inSquircle(x, y, inset)) rim++
          for (let i = variant.parts.length - 1; i >= 0; i--) {
            if (variant.parts[i].hit(x, y)) {
              cover[i]++
              break // topmost part wins, so overlaps never double-composite
            }
          }
        }
      }

      const total = SS * SS
      const i = (py * size + px) * 4
      if (tile === 0) continue

      const y = (py + 0.5) * scale
      let [r, g, b] = tileColor(y, variant)

      // Light only the upper rim: a full outline reads as a border, an upper
      // arc reads as a lit edge.
      const lit = (rim / total) * Math.max(0, 1 - (y - (TILE.center - TILE.half)) / 260)
      r += (255 - r) * lit * 0.28
      g += (255 - g) * lit * 0.28
      b += (255 - b) * lit * 0.28

      for (let p = 0; p < variant.parts.length; p++) {
        const a = cover[p] / total
        if (a === 0) continue
        const c = variant.parts[p].color
        r += (c[0] - r) * a
        g += (c[1] - g) * a
        b += (c[2] - b) * a
      }

      rgba[i] = Math.round(r)
      rgba[i + 1] = Math.round(g)
      rgba[i + 2] = Math.round(b)
      rgba[i + 3] = Math.round((tile / total) * 255)
    }
  }
  return rgba
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** Modern ICNS image types, including Retina representations, all PNG encoded. */
const ICONSET = [
  [16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'],
  [256, 'ic08'], [512, 'ic09'], [1024, 'ic10'],
  [32, 'ic11'], [64, 'ic12'], [256, 'ic13'], [512, 'ic14'],
]

function writeIcns(variantName) {
  const variant = VARIANTS[variantName]
  const resources = path.join(root, 'resources')
  const images = new Map()
  const entries = ICONSET.map(([size, type]) => {
    if (!images.has(size)) images.set(size, encodePng(size, size, render(size, variant)))
    const png = images.get(size)
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  })
  // The 1024px master doubles as the Linux/Windows source and as the dock icon
  // in dev, where the .icns is never consulted.
  fs.writeFileSync(path.join(resources, 'icon.png'), images.get(1024))
  // ICNS is a length-prefixed collection. Writing its PNG representations
  // directly lets Windows/Linux maintain the Mac icon too, without iconutil
  // or an added dependency. Electron's supported macOS versions read these.
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(8 + entries.reduce((sum, entry) => sum + entry.length, 0), 4)
  fs.writeFileSync(path.join(resources, 'icon.icns'), Buffer.concat([header, ...entries]))
  writeTrayIcons(resources)
  return path.join(resources, 'icon.icns')
}

/** Alpha-only template artwork, drawn from the same outline at menu-bar sizes. */
function writeTrayIcons(resources) {
  for (const size of [16, 32]) {
    const pixels = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let coverage = 0
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const gx = 512 + ((x + (sx + 0.5) / SS) / size - 0.5) * 1024 * 600 / 896
            const gy = 512 + ((y + (sy + 0.5) / SS) / size - 0.5) * 1024 * 600 / 896
            if (inWebsiteMark(gx, gy)) coverage++
          }
        }
        pixels[(y * size + x) * 4 + 3] = Math.round(coverage / (SS * SS) * 255)
      }
    }
    fs.writeFileSync(path.join(resources, `tray-${size}.png`), encodePng(size, size, pixels))
  }
}

/**
 * The sizes Windows actually asks for, largest first.
 *
 * Windows picks an entry by size and scales whatever it finds, so a missing
 * size is not a missing icon — it is a smeared one. 24 and 48 look redundant
 * next to 16 and 32 but are exactly what the taskbar and the Alt-Tab switcher
 * reach for at 150% and 200% scaling, which is most machines.
 */
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]

/**
 * One ICO image, in the only encoding every consumer agrees on.
 *
 * Vista and later accept a PNG inside an ICO, and it would be a tenth of the
 * bytes — but NSIS reads the installer icon itself, with its own parser, and
 * rejects PNG-compressed entries. So each image is a bottom-up 32-bit DIB,
 * which is the 1997 spelling and the one nothing refuses.
 *
 * The header claims double the real height: an ICO's DIB is defined as the
 * colour image stacked on top of a 1-bit AND mask. The mask is obsolete for
 * 32-bit images — alpha already says what is transparent — but the field is
 * still read, so the rows are written as zeros rather than omitted.
 */
function encodeDib(size, rgba) {
  const rowMask = Math.ceil(size / 32) * 4 // 1bpp, rows padded to 4 bytes
  const xor = size * size * 4
  const buf = Buffer.alloc(40 + xor + rowMask * size)
  buf.writeUInt32LE(40, 0) // header size
  buf.writeInt32LE(size, 4)
  buf.writeInt32LE(size * 2, 8) // colour rows + mask rows
  buf.writeUInt16LE(1, 12) // planes
  buf.writeUInt16LE(32, 14) // bits per pixel
  buf.writeUInt32LE(xor + rowMask * size, 20) // image size
  for (let y = 0; y < size; y++) {
    // Bottom-up: the last source row is the first row on disk.
    const src = (size - 1 - y) * size * 4
    const dst = 40 + y * size * 4
    for (let x = 0; x < size; x++) {
      buf[dst + x * 4] = rgba[src + x * 4 + 2] // B
      buf[dst + x * 4 + 1] = rgba[src + x * 4 + 1] // G
      buf[dst + x * 4 + 2] = rgba[src + x * 4] // R
      buf[dst + x * 4 + 3] = rgba[src + x * 4 + 3] // A
    }
  }
  return buf
}

/**
 * `resources/icon.ico` — the window icon, the taskbar icon, the icon NSIS
 * stamps onto the installer, and the one electron-builder needs a real file
 * for. It could be derived from `icon.png` by electron-builder itself, but
 * that downscales the 1024px master into every size, and downscaling is what
 * this script exists to avoid: 16px is drawn at 16px so the crossbar lands on
 * whole pixels.
 *
 * Like the ICNS writer, this uses only Node's built-ins on every platform.
 */
function writeIco(variantName) {
  const variant = VARIANTS[variantName]
  const images = ICO_SIZES.map((size) => encodeDib(size, render(size, variant)))

  const dir = Buffer.alloc(6 + images.length * 16)
  dir.writeUInt16LE(1, 2) // type: icon
  dir.writeUInt16LE(images.length, 4)
  let offset = dir.length
  images.forEach((img, i) => {
    const at = 6 + i * 16
    const size = ICO_SIZES[i]
    // 256 does not fit in a byte and is spelled 0. Every reader knows this.
    dir[at] = size === 256 ? 0 : size
    dir[at + 1] = size === 256 ? 0 : size
    dir.writeUInt16LE(1, at + 4) // planes
    dir.writeUInt16LE(32, at + 6) // bits per pixel
    dir.writeUInt32LE(img.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += img.length
  })

  const out = path.join(root, 'resources', 'icon.ico')
  fs.writeFileSync(out, Buffer.concat([dir, ...images]))
  return out
}

/** Contact sheet: every variant at a readable size plus the sizes it must survive. */
function writePreview(out) {
  const names = Object.keys(VARIANTS)
  const big = 224
  const smalls = [128, 64, 32, 16]
  const pad = 24
  const rowH = big + pad
  const width = pad + big + pad + smalls.reduce((a, s) => a + s + pad, 0) + 120
  const height = pad + names.length * rowH

  const sheet = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    // Mid grey, so both the dark tile and the light mark are judged fairly.
    sheet[i * 4] = 0x8a
    sheet[i * 4 + 1] = 0x8a
    sheet[i * 4 + 2] = 0x8e
    sheet[i * 4 + 3] = 0xff
  }

  const blit = (src, size, dx, dy) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = (y * size + x) * 4
        const a = src[s + 3] / 255
        if (a === 0) continue
        const d = ((dy + y) * width + dx + x) * 4
        for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(sheet[d + c] * (1 - a) + src[s + c] * a)
      }
    }
  }

  names.forEach((name, row) => {
    const variant = VARIANTS[name]
    const top = pad + row * rowH
    blit(render(big, variant), big, pad, top)
    let x = pad + big + pad
    for (const s of smalls) {
      blit(render(s, variant), s, x, top + big - s) // baseline-aligned, like a dock
      x += s + pad
    }
  })

  fs.writeFileSync(out, encodePng(width, height, sheet))
  return { out, order: names.map((n) => VARIANTS[n].label) }
}

const arg = process.argv[2]
if (arg === '--ico') {
  const variant = process.argv[3] ?? 'website'
  if (!VARIANTS[variant]) {
    console.error(`unknown variant "${variant}" — one of: ${Object.keys(VARIANTS).join(', ')}`)
    process.exit(1)
  }
  console.log(writeIco(variant))
} else if (arg === '--preview') {
  const target = process.argv[3] ?? path.join(root, 'icon-preview.png')
  const { out, order } = writePreview(target)
  console.log(`${out}\n${order.join('\n')}`)
} else {
  const variant = arg ?? 'website'
  if (!VARIANTS[variant]) {
    console.error(`unknown variant "${variant}" — one of: ${Object.keys(VARIANTS).join(', ')}`)
    process.exit(1)
  }
  console.log(writeIcns(variant))
}
