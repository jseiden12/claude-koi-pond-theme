import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeSetArgs, Timer } from 'claude-code'

import type { Mood, Phase, Pond, TimeSetting, View } from '../types'
import { makeColors } from './make-colors.js'

// ─── Palette: deep moonlit water, koi-orange accent, jade, gold, lavender ───
const { theme, problems } = makeColors({
  label: 'Koi Moon Pond',
  only: 'dark',
  roles: {
    accent: '#f2833a', // koi orange
    danger: '#e5484d', // red koi patch
    success: '#4fc59a', // jade lily pad
    warning: '#f0c04a', // ogon gold
    pro: '#a98ef0', // moonlit lavender
  },
  dark: {
    gray: {
      anchors: {
        'surface-0': '#08111e',
        'surface-1': '#0c1726',
        'surface-2': '#101d2f',
        'surface-3': '#132236',
        'text-primary': '#e9f0f8',
        'text-secondary': '#bccad9',
        'text-muted': '#8d9fb5',
      },
    },
    git: { added: '#4fc59a', removed: '#e5484d', modified: '#f0c04a', merged: '#a98ef0' },
  },
})

// Pixel art on a 320×200 grid. Motion is SMIL, never CSS, and the SVG holds no
// <style>, @media or shape-rendering: the desktop app freezes any scene that has
// one (anthropics/claude-code#109770, #110262).
//
// The scene is rebuilt whenever the fisherman's mood or the view changes. Every
// looping animation starts at (wall clock mod its period), so a rebuild picks
// each loop up where it was instead of snapping it back to the start.

const W = 320
const H = 200
// where the chat column sits on a maximised window, in scene pixels
const CHAT_LEFT = 116
const CHAT_RIGHT = 250

// ─── build clock and deterministic randomness ───
let NOW = 0 // wall-clock seconds at this build
let SINCE = 0 // seconds since the current mood began
let seed = 11
const reseed = (n: number): void => {
  seed = n
}
const rnd = (): number => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const ri = (a: number, b: number): number => Math.floor(a + rnd() * (b - a + 1))
const s2 = (n: number): string => n.toFixed(2)

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const bayer = (x: number, y: number): number => (BAYER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16

// ─── SMIL helpers ───
const loopBegin = (dur: number, phase: number): string => `${s2(-((Math.abs(phase) + NOW) % dur))}s`
const kt = (keyTimes?: string): string => (keyTimes ? ` keyTimes="${keyTimes}"` : '')
const anim = (attr: string, values: string, dur: number, phase: number, keyTimes?: string): string =>
  `<animate attributeName="${attr}" values="${values}" dur="${s2(dur)}s" begin="${loopBegin(dur, phase)}" repeatCount="indefinite" calcMode="discrete"${kt(keyTimes)}/>`
const moveD = (values: string, dur: number, phase: number, keyTimes?: string): string =>
  `<animateTransform attributeName="transform" type="translate" values="${values}" dur="${s2(dur)}s" begin="${loopBegin(dur, phase)}" repeatCount="indefinite" calcMode="discrete"${kt(keyTimes)}/>`
const scaleD = (values: string, dur: number, phase: number, keyTimes?: string): string =>
  `<animateTransform attributeName="transform" type="scale" values="${values}" dur="${s2(dur)}s" begin="${loopBegin(dur, phase)}" repeatCount="indefinite" calcMode="discrete"${kt(keyTimes)}/>`
const moveL = (from: string, to: string, dur: number, phase: number): string =>
  `<animateTransform attributeName="transform" type="translate" from="${from}" to="${to}" dur="${s2(dur)}s" begin="${loopBegin(dur, phase)}" repeatCount="indefinite"/>`
// one-shots run from the moment the mood began, and hold their last frame
const shot = (attr: string, values: string, dur: number, keyTimes: string): string =>
  `<animate attributeName="${attr}" values="${values}" dur="${s2(dur)}s" begin="${s2(-SINCE)}s" fill="freeze" calcMode="discrete" keyTimes="${keyTimes}"/>`
const shotAt = (delay: number, attr: string, values: string, dur: number, keyTimes: string): string =>
  `<animate attributeName="${attr}" values="${values}" dur="${s2(dur)}s" begin="${s2(delay - SINCE)}s" fill="freeze" calcMode="discrete" keyTimes="${keyTimes}"/>`
const shotMoveAt = (delay: number, values: string, dur: number, keyTimes: string): string =>
  `<animateTransform attributeName="transform" type="translate" values="${values}" dur="${s2(dur)}s" begin="${s2(delay - SINCE)}s" fill="freeze" calcMode="discrete" keyTimes="${keyTimes}"/>`
const even = (n: number): string => Array.from({ length: n }, (_, i) => s2(i / n)).join(';')
const shotMove = (values: string, dur: number, keyTimes: string): string =>
  `<animateTransform attributeName="transform" type="translate" values="${values}" dur="${s2(dur)}s" begin="${s2(-SINCE)}s" fill="freeze" calcMode="discrete" keyTimes="${keyTimes}"/>`

// ─── a pixel canvas: collects runs per colour, writes one <path> per colour ───
class Px {
  private m = new Map<string, string[]>()
  private dots = new Map<string, Set<number>>()
  // single pixels; svg() merges each column's neighbours into one stroke
  dot(x: number, y: number, c: string): void {
    const set = this.dots.get(c) ?? new Set<number>()
    set.add(x * 4096 + y)
    this.dots.set(c, set)
  }
  rect(x: number, y: number, w: number, h: number, c: string): void {
    const list = this.m.get(c) ?? []
    list.push(`M${x} ${y}h${w}v${h}h${-w}z`)
    this.m.set(c, list)
  }
  row(y: number, cells: Array<string | undefined>, x0: number, h = 1, cw = 1): void {
    let start = 0
    for (let x = 1; x <= cells.length; x++) {
      if (x === cells.length || cells[x] !== cells[start]) {
        const c = cells[start]
        if (c !== undefined) this.rect(x0 + start * cw, y, (x - start) * cw, h, c)
        start = x
      }
    }
  }
  // a one-pixel line, Bresenham
  line(x0: number, y0: number, x1: number, y1: number, c: string): void {
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      this.dot(x0, y0, c)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        x0 += sx
      }
      if (e2 <= dx) {
        err += dx
        y0 += sy
      }
    }
  }
  poly(points: Array<readonly [number, number]>, c: string): void {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!
      const b = points[i]!
      this.line(a[0], a[1], b[0], b[1], c)
    }
  }
  svg(): string {
    for (const [c, set] of this.dots) {
      const keys = [...set].sort((a, b) => a - b)
      let i = 0
      while (i < keys.length) {
        const k = keys[i]!
        let j = i
        while (j + 1 < keys.length && keys[j + 1] === keys[j]! + 1 && Math.floor(keys[j + 1]! / 4096) === Math.floor(k / 4096)) j++
        this.rect(Math.floor(k / 4096), k % 4096, 1, j - i + 1, c)
        i = j + 1
      }
    }
    this.dots.clear()
    return [...this.m]
      .map(([c, d]) => {
        const [fill, op] = c.split('/')
        return `<path fill="${fill}"${op ? ` fill-opacity="${op}"` : ''} d="${d.join('')}"/>`
      })
      .join('')
  }
}

const sprite = (rows: string[], colors: Record<string, string>): string => {
  const px = new Px()
  rows.forEach((r, y) => px.row(y, [...r].map(ch => colors[ch]), 0))
  return px.svg()
}
const at = (x: number, y: number, body: string): string => `<g transform="translate(${x} ${y})">${body}</g>`

// a dithered glow, in 2px blocks
const glow = (cx: number, cy: number, R: number, color: string, strength: number): string => {
  const px = new Px()
  for (let y = cy - R; y <= cy + R; y += 2) {
    const cells: Array<string | undefined> = []
    for (let x = cx - R; x <= cx + R; x += 2) {
      const t = 1 - Math.hypot(x + 1 - cx, y + 1 - cy) / R
      cells.push(t > 0 && bayer(x >> 1, y >> 1) < t * t * strength ? color : undefined)
    }
    px.row(y, cells, cx - R, 2, 2)
  }
  return px.svg()
}

// a shaded moon disc with a dithered halo
const moonDisc = (mx: number, my: number, r: number): string => {
  const halo = new Px()
  const disc = new Px()
  for (let y = my - 30; y <= my + 30; y += 2) {
    const cells: Array<string | undefined> = []
    for (let x = mx - 34; x <= mx + 34; x += 2) {
      const d = Math.hypot(x + 1 - mx, y + 1 - my)
      const t = 1 - (d - r) / 22
      cells.push(d >= r - 1 && t > 0 && bayer(x >> 1, y >> 1) < t * t * 0.7 ? (t > 0.6 ? '#9fbde6/0.4' : '#6f93c4/0.28') : undefined)
    }
    halo.row(y, cells, mx - 34, 2, 2)
  }
  for (let y = my - r; y <= my + r; y++) {
    const cells: Array<string | undefined> = []
    for (let x = mx - r; x <= mx + r; x++) {
      const d = Math.hypot(x + 0.5 - mx, y + 0.5 - my)
      const k = x - mx + (y - my)
      cells.push(d >= r ? undefined : k > r * 0.55 ? '#c6d8f2' : d < r - 1 && k < -r * 0.6 ? '#ffffff' : '#e6eefc')
    }
    disc.row(y, cells, mx - r)
  }
  const craters = new Px()
  for (const [cx, cy, w, h] of [[-4, -3, 3, 2], [3, 2, 2, 2], [1, -6, 2, 1], [-2, 4, 2, 1]] as const)
    craters.rect(mx + cx, my + cy, w, h, '#b9cbe6')
  return `<g>${anim('opacity', '1;.75;.9', 6, 0)}${halo.svg()}</g>${disc.svg()}${craters.svg()}`
}

// ─── koi colours, shared by both views ───
const KOI: Record<string, Record<string, string>> = {
  kohaku: { B: '#f6f1e7', P: '#e8432c', K: '#e8432c', F: '#e9d9c6', E: '#14141a' },
  ogon: { B: '#f2b02b', P: '#ffd77a', K: '#ffe39a', F: '#ffcf5c', E: '#3a2205' },
  showa: { B: '#1d1d24', P: '#f05a28', K: '#f6f1e7', F: '#4a4a58', E: '#f6f1e7' },
  sanke: { B: '#f6f1e7', P: '#e8432c', K: '#16161c', F: '#e9dfd2', E: '#14141a' },
  chagoi: { B: '#ee7428', P: '#ffa45e', K: '#ffbe85', F: '#ff9b52', E: '#2a1004' },
  platinum: { B: '#d5e0ee', P: '#ffffff', K: '#bcd0e6', F: '#eef4fb', E: '#1b2433' },
  asagi: { B: '#5f82ab', P: '#e8703e', K: '#8eacd0', F: '#e8703e', E: '#0e1624' },
  tancho: { B: '#f6f1e7', P: '#f6f1e7', K: '#e8432c', F: '#e9d9c6', E: '#14141a' },
}
const withFins = (c: Record<string, string>): Record<string, string> => ({ ...c, D: c.F!, T: c.F! })

// pixel rings for ripples (flattened by `squash`)
const ringPath = (r: number, squash: number): string => {
  const px = new Px()
  for (let y = -r - 1; y <= r + 1; y++)
    for (let x = -r - 1; x <= r + 1; x++) {
      const d = Math.hypot(x + 0.5, (y + 0.5) * squash)
      if (Math.abs(d - r) < 0.55) px.rect(x, y, 1, 1, '#a9cdf2')
    }
  return px.svg()
}
const FLY = `<g id="fly"><rect x="-1" y="0" width="3" height="1" fill="#d9ff7a" fill-opacity=".35"/><rect x="0" y="-1" width="1" height="3" fill="#d9ff7a" fill-opacity=".35"/><rect width="1" height="1" fill="#fbffcf"/></g>`
const firefly = (x: number, y: number): string =>
  `<g transform="translate(${x} ${y})"><g>${moveD('0 0;1 -1;2 -3;1 -4;-1 -5;-2 -3;-3 -1;-1 0', ri(9, 16), ri(0, 12))}<use href="#fly">${anim('opacity', '.1;.5;1;.5;.15', 2.4 + rnd() * 2.6, rnd() * 4, '0;0.3;0.45;0.65;0.8')}</use></g></g>`
const star = (x: number, y: number): string =>
  `<rect x="${x}" y="${y}" width="1" height="1" fill="#cfdcf5">${anim('opacity', '.08;.6;.25', 2 + rnd() * 4, rnd() * 6, '0;0.5;0.7')}</rect>`

// ═══════════════════════════ TOP-DOWN VIEW ═══════════════════════════

const NAVY = ['#03070e', '#050c17', '#081323', '#0b192d', '#0f2238', '#142c47', '#1b3a59', '#24496b']
const TEAL = ['#08191f', '#0c252a', '#113234', '#17403f']
const VIOLET = ['#0e0c1d', '#16122c', '#211b40', '#2c2453']
const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, (ay - by) * 1.15)
const TOP_MOON = { x: 266, y: 34, r: 11 }

let topWaterCache: string | undefined
const topWater = (): string => {
  if (topWaterCache) return topWaterCache
  const px = new Px()
  const B = 4
  for (let y = 0; y < H; y += B) {
    const cells: Array<string | undefined> = []
    for (let x = 0; x < W; x += B) {
      const b = 0.5 + (bayer(x / B, y / B) - 0.5) * 0.7
      const depth = 1 - dist(x, y, 160, 100) / 200
      const moon = Math.max(0, 1 - dist(x, y, TOP_MOON.x, TOP_MOON.y) / 140)
      const teal = Math.max(0, 1 - dist(x, y, 10, 195) / 120)
      const vio = Math.max(0, 1 - dist(x, y, 315, 198) / 110)
      let c: string
      if (teal > 0.2 + b * 0.35) c = TEAL[Math.min(3, Math.floor(teal * 4 + b - 0.4))]!
      else if (vio > 0.2 + b * 0.35) c = VIOLET[Math.min(3, Math.floor(vio * 4 + b - 0.4))]!
      else c = NAVY[Math.max(0, Math.min(7, Math.floor(depth * 3.2 + moon * moon * 5 + b - 0.2)))]!
      cells.push(c)
    }
    px.row(y, cells, 0, B, B)
  }
  return (topWaterCache = px.svg())
}

const circlePath = (cx: number, cy: number, R: number): string => {
  let d = ''
  for (let y = -R; y <= R; y++) {
    const half = Math.floor(Math.sqrt(Math.max(0, R * R - (y + 0.5) ** 2)))
    if (half > 0) d += `M${cx - half} ${cy + y}h${half * 2}v1h${-half * 2}z`
  }
  return d
}
const topPad = (cx: number, cy: number, R: number, notch: number): string => {
  const px = new Px()
  for (let y = -R; y <= R; y++) {
    const cells: Array<string | undefined> = []
    for (let x = -R; x <= R; x++) {
      const d = Math.hypot(x + 0.5, y + 0.5)
      let a = (Math.atan2(y + 0.5, x + 0.5) * 180) / Math.PI - notch
      a = ((a % 360) + 540) % 360 - 180
      if (d > R || (Math.abs(a) < 16 && d > 1.2)) cells.push(undefined)
      else if (d > R - 1.1) cells.push('#123526')
      else if (x + y < -R * 0.75) cells.push('#5aa877')
      else if (d > 2 && Math.abs(((a + 180 + 30) % 60) - 30) < 2.2 && d < R - 2) cells.push('#245e40')
      else if (x + y < -R * 0.2) cells.push('#3c8a5d')
      else cells.push('#2c7049')
    }
    px.row(cy + y, cells, cx - R)
  }
  return `<g>${moveD('0 0;1 0', 7, rnd() * 7)}<path fill="#01040a" fill-opacity=".5" transform="translate(1 2)" d="${circlePath(cx, cy, R)}"/>${px.svg()}</g>`
}

const LOTUS = sprite(
  ['....P....', '..p.W.p..', '.pPPWPPp.', 'pPWPYPWPp', '.pPPPPPp.', '..ppppp..'],
  { p: '#d9578e', P: '#f59ac0', W: '#ffe2ee', Y: '#ffd45e' },
)
// wide open, petals out, for while Claude edits
const LOTUS_OPEN = sprite(
  ['.....P.....', '.p..PWP..p.', 'pPp.PWP.pPp', '.pPPWYWPPp.', 'p.pPPPPPp.p', '...ppppp...'],
  { p: '#d9578e', P: '#f59ac0', W: '#ffe2ee', Y: '#ffd45e' },
)
const topLotus = (x: number, y: number): string =>
  `<g transform="translate(${x - 4} ${y - 3})"><g>${moveD('0 0;0 -1', 4, rnd() * 4)}<use href="#lotus"/></g></g>`

const TOP_KOI_A = [
  '......FF..........',
  'FF...BBBPPBBB.....',
  'FFF.BBPPPPBBKKE...',
  '.FFBBBBPPBBBKKBBB.',
  'FFF.BBBBBBPPBBE...',
  'FF...BBBBBPPB.....',
  '......FF..........',
]
const TOP_KOI_B = [
  '.......FF.........',
  '.F...BBBPPBBB.....',
  'FF..BBPPPPBBKKE...',
  'FFFBBBBPPBBBKKBBB.',
  'FF..BBBBBBPPBBE...',
  '.F...BBBBBPPB.....',
  '.......FF.........',
]
const topKoiDefs = Object.entries(KOI)
  .map(([k, c]) => `<g id="a-${k}">${sprite(TOP_KOI_A, c)}</g><g id="b-${k}">${sprite(TOP_KOI_B, c)}</g>`)
  .join('')

const steps = (a: number, b: number, horizontal: boolean, by = 2): string[] => {
  const out: string[] = []
  const dir = b > a ? by : -by
  for (let v = a; dir > 0 ? v <= b : v >= b; v += dir) out.push(horizontal ? `${v} 0` : `0 ${v}`)
  return out
}

type Lane = { kind: string; dir: 'r' | 'l' | 'd' | 'u'; at: number; dur: number; phase: number }
const topLane = (l: Lane): string => {
  const flick = rnd() * 0.7
  const fish = `<g>${moveD('0 0;0 1', 2.6, rnd() * 2.6)}<use href="#a-${l.kind}">${anim('opacity', '1;0', 0.7, flick)}</use><use href="#b-${l.kind}" opacity="0">${anim('opacity', '0;1', 0.7, flick)}</use></g>`
  const turn = { r: '', l: 'translate(18 0) scale(-1 1)', d: 'translate(7 0) rotate(90)', u: 'translate(0 18) rotate(-90)' }[l.dir]
  const path = {
    r: steps(-20, W + 20, true),
    l: steps(W + 2, -38, true),
    d: steps(-20, H + 20, false),
    u: steps(H + 2, -38, false),
  }[l.dir].join(';')
  const pos = l.dir === 'r' || l.dir === 'l' ? `translate(0 ${l.at})` : `translate(${l.at} 0)`
  return `<g transform="${pos}"><g>${moveD(path, l.dur, l.phase * l.dur)}<g transform="${turn}">${fish}</g></g></g>`
}
const TOP_LANES: Lane[] = [
  { kind: 'kohaku', dir: 'r', at: 6, dur: 38, phase: 0.15 },
  { kind: 'ogon', dir: 'l', at: 17, dur: 46, phase: 0.5 },
  { kind: 'sanke', dir: 'r', at: 28, dur: 52, phase: 0.75 },
  { kind: 'tancho', dir: 'l', at: 8, dur: 41, phase: 0.95 },
  { kind: 'chagoi', dir: 'l', at: 164, dur: 44, phase: 0.3 },
  { kind: 'asagi', dir: 'r', at: 176, dur: 40, phase: 0.6 },
  { kind: 'showa', dir: 'l', at: 187, dur: 56, phase: 0.05 },
  { kind: 'kohaku', dir: 'r', at: 190, dur: 48, phase: 0.85 },
  { kind: 'platinum', dir: 'd', at: 8, dur: 30, phase: 0.2 },
  { kind: 'tancho', dir: 'u', at: 26, dur: 36, phase: 0.65 },
  { kind: 'kohaku', dir: 'u', at: 290, dur: 34, phase: 0.4 },
  { kind: 'ogon', dir: 'd', at: 306, dur: 40, phase: 0.9 },
]

const RINGS = [2, 4, 7, 10]
const ripple = (x: number, y: number, delay: number, period = 4.5): string =>
  `<g transform="translate(${x} ${y})">${RINGS.map(
    (r, i) =>
      `<g opacity="${s2(0.75 - i * 0.17)}"><use href="#ring${r}" opacity="0">${anim('opacity', '1;0', period, period - ((delay + i * period * 0.1) % period), '0;0.1')}</use></g>`,
  ).join('')}</g>`

const buildTop = (): string => {
  reseed(11)
  const { x: mx, y: my } = TOP_MOON
  const streaks = Array.from({ length: 8 }, (_, i) => {
    const w = Math.max(4, 22 - Math.abs(i - 2) * 4 + ri(-2, 3))
    return `<rect x="${mx - (w >> 1) + ri(-2, 2)}" y="${my + 16 + i * 3}" width="${w}" height="1" fill="#dfeaff">${anim('opacity', '.85;.25;.55', 1.8, i * 0.37, '0;0.4;0.7')}</rect>`
  }).join('')
  const fireflies = Array.from({ length: 16 }, () => {
    const s = rnd()
    return firefly(s < 0.4 ? ri(4, 60) : s < 0.8 ? ri(260, 314) : ri(70, 250), s < 0.8 ? ri(30, 170) : ri(4, 40))
  }).join('')
  const stars = Array.from({ length: 60 }, () => star(ri(0, W - 1), ri(0, H - 1))).join('')
  const petals = Array.from({ length: 8 }, (_, i) =>
    `<g transform="translate(-8 ${ri(4, 60)})"><g>${moveL('0 0', `${W + 16} 0`, ri(60, 95), i * 10 + ri(0, 6))}<rect width="2" height="1" fill="#ffb6cf"/><rect x="1" y="1" width="1" height="1" fill="#f58fb4"/></g></g>`,
  ).join('')
  const glints = Array.from({ length: 34 }, () =>
    `<use href="#glint" x="${ri(0, W - 6)}" y="${ri(0, H - 2)}" opacity="0">${anim('opacity', '.35;.15;0', 8, rnd() * 8, '0;0.15;0.3')}</use>`,
  ).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
<defs>${topKoiDefs}<g id="lotus">${LOTUS}</g>${RINGS.map(r => `<g id="ring${r}">${ringPath(r, 1.3)}</g>`).join('')}${FLY}
<g id="glint"><path fill="#6fa6d4" d="M1 0h2v1h-2zM0 1h1v1h-1zM3 1h2v1h-2z"/></g></defs>
${topWater()}<g>${stars}</g><g>${glints}</g>
<g>${moonDisc(mx, my, TOP_MOON.r)}${streaks}</g>
<g>${ripple(266, 66, 0)}${ripple(46, 76, 1.6)}${ripple(250, 152, 2.7)}${ripple(78, 172, 0.9)}${ripple(300, 112, 3.6)}${ripple(22, 112, 2.2)}</g>
<g>${TOP_LANES.map(topLane).join('')}</g>
<g>${topPad(14, 22, 9, 40)}${topPad(30, 11, 6, 200)}${topPad(8, 46, 5, 120)}</g>
<g>${topPad(240, 60, 10, 160)}${topPad(255, 72, 6, 60)}${topPad(312, 66, 8, 250)}${topLotus(240, 58)}</g>
<g>${topPad(24, 174, 18, 20)}${topPad(52, 189, 11, 140)}${topPad(9, 140, 10, 280)}${topPad(60, 164, 7, 80)}${topLotus(26, 170)}${topLotus(9, 139)}</g>
<g>${topPad(301, 176, 17, 220)}${topPad(274, 192, 11, 330)}${topPad(316, 147, 9, 100)}${topLotus(299, 172)}</g>
<g>${petals}</g><g>${fireflies}</g>
</svg>`
}

// ═══════════════════════════ SIDE VIEW ═══════════════════════════
// The waterline sits a little above the middle. Above it: night sky, moon,
// far hills with a pagoda, a willow, a stone lantern and reeds on the left
// bank, and a dock on the right where the fisherman sits. Below it: koi, weed,
// bubbles and moonlight. The busy things live in the margins either side of
// the chat column (roughly x 112–264); the middle keeps to the waterline, the
// moon's reflection and slow, dim, deep koi.

const WL = 104 // the waterline
const SIDE_MOON = { x: 290, y: 26, r: 10 }
// ─── time of day ───
// Each phase is a palette and a cast: what hangs in the sky, which lights are
// lit, who is out. The scene keeps its layout; only these change.
type Pal = {
  sky: string[] // top of the sky to the horizon
  deep: string[] // the surface to the bed
  glowAt: { x: number; y: number } // where the sky is brightest
  cel: { x: number; y: number; r: number; kind: 'moon' | 'sun' }
  core: string
  halo: string
  reflectX: number
  reflect: string
  ridge: string
  far: string
  near: string
  pagoda: string
  window: string
  bank: string
  grass: [string, string]
  surface: string
  glint: string
  ray: string
  cloud: [string, string]
  mist: [string, string]
  stars: 'all' | 'some' | 'few' | 'none'
  lights: number // 0 off, 1 full
  fireflies: boolean
  dragonflies: boolean
  owlAwake: boolean
  glass: number
}
const PAL: Record<Phase, Pal> = {
  night: {
    sky: ['#04081a', '#071029', '#0a1534', '#0e1b3e', '#132349', '#192c55', '#203562', '#28406f'],
    deep: ['#1b3a63', '#163257', '#122a4c', '#0e2241', '#0b1b36', '#08152b', '#061020', '#040b17'],
    glowAt: { x: 290, y: 26 },
    cel: { x: 290, y: 26, r: 10, kind: 'moon' },
    core: '#e6eefc',
    halo: '#9fbde6',
    reflectX: 290,
    reflect: '#dfeaff',
    ridge: '#152647',
    far: '#0c1730',
    near: '#09122a',
    pagoda: '#0a1530',
    window: '#e9b45a',
    bank: '#0b1f17',
    grass: ['#1d4a35', '#2a6a48'],
    surface: '#4a7fb0',
    glint: '#9fc3ea',
    ray: '#8fb8e8/0.1',
    cloud: ['#2a4068/0.75', '#18284a/0.75'],
    mist: ['#2f4a72/0.6', '#26405f/0.5'],
    stars: 'all',
    lights: 1,
    fireflies: true,
    dragonflies: false,
    owlAwake: true,
    glass: 0.55,
  },
  dawn: {
    sky: ['#1f2748', '#2a3358', '#3a4068', '#544d72', '#735b7a', '#97697c', '#bc7e7c', '#dc9a82'],
    deep: ['#56607e', '#4a5472', '#3f4866', '#343d59', '#2a324c', '#212840', '#181e33', '#101526'],
    glowAt: { x: 300, y: 100 },
    cel: { x: 24, y: 20, r: 7, kind: 'moon' },
    core: '#f2e6ea',
    halo: '#d8b8c8',
    reflectX: 296,
    reflect: '#ffd0b0',
    ridge: '#4a4a6e',
    far: '#383a5e',
    near: '#272a48',
    pagoda: '#2e3052',
    window: '#f0b860',
    bank: '#162320',
    grass: ['#2f4a3a', '#3e5e48'],
    surface: '#c9a0a0',
    glint: '#ffd8c0',
    ray: '#ffd0b0/0.08',
    cloud: ['#e0a8a8/0.6', '#8a6a8a/0.6'],
    mist: ['#9a8aa8/0.55', '#8a7a98/0.5'],
    stars: 'few',
    lights: 0.5,
    fireflies: false,
    dragonflies: false,
    owlAwake: false,
    glass: 0.6,
  },
  day: {
    sky: ['#2c4f78', '#335a85', '#3a6590', '#42709a', '#4b7ba3', '#5686ac', '#6290b3', '#6e9aba'],
    deep: ['#3a7a90', '#2f6c80', '#275f72', '#205264', '#1a4656', '#143a48', '#0f2e3b', '#0a232e'],
    glowAt: { x: 290, y: 26 },
    cel: { x: 290, y: 26, r: 9, kind: 'sun' },
    core: '#fff2c0',
    halo: '#ffe9a0',
    reflectX: 290,
    reflect: '#fff4cf',
    ridge: '#5a7f98',
    far: '#4a6e88',
    near: '#35566e',
    pagoda: '#3a5a72',
    window: '#3a5a72',
    bank: '#2a4e2c',
    grass: ['#4a8a4a', '#64a35a'],
    surface: '#a8d0ee',
    glint: '#d8ecff',
    ray: '#e8f4ff/0.12',
    cloud: ['#e8eff6/0.85', '#c4d4e4/0.85'],
    mist: ['#8fb0cc/0.45', '#7a9cba/0.4'],
    stars: 'none',
    lights: 0,
    fireflies: false,
    dragonflies: true,
    owlAwake: false,
    glass: 0.68,
  },
  dusk: {
    sky: ['#1a1838', '#251d46', '#36234f', '#4d2a56', '#6a3258', '#8e3f57', '#b65452', '#d9704b'],
    deep: ['#4a3a68', '#3c315c', '#30284f', '#262143', '#1d1a37', '#15142b', '#0e0e20', '#090916'],
    glowAt: { x: 282, y: 70 },
    cel: { x: 282, y: 62, r: 10, kind: 'sun' },
    core: '#ffb070',
    halo: '#ff9a60',
    reflectX: 282,
    reflect: '#ffb070',
    ridge: '#3d2c55',
    far: '#2b1f42',
    near: '#1b1430',
    pagoda: '#22183a',
    window: '#f0b860',
    bank: '#121a1a',
    grass: ['#2c3f30', '#3d553c'],
    surface: '#d08a7a',
    glint: '#ffc890',
    ray: '#ffb080/0.08',
    cloud: ['#e08a7a/0.7', '#7a4a6a/0.7'],
    mist: ['#6a4a78/0.5', '#5a3e68/0.45'],
    stars: 'some',
    lights: 1,
    fireflies: true,
    dragonflies: false,
    owlAwake: true,
    glass: 0.6,
  },
}
const phaseAt = (d: Date): Phase => {
  const h = d.getHours() + d.getMinutes() / 60
  return h >= 5 && h < 7 ? 'dawn' : h >= 7 && h < 17 ? 'day' : h >= 17 && h < 21 ? 'dusk' : 'night'
}

const farRidge = (x: number): number => Math.round(82 + 6 * Math.sin(x / 23) + 4 * Math.sin(x / 9 + 1) + 3 * Math.sin(x / 41 + 2))
const bankTop = (x: number): number =>
  x < 80 ? Math.round(91 + 2 * Math.sin(x / 7)) : Math.round(91 + (x - 80) * 0.45 + Math.sin(x / 5))

const sideStaticCache: Partial<Record<Phase, string>> = {}
const sideStatic = (ph: Phase): string => {
  const cached = sideStaticCache[ph]
  if (cached) return cached
  const pal = PAL[ph]
  // sky
  const sky = new Px()
  for (let y = 0; y < WL; y += 4) {
    const cells: Array<string | undefined> = []
    for (let x = 0; x < W; x += 4) {
      const b = 0.5 + (bayer(x / 4, y / 4) - 0.5) * 0.8
      const m = Math.max(0, 1 - Math.hypot(x - pal.glowAt.x, (y - pal.glowAt.y) * 1.2) / 150)
      cells.push(pal.sky[Math.max(0, Math.min(7, Math.floor((y / WL) * 4.2 + m * m * 4 + b - 0.4)))]!)
    }
    sky.row(y, cells, 0, 4, 4)
  }
  // water: a dithered gradient, darker with depth, lighter under the moon
  const water = new Px()
  for (let y = WL; y < H; y += 4) {
    const cells: Array<string | undefined> = []
    for (let x = 0; x < W; x += 4) {
      const b = 0.5 + (bayer(x / 4, y / 4) - 0.5) * 0.8
      const m = Math.max(0, 1 - Math.abs(x - pal.reflectX) / 120) * Math.max(0, 1 - (y - WL) / 70)
      cells.push(pal.deep[Math.max(0, Math.min(7, Math.floor(((y - WL) / (H - WL)) * 7.5 - m * 2 + b - 0.3)))]!)
    }
    water.row(y, cells, 0, 4, 4)
  }
  // far hills, near hills
  const hills = new Px()
  for (let y = 60; y < WL; y++) {
    const far: Array<string | undefined> = []
    for (let x = 0; x < W; x += 2) far.push(farRidge(x) <= y ? (farRidge(x) === y ? pal.ridge : pal.far) : undefined)
    hills.row(y, far, 0, 1, 2)
  }
  const near = new Px()
  for (let y = 84; y < WL; y++) {
    const cells: Array<string | undefined> = []
    for (let x = 0; x < W; x += 2) {
      const top = x > 200 ? Math.round(98 - 6 * Math.sin((x - 200) / 40) - 2 * Math.sin(x / 7)) : 120
      cells.push(top <= y ? pal.near : undefined)
    }
    near.row(y, cells, 0, 1, 2)
  }
  // a pagoda on the far ridge, one window lit
  const px0 = 150
  const pagoda = at(
    px0 - 5,
    farRidge(px0) - 14,
    sprite(
      [
        '.....s.....',
        '....sss....',
        '.sssssssss.',
        '...ssyss...',
        '..sssssss..',
        'sssssssssss',
        '...sssss...',
        '...sssss...',
        '.sssssssss.',
        '...sssss...',
        '...ssssss..',
        '..sssssss..',
        '..sssssss..',
        '..sssssss..',
      ],
      { s: pal.pagoda, y: pal.window },
    ),
  )
  // the left bank, grass on top
  const bank = new Px()
  for (let x = 0; x < 116; x++) {
    const top = bankTop(x)
    if (top >= WL) continue
    bank.rect(x, top, 1, WL - top, pal.bank)
    bank.rect(x, top, 1, 1, x % 3 === 0 ? pal.grass[1] : pal.grass[0])
    if (x % 7 === 2) bank.rect(x, top - 1, 1, 1, pal.grass[1])
  }
  // seabed
  const bed = new Px()
  for (let x = 0; x < W; x += 2) {
    const top = Math.round(188 + 3 * Math.sin(x / 13) + 2 * Math.sin(x / 5))
    bed.rect(x, top, 2, H - top, '#11141c')
    bed.rect(x, top, 2, 1, '#1e2633')
    if ((x * 7) % 11 === 3) bed.rect(x, top + 3, 2, 1, '#232a35')
  }
  const rock = (cx: number, cy: number, rx: number, ry: number): void => {
    for (let y = -ry; y <= 0; y++) {
      const half = Math.round(rx * Math.sqrt(1 - (y / ry) ** 2))
      bed.rect(cx - half, cy + y, half * 2, 1, y === -ry ? '#3a4558' : y > -2 ? '#141a24' : '#262f40')
    }
  }
  rock(58, 190, 14, 8)
  rock(80, 192, 8, 5)
  rock(286, 191, 12, 7)
  rock(306, 192, 9, 6)
  // the dock: deck, posts, a lantern pole
  const dock = new Px()
  dock.rect(273, 96, W - 273, 1, '#8a6a4a')
  dock.rect(273, 97, W - 273, 2, '#5a4030')
  for (let x = 278; x < W; x += 9) dock.rect(x, 97, 1, 2, '#3e2b20')
  for (const x of [275, 296, 313]) {
    dock.rect(x, 99, 3, WL - 99, '#4a3426')
    dock.rect(x, WL, 3, 30, '#1c1a26')
  }
  dock.rect(316, 70, 2, 26, '#4a3426')
  dock.rect(309, 70, 8, 1, '#4a3426')
  dock.rect(311, 71, 1, 2, '#2a2a2a')
  // bucket on the deck
  const bucket = at(
    301,
    88,
    sprite(
      ['..gggg..', '.g....g.', 'MMMMMMMM', '.MmmmmM.', '.MmmmmM.', '.MmmmmM.', '.MmmmmM.', '..MMMM..'],
      { g: '#7a7f8a', M: '#6b4a32', m: '#55392a' },
    ),
  )
  // stone lantern on the bank
  const toro = at(
    64,
    bankTop(67) - 13,
    sprite(
      ['...s...', '.sssss.', 'sssssss', '..sss..', '.sLLLs.', '.sLYLs.', '.sLLLs.', 'sssssss', '..sss..', '..sss..', '..sss..', '.sssss.', 'sssssss'],
      pal.lights > 0 ? { s: '#4e5566', L: '#d99a3a', Y: '#ffe29a' } : { s: '#5e6576', L: '#4a4038', Y: '#5a4c40' },
    ),
  )
  return (sideStaticCache[ph] =
    sky.svg() + hills.svg() + pagoda + near.svg() + water.svg() + bed.svg() + bank.svg() + toro + dock.svg() + bucket)
}

// the willow: canopy, and strands that sway in two frames
const willow = (sway = 3.2): string => {
  const canopy = new Px()
  for (const [cx, cy, r] of [[46, 52, 14], [62, 56, 12], [32, 58, 11], [52, 44, 10], [72, 62, 8]] as const)
    for (let y = -r; y <= r; y++) {
      const half = Math.floor(Math.sqrt(Math.max(0, r * r - y * y)))
      const cells: Array<string | undefined> = []
      for (let x = -half; x <= half; x++) {
        const v = bayer(cx + x, cy + y)
        cells.push(x + y < -r * 0.5 && v < 0.6 ? '#2d6b4b' : v < 0.15 ? '#0f2a1e' : '#1b4a34')
      }
      canopy.row(cy + y, cells, cx - half)
    }
  const trunk = new Px()
  trunk.rect(46, 58, 4, bankTop(47) - 58, '#2a1f1a')
  trunk.rect(49, 66, 1, 20, '#3a2c22')
  const strands = (frame: number): string => {
    const px = new Px()
    for (let i = 0; i < 16; i++) {
      const x0 = 24 + i * 3.4
      const len = 16 + ((i * 7) % 11)
      for (let k = 0; k < len; k++) {
        const x = Math.round(x0 + (frame ? 1 : 0) * Math.min(1, k / 6))
        px.dot(x, 62 + k, k % 4 === 0 ? '#3a8a5e' : '#256045')
      }
    }
    return px.svg()
  }
  return `${trunk.svg()}${canopy.svg()}<g>${anim('opacity', '1;0', sway, 0)}${strands(0)}</g><g opacity="0">${anim('opacity', '0;1', sway, 0)}${strands(1)}</g>`
}

// reeds and cattails at the edge of the bank, swaying in two frames
const reeds = (sway = 2.6): string => {
  const frame = (f: number): string => {
    const px = new Px()
    for (let i = 0; i < 9; i++) {
      const x = 80 + i * 2 + (i % 3)
      const top = 84 + ((i * 5) % 9)
      for (let y = top; y < WL + 2; y++) px.dot(x + (f && y < top + 5 ? 1 : 0), y, '#2c5a3c')
      if (i % 2 === 0) px.rect(x + (f ? 1 : 0), top - 3, 1, 3, '#6a4a2a')
    }
    return px.svg()
  }
  return `<g>${anim('opacity', '1;0', sway, 0.4)}${frame(0)}</g><g opacity="0">${anim('opacity', '0;1', sway, 0.4)}${frame(1)}</g>`
}

// seaweed in the margins, two frames
const seaweed = (sway = 2.4): string => {
  const frame = (f: number): string => {
    const px = new Px()
    for (const [x0, h, c] of [[44, 26, '#1f5a46'], [52, 34, '#2a7a5a'], [66, 20, '#1f5a46'], [84, 30, '#2a7a5a'], [98, 18, '#1f5a46'], [272, 28, '#2a7a5a'], [282, 18, '#1f5a46'], [298, 34, '#1f5a46'], [312, 24, '#2a7a5a']] as const) {
      const base = Math.round(188 + 3 * Math.sin(x0 / 13) + 2 * Math.sin(x0 / 5))
      for (let k = 0; k < h; k++) px.dot(x0 + Math.round(1.4 * Math.sin(k / 4 + f * Math.PI)), base - k, c)
    }
    return px.svg()
  }
  return `<g>${anim('opacity', '1;0', sway, 0)}${frame(0)}</g><g opacity="0">${anim('opacity', '0;1', sway, 0)}${frame(1)}</g>`
}

// the side-on koi: 17×7, head to the right, two frames
const SIDE_KOI_A = [
  '......DDD........',
  '....BBBBBBBB.....',
  'T..BBPPPBBBBBB...',
  'TTBBBPPPPBBBKKEB.',
  'TTBBBBBBPPBBBBBBB',
  'T..BBBBBBBBBBBB..',
  '.....FF...FF.....',
]
const SIDE_KOI_B = [
  '......DDD........',
  '....BBBBBBBB.....',
  '.T.BBPPPBBBBBB...',
  'TTTBBPPPPBBBKKEB.',
  '.TTBBBBBPPBBBBBBB',
  '.T.BBBBBBBBBBBB..',
  '......FF...FF....',
]
const sideKoiDefs = Object.entries(KOI)
  .map(([k, c]) => `<g id="sa-${k}">${sprite(SIDE_KOI_A, withFins(c))}</g><g id="sb-${k}">${sprite(SIDE_KOI_B, withFins(c))}</g>`)
  .join('')
const SILHOUETTE = sprite(SIDE_KOI_A, { D: '#061226', B: '#061226', P: '#061226', K: '#061226', E: '#061226', T: '#061226', F: '#061226' })

const sideFish = (kind: string): string => {
  const flick = rnd() * 0.8
  return `<use href="#sa-${kind}">${anim('opacity', '1;0', 0.8, flick)}</use><use href="#sb-${kind}" opacity="0">${anim('opacity', '0;1', 0.8, flick)}</use>`
}
// a koi that patrols a stretch of water and turns at each end
const patrol = (kind: string, y: number, a: number, b: number, dur: number, phase: number, op = 1): string => {
  const there = steps(a, b, true)
  const path = [...there, ...steps(b, a, true)].join(';')
  return `<g transform="translate(0 ${y})" opacity="${op}"><g>${moveD(path, dur, phase * dur)}<g transform="translate(8 0)"><g>${scaleD('1 1;-1 1', dur, phase * dur, '0;0.5')}<g transform="translate(-8 0)"><g>${moveD('0 0;0 1', 3, rnd() * 3)}${sideFish(kind)}</g></g></g></g></g></g>`
}
// a koi that crosses the whole pond, deep and dim
const cruise = (kind: string, y: number, dir: 1 | -1, dur: number, phase: number, op: number): string => {
  const path = (dir > 0 ? steps(-24, W + 4, true) : steps(W + 4, -24, true)).join(';')
  const flip = dir > 0 ? '' : 'translate(17 0) scale(-1 1)'
  return `<g transform="translate(0 ${y})" opacity="${op}"><g>${moveD(path, dur, phase * dur)}<g transform="${flip}">${sideFish(kind)}</g></g></g>`
}

// ─── the fisherman ───
// Sits on the end of the dock facing left, legs over the edge. His sprite's
// top-left is (258, 81); the deck top (y 96) is his row 15.
const FISHER = sprite(
  [
    '.......hh.......',
    '.....hHHHHh.....',
    '...hHHHHHHHHh...',
    '..hhhhhhhhhhhhh.',
    '.....SSSSc......',
    '....SSSSSc......',
    '.....sSSc.......',
    '......cCCc......',
    '.....cCCCCCc....',
    '.....CCCCCCCc...',
    '.....CCCCCCCc...',
    '.....cCCCCCCc...',
    '....PPPPPCCCc...',
    '..PPPPPPPPPPc...',
    '..PPPPPPPPPPP...',
    '..PPP...........',
    '..PPP...........',
    '..PP............',
    '.BBB............',
    '.BBB............',
  ],
  { h: '#8e6d33', H: '#c9a35a', S: '#e0b08a', s: '#b8835e', c: '#1f3357', C: '#2e4a7a', P: '#4a3f55', B: '#241d22' },
)
const SHOULDER: readonly [number, number] = [264, 89]
const ROD = '#8a5a2b'
const LINE = '#cfdcf0/0.55'
const GLYPH = '#fff3a0'

const arm = (px: Px, hand: readonly [number, number], from: readonly [number, number] = SHOULDER): void => {
  px.line(from[0], from[1], hand[0], hand[1], '#5a7fbf')
  px.rect(hand[0], hand[1], 1, 1, '#e0b08a')
}
const glyph = (rows: string[], x: number, y: number): string => at(x, y, sprite(rows, { W: GLYPH }))
const EXCL = ['W', 'W', 'W', '.', 'W']
const QUES = ['.WW.', 'W..W', '..W.', '....', '..W.']
const ZED = ['WWW', '..W', '.W.', 'WWW']
const blink = (body: string, dur = 1.2, phase = 0): string => `<g>${anim('opacity', '1;0.2', dur, phase)}${body}</g>`
const two = (a: string, b: string, dur: number, phase = 0): string =>
  `<g>${anim('opacity', '1;0', dur, phase)}${a}</g><g opacity="0">${anim('opacity', '0;1', dur, phase)}${b}</g>`

const bobber = (x: number, y: number, fast: boolean): string => {
  const body = `<rect x="${x}" y="${y - 1}" width="2" height="1" fill="#e8432c"/><rect x="${x}" y="${y}" width="2" height="1" fill="#f6f1e7"/>`
  const bob = fast ? moveD('0 0;0 1;0 0;0 2;0 0;0 1', 1.2, 0) : moveD('0 0;0 1', 1.8, 0)
  return `<g>${bob}${body}</g>${ripple(x + 1, WL + 1, 0, fast ? 1.6 : 3.4)}`
}
// rod in hand at rest, line and bobber in the water
const restingRod = (px: Px, hand: readonly [number, number], tip: readonly [number, number], bob: number): void => {
  px.line(hand[0], hand[1], tip[0], tip[1], ROD)
  px.line(tip[0], tip[1] + 1, bob + 1, WL - 2, LINE)
}
const CATCH_KINDS = ['kohaku', 'ogon', 'showa', 'sanke', 'chagoi', 'tancho']

const fisherman = (p: Pond): string => {
  const px = new Px()
  let extra = ''
  const idleHand = [259, 92] as const
  const idleTip = [243, 77] as const
  switch (p.mood) {
    case 'idle':
    case 'typing':
    case 'watch': {
      arm(px, idleHand)
      restingRod(px, idleHand, idleTip, 240)
      extra += bobber(240, WL - 1, p.mood === 'watch')
      if (p.mood === 'typing')
        extra += [0, 1, 2]
          .map(i => `<rect x="${262 + i * 3}" y="75" width="1" height="1" fill="${GLYPH}" opacity="0">${anim('opacity', '0;1;1;0', 1.4, i * 0.25, '0;0.2;0.7;0.9')}</rect>`)
          .join('')
      if (p.mood === 'watch') extra += blink(glyph(EXCL, 266, 72), 0.9)
      break
    }
    case 'cast': {
      // back, forward, then at rest; the bobber flies out and lands
      const back = new Px()
      arm(back, [262, 87])
      back.line(262, 87, 282, 64, ROD)
      const fwd = new Px()
      arm(fwd, [258, 90])
      fwd.line(258, 90, 240, 70, ROD)
      const rest = new Px()
      arm(rest, idleHand)
      restingRod(rest, idleHand, idleTip, 240)
      const arc = [[240, 70], [237, 74], [236, 80], [237, 87], [238, 94], [240, 100]] as const
      extra += `<g>${shot('opacity', '1;0', 1.6, '0;0.22')}${back.svg()}</g>`
      extra += `<g opacity="0">${shot('opacity', '0;1;0', 1.6, '0;0.22;0.45')}${fwd.svg()}</g>`
      extra += `<g opacity="0">${shot('opacity', '0;1', 1.6, '0;0.45')}${rest.svg()}${bobber(240, WL - 1, false)}</g>`
      extra += `<g opacity="0">${shot('opacity', '0;1;0', 1.6, '0;0.22;0.45')}<g>${shotMove(['0 0', ...arc.map(([x, y]) => `${x} ${y}`)].join(';'), 1.6, ['0', ...arc.map((_, i) => s2(0.22 + (i * 0.23) / arc.length))].join(';'))}<rect width="2" height="2" fill="#e8432c"/></g></g>`
      extra += `<g opacity="0">${shot('opacity', '0;1;0', 1.6, '0;0.45;0.9')}${ripple(241, WL + 1, 0, 0.7)}</g>`
      break
    }
    case 'reel': {
      // rod bent, line taut to a fish fighting below, the other hand cranking
      arm(px, [258, 91])
      px.poly([[258, 91], [250, 83], [245, 85]], ROD)
      px.line(245, 86, 232, 124, LINE)
      const crankA = new Px()
      arm(crankA, [262, 92], [266, 89])
      const crankB = new Px()
      arm(crankB, [263, 94], [266, 89])
      extra += two(crankA.svg(), crankB.svg(), 0.3)
      extra += `<g transform="translate(216 121)" opacity=".7"><g>${moveD('0 0;-1 1;1 0;0 -1;1 1', 0.5, 0)}${SILHOUETTE}</g></g>`
      const drops = (f: number): string =>
        [[-2, -2], [1, -3], [3, -1], [-3, -1], [0, -4]]
          .filter((_, i) => (i + f) % 2 === 0)
          .map(([dx, dy]) => `<rect x="${239 + dx!}" y="${WL + dy!}" width="1" height="1" fill="#cfe6ff"/>`)
          .join('')
      extra += two(drops(0), drops(1), 0.35)
      extra += ripple(239, WL + 1, 0, 1.2)
      extra += blink(glyph(EXCL, 266, 72), 0.5)
      break
    }
    case 'lantern': {
      // looking something up: rod in one hand, a lantern held out over the water
      arm(px, idleHand)
      restingRod(px, idleHand, idleTip, 240)
      arm(px, [251, 90], [266, 89])
      extra += bobber(240, WL - 1, false)
      const lamp = at(248, 90, sprite(['.k.', 'LYL', 'LYL', '.L.'], { k: '#7a7f8a', L: '#b0702a', Y: '#ffe29a' }))
      extra += `<g>${anim('opacity', '1;.7;.9;.8', 0.9, 0)}${glow(249, 92, 18, '#ffcf7a/0.22', 0.9)}${glow(249, WL + 6, 14, '#ffcf7a/0.12', 0.7)}</g>${lamp}`
      break
    }
    case 'mend': {
      // editing: rod propped on the deck, mending the net on his lap
      px.line(270, 95, 248, 74, ROD)
      px.line(248, 75, 247, WL - 2, LINE)
      extra += bobber(246, WL - 1, false)
      arm(px, [260, 93])
      arm(px, [265, 93], [266, 89])
      const net = new Px()
      for (let y = 93; y <= 97; y++) for (let x = 254; x <= 266; x++) if ((x + y) % 2 === 0) net.rect(x, y, 1, 1, '#9aa6b8')
      const needle = (x: number): string => `<rect x="${x}" y="92" width="1" height="2" fill="#e6eefc"/>`
      extra += net.svg() + two(needle(258), needle(262), 0.5)
      break
    }
    case 'catch': {
      // a koi leaps into the bucket; arms up, rod down on the deck
      arm(px, [260, 82])
      arm(px, [269, 82], [266, 89])
      px.line(274, 95, 248, 94, ROD)
      extra += blink(glyph(EXCL, 264, 70), 0.6)
      extra += [[252, 78], [276, 80], [256, 70], [272, 68]]
        .map(([x, y], i) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${GLYPH}" opacity="0">${anim('opacity', '0;1;0', 1.2, i * 0.3, '0;0.3;0.6')}</rect>`)
        .join('')
      const kind = CATCH_KINDS[(Math.max(1, p.catches) - 1) % CATCH_KINDS.length]!
      const n = 14
      const arc = Array.from({ length: n }, (_, i) => {
        const t = i / (n - 1)
        return [Math.round(236 + t * 60), Math.round(104 - 4 * 38 * t * (1 - t) - t * 18)] as const
      })
      extra += `<g>${shot('opacity', '1;0', 1.5, '0;0.99')}<g>${shotMove(arc.map(([x, y]) => `${x - 8} ${y - 4}`).join(';'), 1.5, arc.map((_, i) => s2(i / n)).join(';'))}${sideFish(kind)}</g></g>`
      extra += `<g opacity="0">${shot('opacity', '0;1;0', 2, '0;0.01;0.6')}${ripple(238, WL + 1, 0, 0.8)}</g>`
      break
    }
    case 'snap': {
      // the line snapped: it hangs slack, and he scratches his head
      arm(px, idleHand)
      px.line(idleHand[0], idleHand[1], 244, 78, ROD)
      px.poly([[244, 79], [240, 86], [246, 93], [242, 99], [248, WL - 1]], LINE)
      const scratchA = new Px()
      arm(scratchA, [263, 84], [266, 89])
      const scratchB = new Px()
      arm(scratchB, [264, 83], [266, 89])
      extra += two(scratchA.svg(), scratchB.svg(), 0.4)
      extra += blink(glyph(QUES, 262, 70), 1)
      extra += ripple(248, WL + 1, 0, 2.2)
      break
    }
    case 'sleep': {
      px.line(270, 95, 248, 74, ROD)
      px.line(248, 75, 247, WL - 2, LINE)
      extra += bobber(246, WL - 1, false)
      arm(px, [260, 93])
      extra += [0, 1, 2]
        .map(i => `<g opacity="0">${anim('opacity', '0;1;1;0', 4.5, i * 1.5, '0;0.1;0.7;0.9')}<g>${moveL('266 76', '276 58', 4.5, i * 1.5)}${sprite(ZED, { W: GLYPH })}</g></g>`)
        .join('')
      break
    }
  }
  // fish he has caught this session, tails up in the bucket
  const tails = Array.from({ length: Math.min(3, p.catches) }, (_, i) => {
    const c = KOI[CATCH_KINDS[i % CATCH_KINDS.length]!]!
    const x = 294 + i * 2
    return two(
      `<rect x="${x}" y="85" width="1" height="3" fill="${c.B}"/><rect x="${x - 1}" y="84" width="1" height="1" fill="${c.F}"/>`,
      `<rect x="${x}" y="85" width="1" height="3" fill="${c.B}"/><rect x="${x + 1}" y="84" width="1" height="1" fill="${c.F}"/>`,
      0.6,
      i * 0.2,
    )
  }).join('')
  return `${at(258, 81, FISHER)}${px.svg()}${extra}${tails}`
}

// A low mist bank over the water behind the chat column: it melts the horizon
// where the conversation sits, and thins out toward the bank and the dock so
// the waterline stays crisp in the margins.
const mistLayer = (shift: number, colors: [string, string]): string => {
  const px = new Px()
  for (let y = WL - 12; y <= WL + 8; y += 2) {
    const cells: Array<string | undefined> = []
    for (let x = 0; x < W; x += 2) {
      const across = Math.max(0, Math.min(1, (x - 112) / 24, (246 - x) / 24))
      const v = (1 - Math.abs(y + 1 - WL) / (y < WL ? 13 : 9)) * across
      cells.push(v > 0 && bayer((x >> 1) + shift * 2, (y >> 1) + shift) < v * 0.85 ? (v > 0.55 ? colors[0] : colors[1]) : undefined)
    }
    px.row(y, cells, 0, 2, 2)
  }
  return px.svg()
}

// Stars twinkle in five groups (one animation each, not one per star), with a
// few bright four-point stars, a faint Milky Way and a shooting star.
const skyStars = (mx: number, my: number, level: Pal['stars']): string => {
  if (level === 'none') return ''
  const count = level === 'all' ? 120 : level === 'some' ? 45 : 16
  const top = level === 'all' ? 74 : level === 'some' ? 48 : 34
  const groups = Array.from({ length: 5 }, () => new Px())
  const calm = new Px()
  for (let i = 0; i < count; i++) {
    const x = ri(0, W - 1)
    const y = ri(0, top)
    if (Math.hypot(x - mx, y - my) < 22 || y > farRidge(x) - 3) continue
    const white = rnd() < 0.25
    // behind the chat column the stars hold still and dim, so they don't flicker under the text
    if (x > CHAT_LEFT && x < CHAT_RIGHT) calm.rect(x, y, 1, 1, '#8ea0c4')
    else groups[i % 5]!.rect(x, y, 1, 1, white ? '#ffffff' : '#bccbe8')
  }
  const twinkle = groups
    .map((g, i) => `<g>${anim('opacity', '.35;.9;.5;1;.4', 3.1 + i * 0.9, i * 1.7, '0;0.2;0.45;0.65;0.85')}${g.svg()}</g>`)
    .join('')
  const milky = new Px()
  for (let y = 0; y < 70; y += 2) {
    const cells: Array<string | undefined> = []
    for (let x = 0; x < W; x += 2) {
      const d = Math.abs(y - (60 - x * 0.24))
      const v =
        Math.max(0, 1 - d / 16) * Math.max(0, Math.min(1, (250 - x) / 60)) * (y > farRidge(x) - 4 ? 0 : 1) * (x > CHAT_LEFT && x < CHAT_RIGHT ? 0.5 : 1)
      cells.push(v > 0 && bayer(x >> 1, y >> 1) < v * v * 0.5 ? (v > 0.75 ? '#7d8fc0/0.22' : '#5a6f9e/0.16') : undefined)
    }
    milky.row(y, cells, 0, 2, 2)
  }
  const bright = [[38, 14], [96, 8], [262, 46], [256, 10], [86, 34], [22, 46]]
    .map(
      ([x, y], i) =>
        `<g transform="translate(${x} ${y})">${anim('opacity', '.35;1;.6;.9', 2.6 + i * 0.5, i * 0.8, '0;0.3;0.6;0.8')}<path fill="#dfe8ff" fill-opacity=".55" d="M0 -2h1v2h-1zM0 1h1v2h-1zM-2 0h2v1h-2zM1 0h2v1h-2z"/><rect width="1" height="1" fill="#fff"/></g>`,
    )
    .join('')
  // a shooting star every 27 seconds, across the upper left
  const pos = Array.from({ length: 8 }, (_, k) => `${30 + k * 8} ${8 + k * 4}`)
  const shooting = `<g opacity="0">${anim('opacity', '0;1;0', 27, 5, '0;0.9;0.99')}<g>${moveD([pos[0]!, ...pos].join(';'), 27, 5, ['0', ...pos.map((_, k) => s2(0.9 + k * 0.0125))].join(';'))}<rect width="2" height="1" fill="#ffffff"/><rect x="-3" y="-1" width="3" height="1" fill="#cfe0ff" fill-opacity=".6"/><rect x="-7" y="-2" width="4" height="1" fill="#9fb6e6" fill-opacity=".3"/></g></g>`
  if (level !== 'all') return `<g opacity="${level === 'few' ? 0.5 : 0.8}">${`<g opacity=".55">${calm.svg()}</g>` + twinkle}</g>`
  return milky.svg() + `<g opacity=".55">${calm.svg()}</g>` + twinkle + bright + shooting
}

// the sun: a soft dithered halo round a bright disc
const sunDisc = (cx: number, cy: number, r: number, core: string, halo: string): string => {
  const disc = new Px()
  for (let y = cy - r; y <= cy + r; y++) {
    const cells: Array<string | undefined> = []
    for (let x = cx - r; x <= cx + r; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      cells.push(d >= r ? undefined : d < r * 0.55 ? '#fffbe8' : core)
    }
    disc.row(y, cells, cx - r)
  }
  return `<g>${anim('opacity', '1;.8;.95', 5, 0)}${glow(cx, cy, r + 22, `${halo}/0.22`, 0.9)}</g>${disc.svg()}`
}
const celestial = (pal: Pal): string =>
  pal.cel.kind === 'sun' ? sunDisc(pal.cel.x, pal.cel.y, pal.cel.r, pal.core, pal.halo) : moonDisc(pal.cel.x, pal.cel.y, pal.cel.r)

// dragonflies dart over the reeds and lilies by day
const dragonflies = (): string =>
  [[96, 84], [128, 92], [262, 82]]
    .map(([x, y], i) => {
      const hops = '0 0;0 0;6 -3;6 -3;6 -3;-4 -5;-4 -5;3 2;3 2;3 2;0 0'
      return `<g transform="translate(${x} ${y})"><g>${moveD(hops, 5 + i, i * 1.7)}${two(
        `<rect width="5" height="1" fill="#3fa8d8"/><rect x="1" y="-1" width="2" height="1" fill="#e6f4ff" fill-opacity=".8"/>`,
        `<rect width="5" height="1" fill="#3fa8d8"/><rect x="1" y="1" width="2" height="1" fill="#e6f4ff" fill-opacity=".8"/>`,
        0.2,
        i * 0.1,
      )}</g></g>`
    })
    .join('')

// an owl in the willow, blinking now and then
const OWL = (eye: string): string =>
  sprite(['.B.B.', 'BBBBB', `B${eye}B${eye}B`, 'BBbBB', '.BBB.', '..k..'], { B: '#5a4632', b: '#3a2c20', Y: '#ffd45e', k: '#8a6a3a' })
const OWL_COLORS = { B: '#5a4632', b: '#3a2c20', Y: '#ffd45e', k: '#8a6a3a', W: '#7a6248' }
const blinking = (open: string, shut: string): string =>
  `<g>${anim('opacity', '1;0', 5.5, 0, '0;0.93')}${open}</g><g opacity="0">${anim('opacity', '0;1', 5.5, 0, '0;0.93')}${shut}</g>`
// The owl has opinions: it hoots along while Claude reads, cocks its head while
// you type, flaps at a catch, turns its back on an error, and keeps watch while
// the fisherman sleeps.
const owl = (mood: Mood, awake: boolean): string => {
  const branch = `<rect x="70" y="69" width="14" height="1" fill="#2a1f1a"/>`
  let body: string
  if (mood === 'catch')
    body = at(74, 63, two(
      sprite(['..B.B..', '.BBBBB.', 'WBYBYBW', 'WBBbBBW', '..BBB..', '...k...'], OWL_COLORS),
      sprite(['W.B.B.W', 'WBBBBBW', '.BYBYB.', '.BBbBB.', '..BBB..', '...k...'], OWL_COLORS),
      0.35,
    ))
  else if (!awake) body = at(75, 63, OWL('b')) // asleep in daylight
  else if (mood === 'snap') body = at(75, 63, sprite(['.B.B.', 'BBBBB', 'BbBbB', 'BBBBB', '.BBB.', '..k..'], OWL_COLORS))
  else if (mood === 'typing')
    body = at(75, 63, blinking(
      sprite(['..B.B', '.BBBB', '.BYBY', 'BBbBB', '.BBB.', '..k..'], OWL_COLORS),
      sprite(['..B.B', '.BBBB', '.BbBb', 'BBbBB', '.BBB.', '..k..'], OWL_COLORS),
    ))
  else {
    body = at(75, 63, blinking(OWL('Y'), OWL('b')))
    if (mood === 'lantern') {
      // it swoops from the willow to the dock's lantern pole, then bobs and hoots beside him
      const n = 14
      const path = Array.from({ length: n }, (_, i) => {
        const t = i / (n - 1)
        return `${Math.round(74 + t * 238)} ${Math.round(63 - 34 * 4 * t * (1 - t))}`
      })
      const wings = two(
        sprite(['W.B.B.W', 'WBBBBBW', '.BYBYB.', '.BBbBB.', '..BBB..'], OWL_COLORS),
        sprite(['..B.B..', '.BBBBB.', 'WBYBYBW', 'WBBbBBW', 'W.BBB.W'], OWL_COLORS),
        0.25,
      )
      const flying = `<g>${shot('opacity', '1;0', 1.8, '0;0.99')}<g>${shotMove(path.join(';'), 1.8, even(n))}${wings}</g></g>`
      const hoots = [0, 1]
        .map(i => `<g opacity="0">${anim('opacity', '0;.9;0', 2.4, i * 1.2, '0;0.15;0.7')}<g>${moveL('306 60', '300 50', 2.4, i * 1.2)}<rect width="2" height="1" fill="${GLYPH}"/><rect y="1" width="1" height="1" fill="${GLYPH}"/></g></g>`)
        .join('')
      const perched = `<g opacity="0">${shot('opacity', '0;1', 1.8, '0;0.99')}<g>${moveD('0 0;0 1', 0.5, 0)}${at(313, 64, blinking(OWL('Y'), OWL('b')))}</g>${hoots}</g>`
      return branch + flying + perched
    }
  }
  return branch + body
}

// Everything besides the fisherman that answers his mood, in screen coordinates.
// His bobber sits at x 250 on the waterline.
const pondReacts = (p: Pond): { sky: string; water: string; air: string } => {
  const pal = PAL[p.phase]
  const night = pal.stars !== 'none'
  let sky = ''
  let water = ''
  let air = ''
  const curious = (kind: string, x: number, y: number, flip: boolean, nibble: boolean): string => {
    const turn = flip ? 'translate(17 0) scale(-1 1)' : ''
    const motion = nibble ? moveD('0 0;1 0;0 0;1 -1;0 0', 0.7, x) : moveD('0 0;0 1', 2.4, x)
    return `<g transform="translate(${x} ${y})" opacity=".85"><g>${motion}<g transform="${turn}">${sideFish(kind)}</g></g></g>`
  }
  const pair = (nibble: boolean, dy = 0): string =>
    curious('kohaku', 229, 112 + dy, false, nibble) + curious('ogon', 254, 116 + dy, true, nibble) + curious('tancho', 238, 124 + dy, false, nibble)
  const bubbles = [246, 252, 255]
    .map((x, i) => `<g transform="translate(${x} ${114 + i * 3})" opacity="0">${anim('opacity', '0;.8;.8;0', 1.6, i * 0.5, '0;0.1;0.7;0.9')}<g>${moveL('0 0', '0 -9', 1.6, i * 0.5)}<rect width="1" height="1" fill="#cfe6ff"/></g></g>`)
    .join('')
  switch (p.mood) {
    case 'idle':
    case 'typing':
    case 'lantern':
    case 'mend':
      water += pair(false)
      break
    case 'sleep':
      // they sink a little and rest
      water += `<g opacity=".75">${pair(false, 10)}</g>`
      break
    case 'watch':
      water += pair(true) + bubbles
      break
    case 'cast':
      // they swim up from the deep to see what landed
      water += `<g>${shotMoveAt(0, '-30 40;-30 40;-20 28;-12 16;-5 6;0 0', 1.8, '0;0.3;0.45;0.6;0.75;0.9')}${pair(false)}</g>`
      break
    case 'snap': {
      // the one that got away darts off to the deep
      const path = Array.from({ length: 10 }, (_, i) => `${240 - i * 10} ${116 + i * 2}`)
      water += `<g>${shotAt(0, 'opacity', '1;0', 1.4, '0;0.95')}<g>${shotMoveAt(0, path.join(';'), 1.4, even(path.length))}<g transform="translate(17 0) scale(-1 1)">${sideFish('sanke')}</g></g></g>`
      // and a cloud slides over the moon
      const cloud = new Px()
      for (const [cx, cy, r] of [[8, 5, 6], [16, 3, 8], [25, 6, 5]] as const)
        for (let y = -r; y <= r; y++) {
          const half = Math.floor(Math.sqrt(Math.max(0, r * r - y * y)) * 1.5)
          if (cy + y <= 9) cloud.rect(cx - half, cy + y, half * 2, 1, '#0b1530/0.88')
        }
      sky += `<g>${shotMoveAt(0, '240 18;250 18;260 18;268 18;274 18;278 19', 1.5, even(6))}${cloud.svg()}</g>`
      break
    }
    case 'catch': {
      // the pond stirs, a shooting star crosses, the moon flares, fireflies burst
      // the whole pond stirs: rings spread out across the water
      water += [[150, 0.2], [196, 0.5], [120, 0.8], [276, 0.35]]
        .map(([x, d]) => `<g opacity="0">${shotAt(d!, 'opacity', '0;1;0', 2.2, '0;0.01;0.9')}${ripple(x!, WL + 1, 0, 1.1)}</g>`)
        .join('')
      const star = Array.from({ length: 9 }, (_, k) => `${20 + k * 9} ${6 + k * 4}`)
      if (night) sky += `<g opacity="0">${shotAt(0.3, 'opacity', '0;1;0', 1.2, '0;0.01;0.85')}<g>${shotMoveAt(0.3, star.join(';'), 1.2, even(star.length))}<rect width="2" height="1" fill="#fff"/><rect x="-3" y="-1" width="3" height="1" fill="#cfe0ff" fill-opacity=".7"/><rect x="-7" y="-2" width="4" height="1" fill="#9fb6e6" fill-opacity=".35"/></g></g>`
      sky += `<g opacity="0">${shot('opacity', '0;1;.4;0', 2.4, '0;0.1;0.5;0.9')}${glow(pal.cel.x, pal.cel.y, 22, `${pal.reflect}/0.2`, 0.9)}</g>`
      air += Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2 + 0.5
        const path = [0, 1, 2, 3, 4].map(k => `${Math.round(Math.cos(a) * k * 4)} ${Math.round(Math.sin(a) * k * 3 - k)}`)
        return `<g transform="translate(305 86)" opacity="0">${shotAt(1.2, 'opacity', '1;1;0', 1.4, '0;0.6;0.95')}<g>${shotMoveAt(1.2, path.join(';'), 1.4, even(path.length))}<use href="#fly"/></g></g>`
      }).join('')
      break
    }
    case 'reel': {
      // the struggle sends the curious koi darting off both ways
      const flee = (kind: string, x: number, y: number, dx: number, flip: boolean): string => {
        const path = Array.from({ length: 8 }, (_, i) => `${x + dx * i * i} ${y + i * 2}`)
        const turn = flip ? 'translate(17 0) scale(-1 1)' : ''
        return `<g>${shot('opacity', '1;0', 1.2, '0;0.95')}<g>${shotMove(path.join(';'), 1.2, even(path.length))}<g transform="${turn}">${sideFish(kind)}</g></g></g>`
      }
      water += flee('kohaku', 229, 112, -2, true) + flee('ogon', 254, 116, 2, false) + flee('tancho', 238, 124, -1, true)
      break
    }
  }
  if (p.mood === 'sleep' && night) {
    // shooting stars come more often while he dreams
    const pos = Array.from({ length: 8 }, (_, k) => `${252 + k * 7} ${2 + k}`)
    sky += `<g opacity="0">${anim('opacity', '0;1;0', 9, 2, '0;0.8;0.95')}<g>${moveD([pos[0]!, ...pos].join(';'), 9, 2, ['0', ...pos.map((_, k) => s2(0.8 + k * 0.018))].join(';'))}<rect width="2" height="1" fill="#fff"/><rect x="-3" y="-1" width="3" height="1" fill="#cfe0ff" fill-opacity=".6"/></g></g>`
  }
  return { sky, water, air }
}

const buildSide = (p: Pond): string => {
  reseed(23)
  const pal = PAL[p.phase]
  const { x: mx, y: my } = pal.cel
  const reflection = Array.from({ length: 9 }, (_, i) => {
    const w = Math.max(3, 20 - i * 2 + ri(-2, 2))
    return `<rect x="${pal.reflectX - (w >> 1) + ri(-2, 2)}" y="${WL + 2 + i * 3}" width="${w}" height="1" fill="${pal.reflect}">${anim('opacity', '.8;.25;.55', 1.8, i * 0.41, '0;0.4;0.7')}</rect>`
  }).join('')
  const surface = Array.from({ length: 16 }, () => {
    const x = rnd() < 0.5 ? ri(0, 114) : ri(250, W - 4) // glints stay in the margins
    return `<rect x="${x}" y="${WL}" width="${ri(2, 5)}" height="1" fill="${pal.glint}" opacity="0">${anim('opacity', '.6;.2;0', 5, rnd() * 5, '0;0.2;0.4')}</rect>`
  }).join('')
  const rays = [92, 180, 272]
    .map((x0, i) => {
      const px = new Px()
      for (let y = WL + 1; y < 186; y += 2)
        for (let x = 0; x < 10; x += 2)
          if (bayer(x >> 1, y >> 1) < 0.35 * (1 - (y - WL) / 90)) px.rect(Math.round(x0 - (y - WL) * 0.45 + x), y, 2, 2, pal.ray)
      return `<g>${anim('opacity', '1;.6;.85', 7, i * 2)}${px.svg()}</g>`
    })
    .join('')
  const bubbles = Array.from({ length: 9 }, () => {
    const x = rnd() < 0.5 ? ri(44, 104) : ri(262, 316)
    const dur = ri(6, 11)
    return `<g transform="translate(${x} 186)"><g>${moveL('0 0', '0 -78', dur, rnd() * dur)}<rect width="1" height="1" fill="#a9cdf2" fill-opacity=".7"/></g></g>`
  }).join('')
  const stars = skyStars(mx, my, pal.stars)
  const reacts = pondReacts(p)
  const gust = p.mood === 'reel' || p.mood === 'catch'
  const working = p.mood === 'watch' || p.mood === 'reel' || p.mood === 'lantern' || p.mood === 'mend' || p.mood === 'cast'
  // lights of a far-off village on the hills
  const village = (pal.lights === 0 ? [] : pal.lights < 1 ? [178, 214] : [172, 178, 207, 214, 221, ...(working ? [186, 193, 228, 234, 240] : [])])
    .map((x, i) => `<rect x="${x}" y="${farRidge(x) + 2 + (i % 2)}" width="1" height="1" fill="#f0b860">${anim('opacity', '.9;.5;.8;.3', 4 + i, i * 1.3, '0;0.3;0.6;0.85')}</rect>`)
    .join('')
  // starlight caught on the water near the banks
  const wstars = new Px()
  for (let i = 0; i < 16; i++) wstars.rect(rnd() < 0.5 ? ri(2, 114) : ri(250, 318), ri(WL + 3, WL + 16), 1, 1, '#9fb6dc')
  const waterStars = pal.stars === 'none' ? '' : `<g opacity=".5">${anim('opacity', '.5;.2;.4;.1', 3.7, 0.5, '0;0.3;0.6;0.8')}${wstars.svg()}</g>`
  // moths around the dock lantern
  const moths = (pal.lights === 0 && p.mood !== 'lantern' ? [] : [0, 1])
    .map(i => `<g transform="translate(${p.mood === 'lantern' ? 256 + i * 3 : 308 + i * 4} ${p.mood === 'lantern' ? 88 + i * 2 : 74 + i * 2})"><g>${moveD('0 0;2 -1;3 1;1 3;-1 2;-2 0;-1 -2', 0.9 + i * 0.3, i * 0.4)}<rect width="1" height="1" fill="#e8dcc0"/></g></g>`)
    .join('')
  const cloud = (y: number, dur: number, phase: number, w: number): string => {
    const px = new Px()
    for (const [cx, cy, rr] of [[w * 0.3, 6, 6], [w * 0.55, 4, 8], [w * 0.8, 7, 5], [w * 0.15, 8, 4]] as const)
      for (let yy = -rr; yy <= rr; yy++) {
        const half = Math.floor(Math.sqrt(Math.max(0, rr * rr - yy * yy)) * 1.6)
        if (cy + yy <= 10) px.rect(Math.round(cx) - half, cy + yy, half * 2, 1, yy < -rr / 2 ? pal.cloud[0] : pal.cloud[1])
      }
    return `<g transform="translate(0 ${y})"><g>${moveL(`${-w} 0`, `${W + w} 0`, dur, phase)}${px.svg()}</g></g>`
  }
  // Water lilies: each pad and flower rides its own long, slack stem down to a
  // shared rootstock in the mud. The stems curve and sway in two frames.
  const LILY_X = [101, 110]
  const ROOT = { x: 106, y: 185 }
  const stems = (f: number): string => {
    const px = new Px()
    LILY_X.forEach((x, i) => {
      const top = x + 3
      for (let y = WL + 1; y < ROOT.y; y++) {
        const t = (y - WL) / (ROOT.y - WL)
        const sway = (1 - t) * (1.8 * Math.sin(y / 11 + i * 2.1 + f * Math.PI * 0.6) + (f ? 0.8 : 0) * (1 - t))
        px.dot(Math.round(top + (ROOT.x - top) * t * t + sway), y, '#1f4a35/0.6')
      }
    })
    return px.svg()
  }
  const rootstock = `<rect x="${ROOT.x - 4}" y="${ROOT.y}" width="9" height="2" fill="#3a2e22"/><rect x="${ROOT.x - 2}" y="${ROOT.y - 1}" width="5" height="1" fill="#4a3a2a"/><rect x="${ROOT.x - 6}" y="${ROOT.y + 1}" width="2" height="1" fill="#2e251c"/>`
  const lilies =
    two(stems(0), stems(1), 3.6, 0.7) +
    rootstock +
    LILY_X.map((x, i) => {
      const pad = `<rect x="${x}" y="${WL - 1}" width="8" height="1" fill="#2c7049"/><rect x="${x + 1}" y="${WL - 2}" width="6" height="1" fill="#3c8a5d"/>`
      const bloom = p.mood === 'mend' ? at(x - 2, WL - 9, `<g>${moveD('0 0;0 -1', 1.2, i)}<use href="#lotusOpen"/></g>`) : at(x - 1, WL - 8, `<g>${moveD('0 0;0 -1', 4, i)}<use href="#lotus"/></g>`)
      return pad + bloom
    }).join('')
  const fireflies = pal.fireflies
    ? [...Array.from({ length: 7 }, () => firefly(ri(40, 116), ri(56, 100))), ...Array.from({ length: 3 }, () => firefly(ri(254, 314), ri(60, 92)))].join('')
    : pal.dragonflies
      ? dragonflies()
      : ''
  const lampBoost = (cx: number, cy: number): string => (working ? glow(cx, cy, 24, '#ffcf7a/0.1', 0.8) : '')
  const lit = pal.lights > 0
  const dockLamp = `${lit ? `<g opacity="${(p.mood === 'sleep' ? 0.45 : 1) * pal.lights}">${anim('opacity', working ? '1;.55;1;.7' : '1;.75;.9;.8', working ? 0.6 : 1.1, 0.3)}${glow(312, 76, 16, '#ffcf7a/0.2', 0.9)}${lampBoost(312, 76)}</g>` : ''}${at(310, 73, sprite(['LL', 'YY', 'YY', 'LL'], { L: '#8a5a2b', Y: lit ? '#ffe29a' : '#6a5a40' }))}`
  const toroGlow = lit ? `<g opacity="${pal.lights}">${anim('opacity', working ? '1;.5;1' : '1;.7;.9', working ? 0.7 : 1.4, 0.8)}${glow(67, bankTop(67) - 8, 12, '#ffcf7a/0.2', 0.9)}${lampBoost(67, bankTop(67) - 8)}</g>` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="wl" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${pal.surface}" stop-opacity=".55"/><stop offset=".34" stop-color="${pal.surface}" stop-opacity=".55"/><stop offset=".43" stop-color="${pal.surface}" stop-opacity=".15"/><stop offset=".69" stop-color="${pal.surface}" stop-opacity=".15"/><stop offset=".78" stop-color="${pal.surface}" stop-opacity=".55"/><stop offset="1" stop-color="${pal.surface}" stop-opacity=".55"/></linearGradient>${sideKoiDefs}<g id="lotus">${LOTUS}</g><g id="lotusOpen">${LOTUS_OPEN}</g>${RINGS.map(rr => `<g id="ring${rr}">${ringPath(rr, 2.6)}</g>`).join('')}${FLY}</defs>
${sideStatic(p.phase)}
${stars}${village}${celestial(pal)}${reacts.sky}${cloud(14, 260, 40, 50)}${cloud(38, 340, 200, 40)}
${willow(gust ? 0.7 : 3.2)}${owl(p.mood, pal.owlAwake)}${toroGlow}${reeds(gust ? 0.5 : 2.6)}
<rect x="0" y="${WL}" width="${W}" height="1" fill="url(#wl)"/>${surface}${waterStars}${reflection}
${rays}${seaweed(gust ? 0.6 : 2.4)}${bubbles}${lilies}${two(mistLayer(0, pal.mist), mistLayer(1, pal.mist), 3.4)}
${patrol('kohaku', 128, 34, 110, 30, 0.1)}${patrol('ogon', 158, 38, 106, 36, 0.55)}${patrol('tancho', 176, 44, 96, 26, 0.3, 0.85)}
${patrol('showa', 134, 254, 310, 23, 0.2)}${patrol('sanke', 164, 258, 312, 27, 0.7)}
${cruise('asagi', 146, 1, 80, 0.3, 0.45)}${cruise('chagoi', 172, -1, 95, 0.75, 0.4)}${reacts.water}
${dockLamp}${moths}<g transform="translate(10 0)">${fisherman(p)}</g>${fireflies}${reacts.air}
</svg>`
}

// ═══════════════════════════ STATE AND EVENTS ═══════════════════════════

const SCENE_ID = 'koi-moon-pond'
const pond = atom(
  { plugin: 'koi-moon-pond', key: 'pond' } as const,
  { view: 'side', mood: 'idle', catches: 0, since: 0, time: 'auto', phase: phaseAt(new Date()) } as Pond,
  {
  shape: 'pond-2',
})

const MOODS: Mood[] = ['idle', 'typing', 'cast', 'watch', 'reel', 'lantern', 'mend', 'catch', 'snap', 'sleep']
// The app's own bookkeeping (task lists, tool loading, questions) is not work he should react to.
const IGNORED_TOOLS = /^mcp__ccd_|^(TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskStop|ToolSearch|Skill|AskUserQuestion|EnterPlanMode|ExitPlanMode)$/
const READ_TOOLS = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|NotebookRead)$|^mcp__.*(read|get|list|search|find|query|fetch)/i
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/
const RUN_TOOLS = /^(Bash|PowerShell|Agent|Task|Workflow|Monitor)$/
const moodForTool = (tool: string): Mood | undefined =>
  IGNORED_TOOLS.test(tool) ? undefined : READ_TOOLS.test(tool) ? 'lantern' : EDIT_TOOLS.test(tool) ? 'mend' : RUN_TOOLS.test(tool) ? 'reel' : undefined

// Each change of mood rebuilds the backdrop, so moods change at most once per
// DWELL; a newer request inside that window replaces a waiting one.
const DWELL = 1500
let current: Mood = 'idle'
let lastApplied = 0
let waiting: Timer | undefined
let follow: Timer | undefined
let dozing: Timer | undefined

type Engine = EngineInterface
const apply = async ($: Engine, mood: Mood, then?: [Mood, number]): Promise<void> => {
  waiting = undefined
  follow?.cancel()
  follow = undefined
  dozing?.cancel()
  dozing = undefined
  lastApplied = Date.now()
  if (mood !== current || mood === 'catch' || mood === 'cast') {
    current = mood
    await update($, pond, p => ({ ...p, mood, since: Date.now() / 1000, catches: p.catches + (mood === 'catch' ? 1 : 0) }))
  }
  if (then) follow = $.clock.after(then[1], () => void go($, then[0]))
  if (mood === 'idle') dozing = $.clock.after(120_000, () => void go($, 'sleep'))
}
const go = async ($: Engine, mood: Mood, then?: [Mood, number]): Promise<void> => {
  waiting?.cancel()
  const wait = mood === 'catch' || mood === 'cast' ? 0 : lastApplied + DWELL - Date.now()
  if (wait > 0) {
    waiting = $.clock.after(wait, () => void apply($, mood, then))
    return
  }
  await apply($, mood, then)
}

// The glass behind the chat thickens a little in brighter phases, to keep text readable.
const lookFor = (ph: Phase): ThemeSetArgs => ({
  colors: theme,
  overrideColorScheme: 'dark',
  backdrop: { scene: SCENE_ID, glass: { blur: 1, tint: '#08111e', opacity: PAL[ph].glass } },
})
const PHASES: Phase[] = ['dawn', 'day', 'dusk', 'night']

// Follow the clock: when the phase turns (four times a day), redraw once.
const tick = async ($: Engine): Promise<void> => {
  const p = await read($, pond)
  const ph = p.time === 'auto' ? phaseAt(new Date()) : p.time
  if (ph === p.phase) return
  await update($, pond, q => ({ ...q, phase: ph }))
  await $.theme.set(lookFor(ph))
}
let clock: Timer | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const unpainted = problems.find(line => line.startsWith("Desktop won't paint"))
    if (unpainted !== undefined) $.ui.toast(unpainted)

    const start = await read($, pond)
    const ph = start.time === 'auto' ? phaseAt(new Date()) : start.time
    if (ph !== start.phase) await update($, pond, q => ({ ...q, phase: ph }))
    const set = await $.theme.set(lookFor(ph))
    if (!set.isDrawn) $.ui.status(set.reason)
    clock?.cancel()
    clock = $.clock.every(120_000, () => void tick($))
    await $.command.register({ name: 'koi-time', description: 'Pick the time of day for the koi pond (dawn | day | dusk | night | auto)' })
    await $.command.register({ name: 'koi-view', description: 'Switch the koi pond between side view and top-down view (side | top)' })
    await $.command.register({ name: 'fisherman', description: `Show one of the fisherman's moods (${MOODS.join(', ')})` })
    // A reload of this mod (or a restart) can land mid-reaction, often right as a
    // turn ends and the catch plays: let a short reaction finish, then rest.
    const saved = await read($, pond)
    current = saved.mood
    const lasting: Partial<Record<Mood, number>> = { catch: 9, snap: 5, cast: 2 }
    const left = (lasting[saved.mood] ?? 0) - (Date.now() / 1000 - saved.since)
    if (left > 0) follow = $.clock.after(left * 1000, () => void go($, saved.mood === 'cast' ? 'watch' : 'idle'))
    else if (saved.mood !== 'idle' && saved.mood !== 'sleep') void go($, 'idle')

    return next(e)
  })

  on('command.run', { command: 'koi-time' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const time = (arg === 'auto' || (PHASES as string[]).includes(arg) ? arg : '') as TimeSetting | ''
    if (time === '') {
      const p = await read($, pond)
      return { text: `Koi pond time: ${p.time === 'auto' ? `auto (now ${p.phase})` : p.time}. Pick one: ${PHASES.join(', ')} or auto.` }
    }
    const ph = time === 'auto' ? phaseAt(new Date()) : time
    await update($, pond, q => ({ ...q, time, phase: ph, view: 'side' as View }))
    await $.theme.set(lookFor(ph))
    return { text: time === 'auto' ? `Koi pond: following the clock (now ${ph}).` : `Koi pond: ${ph}, held until /koi-time auto.` }
  })

  on('command.run', { command: 'koi-view' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const now = await read($, pond)
    const view: View = arg === 'top' || arg === 'side' ? arg : now.view === 'side' ? 'top' : 'side'
    await update($, pond, p => ({ ...p, view }))
    return { text: `Koi pond: ${view === 'side' ? 'side view, with the fisherman' : 'top-down view'}.` }
  })

  on('command.run', { command: 'fisherman' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase() as Mood
    if (!MOODS.includes(arg)) return { text: `Moods: ${MOODS.join(', ')}. For example: /fisherman catch` }
    await update($, pond, p => ({ ...p, view: 'side' as View }))
    lastApplied = 0
    await go($, arg, arg === 'catch' || arg === 'snap' || arg === 'cast' ? ['idle', 9000] : undefined)
    return { text: `The fisherman: ${arg}.` }
  })

  // typing in the prompt box (the terminal raises this; the desktop box may not)
  on('prompt.edit', ($, e, next) => {
    if (current === 'idle' || current === 'sleep' || current === 'typing') void go($, 'typing', ['idle', 6000])
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    void go($, 'cast', ['watch', 1800])
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined && current !== 'cast') void go($, 'watch')
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const mood = moodForTool(e.tool)
    if (mood) void go($, mood)
    const result = await next(e)
    if (mood && (result as { isError?: boolean }).isError === true) void go($, 'snap', ['watch', 3000])
    return result
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.reason === 'answer') void go($, 'catch', ['idle', 9000])
      else if (e.reason === 'error' || e.reason === 'aborted') void go($, 'snap', ['idle', 5000])
      else void go($, 'idle')
    }
    return next(e)
  })

  on('ui.render', { component: 'Backdrop' }, async ($, e, next) => {
    if (e.surface !== 'desktop' && e.surface !== 'mobile') return next(e)
    if (e.props.scene !== SCENE_ID) return next(e)

    const p = await read($, pond)
    NOW = Date.now() / 1000
    SINCE = Math.max(0, NOW - p.since)
    const { Svg } = $.ui.resolve(e)
    return p.view === 'top' ? (
      <Svg source={buildTop()} alt="A pixel-art koi pond under moonlight, seen from above" isInteractive />
    ) : (
      <Svg source={buildSide(p)} alt={`A pixel-art moonlit pond seen from the side: koi below the waterline, and a fisherman on the dock (${p.mood})`} isInteractive />
    )
  })
}
