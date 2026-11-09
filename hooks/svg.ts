import type { Hunk } from '../types'
import { clean, hunkHeader } from './diff'

/**
 * Desktop draws a `Code` diff as plain `diff` text, so there each hunk is drawn as an SVG image instead: one row per
 * line, a line number and marker, red and green rows, and colors from a small lexer. An image can't be selected (an
 * interactive Svg's frame can, but Desktop rebuilds every frame on each redraw, a scroll included, and they flash
 * white), so each hunk carries its code for a Copy button.
 */

/** Layout in CSS pixels: a 12px monospace font about 0.6em wide, rows 18px apart. */
const FONT = 12
const CELL = 7.2
const ROW = 18
const BASELINE = 13
const PAD = 4
/** One Svg source at most; Desktop takes 131,072 characters. */
export const SVG_CAP = 120_000
/** Svg characters per file; past it hunks are counted, not drawn. */
export const FILE_SVG_CAP = 150_000
/** Room a row takes past its text: its `<text>` tags, and the rect its run may still add. */
const ROW_COST = 100
const FAMILY = "ui-monospace,'Cascadia Mono',Consolas,'SF Mono',Menlo,monospace"
const STYLE =
  '<style>text{white-space:pre;fill:currentColor}.g{fill-opacity:.5}.ga{fill:#3fb950}.gr{fill:#f85149}' +
  '.ra{fill:#2ea043;fill-opacity:.18}.rr{fill:#f85149;fill-opacity:.18}' +
  '.c{fill-opacity:.55;font-style:italic}.k{fill:#a855f7}.s{fill:#d97706}.n{fill:#0ea5e9}.t{fill:#14b8a6}.f{fill:#3b82f6}</style>'
const SHELL_COST = 400 + STYLE.length

type Kind = ' ' | '-' | '+'
/** A run of text and its color class: `c` comment, `s` string, `n` number, `k` keyword, `t` type, `f` call; '' plain. */
type Part = [cls: string, text: string]
/** A hunk line as drawn: its kind, its number and marker, and its parts wrapped into rows. */
type Line = { kind: Kind; gutter: string; rows: Part[][] }

const BACKGROUND: Record<Kind, string> = { ' ': '', '-': 'rr', '+': 'ra' }
const GUTTER: Record<Kind, string> = { ' ': 'g', '-': 'gr', '+': 'ga' }

const STRING = String.raw`"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|` + '`(?:[^`\\\\]|\\\\.)*`?'
const NUMBER = String.raw`\b(?:0x[\da-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b`
const lexer = (block: string, line: string) =>
  new RegExp(String.raw`(${block})|(${line}.*)|(${STRING})|(${NUMBER})|([a-z_$][\w$]*)`, 'gi')
const SLASH = lexer(String.raw`/\*`, '//')
const HASH = lexer('(?!)', '#')
const DASH = lexer('(?!)', '--')

// ponytail: three comment styles and one keyword list for every language; a real grammar if colors mislead
const SYNTAX = new Map<string, RegExp>([
  ...'c cc cpp cxx h hh hpp hxx inl cs java kt kts scala go rs swift dart js jsx mjs cjs ts tsx mts cts json jsonc css scss less php groovy gradle proto zig'
    .split(' ')
    .map(ext => [ext, SLASH] as const),
  ...'py pyi rb sh bash zsh fish ps1 psm1 psd1 yml yaml toml cmake r pl pm nix conf cfg ini dockerfile makefile mk gitignore gitattributes'
    .split(' ')
    .map(ext => [ext, HASH] as const),
  ...'sql lua hs elm'.split(' ').map(ext => [ext, DASH] as const),
])

const KEYWORDS = new Set(
  ('abstract and as async auto await bool break case catch char class const continue def default defer del delete do ' +
    'double elif else enum except export extends extern false False final finally float fn for from func function if impl ' +
    'implements import in inline int interface is lambda let long match mut namespace new nil None not null of or override ' +
    'package pass private protected pub public raise readonly return self Self short signed static struct super switch ' +
    'template this throw throws trait true True try type typeof typename undefined union unsigned unsafe use using var ' +
    'virtual void where while with yield').split(' '),
)

/** The lexer for a path's extension, or its name when it has none (`Makefile`); none for plain text. */
export function syntaxOf(path: string): RegExp | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return SYNTAX.get(name.slice(name.lastIndexOf('.') + 1))
}

/** One line's colored parts, and whether a `/*` comment is still open at its end. */
export function lex(line: string, re: RegExp | undefined, isInComment: boolean): [Part[], boolean] {
  if (re === undefined) {
    const plain: Part[] = line === '' ? [] : [['', line]]
    return [plain, false]
  }
  const parts: Part[] = []
  const add = (cls: string, text: string) => {
    const last = parts[parts.length - 1]
    if (last?.[0] === cls) last[1] += text
    else if (text !== '') parts.push([cls, text])
  }
  let at = 0
  // a hunk can start inside a doc comment: ` * text` and ` */` lines are taken as in one
  const isDocLine = re === SLASH && /^\s*\*(?:\s|\/|$)/.test(line)
  if (isInComment || isDocLine) {
    const end = line.indexOf('*/')
    if (end === -1) return [[['c', line]], true]
    add('c', line.slice(0, end + 2))
    at = end + 2
  }
  re.lastIndex = at
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    add('', line.slice(at, m.index))
    if (m[1] !== undefined) {
      const end = line.indexOf('*/', m.index + 2)
      if (end === -1) {
        add('c', line.slice(m.index))
        return [parts, true]
      }
      add('c', line.slice(m.index, end + 2))
      re.lastIndex = end + 2
    } else {
      const cls = classOf(m, line[re.lastIndex])
      add(cls, m[0])
    }
    at = re.lastIndex
  }
  add('', line.slice(at))
  return [parts, false]
}

/** The color class of a lexer match other than a block comment (see Part); `next` is the character after it. */
function classOf(m: RegExpExecArray, next: string | undefined): string {
  if (m[2] !== undefined) return 'c'
  if (m[3] !== undefined) return 's'
  if (m[4] !== undefined) return 'n'
  const word = m[5]!
  if (KEYWORDS.has(word)) return 'k'
  if (/^[A-Z]/.test(word)) return 't'
  if (next === '(') return 'f'
  return ''
}

/** Tabs as spaces to the next multiple of four columns. */
function untab(text: string): string {
  if (!text.includes('\t')) return text
  return text.replace(/[^\t]*\t/g, run => {
    const before = run.slice(0, -1)
    return before + ' '.repeat(4 - (before.length % 4))
  })
}

/**
 * Parts cut into rows of at most `width` (20 or more) characters: after the last space that leaves a row at least
 * half full, else at the width, never inside a surrogate pair.
 */
export function wrap(parts: readonly Part[], width: number): Part[][] {
  const text = parts.map(([, part]) => part).join('')
  const ends: number[] = []
  let start = 0
  while (text.length - start > width) {
    const space = text.lastIndexOf(' ', start + width - 1)
    const isPairCut = /[\ud800-\udbff]/.test(text[start + width - 1]!)
    let end = start + width
    if (space >= start + width / 2) end = space + 1
    else if (isPairCut) end = start + width - 1
    ends.push(end)
    start = end
  }
  ends.push(text.length)
  const rows: Part[][] = ends.map(() => [])
  let at = 0
  let row = 0
  for (const [cls, whole] of parts) {
    for (let from = 0; from < whole.length; ) {
      const take = Math.min(whole.length - from, ends[row]! - at)
      if (take === 0) {
        row++
        continue
      }
      rows[row]!.push([cls, whole.slice(from, from + take)])
      from += take
      at += take
    }
  }
  return rows
}

/** The hunk's lines, each under its number (the old one for a removed line) and marker. */
function hunkLines(h: Hunk, re: RegExp | undefined, digits: number, width: number): Line[] {
  const lines: Line[] = []
  let old = h.oldStart
  let now = h.newStart
  // a removed and an added line can each be inside a comment the other side does not have
  let isOldInComment = false
  let isNewInComment = false
  for (const line of h.lines) {
    const kind = line[0] as ' ' | '-' | '+'
    const text = untab(clean(line.slice(1)))
    const isInComment = kind === '-' ? isOldInComment : isNewInComment
    const [parts, isOpen] = lex(text, re, isInComment)
    if (kind !== '+') isOldInComment = isOpen
    if (kind !== '-') isNewInComment = isOpen
    const at = kind === '-' ? old : now
    const number = String(at).padStart(digits)
    lines.push({ kind, gutter: `${number} ${kind} `, rows: wrap(parts, width) })
    if (kind !== '+') old++
    if (kind !== '-') now++
  }
  return lines
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\ufffe\uffff]/g, '\ufffd')

/** The parts as SVG text, each colored one in its own tspan. */
function code(parts: readonly Part[]): string {
  const spans = parts.map(([cls, text]) => {
    if (cls === '') return escape(text)
    return `<tspan class="${cls}">${escape(text)}</tspan>`
  })
  return spans.join('')
}

/** A line's `<text>` from row `at`: the gutter, then its rows, the wrapped ones under the gutter. */
function lineText(line: Line, at: number, blank: string): string {
  const y = (row: number) => PAD + (at + row) * ROW + BASELINE
  const gutter = `<tspan class="${GUTTER[line.kind]}">${line.gutter}</tspan>`
  const first = code(line.rows[0]!)
  const rest = line.rows.slice(1).map((parts, i) => `<tspan x="0" y="${y(i + 1)}">${blank}${code(parts)}</tspan>`)
  return `<text y="${y(0)}">${gutter}${first}${rest.join('')}</text>`
}

function svgOf(rects: string, texts: string, rows: number, columns: number): string {
  const width = Math.ceil(PAD * 2 + columns * CELL)
  const height = PAD * 2 + rows * ROW
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" font-family="${FAMILY}" font-size="${FONT}">` +
    `${STYLE}${rects}<g transform="translate(${PAD} 0)">${texts}</g></svg>`
  )
}

/** One hunk as drawn: its `@@` line, its images (more than one past SVG_CAP), and its lines as they are now. */
export type DrawnHunk = { header: string; images: string[]; code: string }

/** A file's hunks drawn; `hidden` counts the changed lines past FILE_SVG_CAP. */
export type Drawing = { hunks: DrawnHunk[]; hidden: number }

/** The file's hunks drawn `columns` characters wide, long lines wrapped under their number. */
export function drawHunks(path: string, hunks: readonly Hunk[], columns: number): Drawing {
  if (hunks.length === 0) return { hunks: [], hidden: 0 }
  const re = syntaxOf(path)
  // the widest line number: each hunk's last line on its longer side
  const lastLines = hunks.map(h => Math.max(h.oldStart + h.oldLines, h.newStart + h.newLines) - 1)
  const digits = String(Math.max(...lastLines)).length
  const width = Math.max(20, columns - digits - 4)
  const blank = ' '.repeat(digits + 3)
  const drawn: DrawnHunk[] = []
  let images: string[] = []
  let rects = ''
  let texts = ''
  let count = 0
  let run: Kind = ' '
  let runStart = 0
  /** Characters in the images already pushed. */
  let done = 0
  let hidden = 0
  const pending = () => SHELL_COST + rects.length + texts.length
  const endRun = () => {
    if (BACKGROUND[run] !== '' && count > runStart) {
      const y = PAD + runStart * ROW
      const height = (count - runStart) * ROW
      rects += `<rect y="${y}" width="100%" height="${height}" class="${BACKGROUND[run]}"/>`
    }
    runStart = count
  }
  const flush = () => {
    endRun()
    if (count > 0) {
      const image = svgOf(rects, texts, count, digits + 3 + width)
      images.push(image)
      done += image.length
    }
    rects = ''
    texts = ''
    count = 0
    runStart = 0
  }
  /** The hunk drawn so far, with its whole code: a copy takes every line, drawn or not. */
  const close = (h: Hunk) => {
    flush()
    const now = h.lines.filter(line => !line.startsWith('-')).map(line => line.slice(1))
    if (images.length > 0) drawn.push({ header: hunkHeader(h), images, code: now.join('\n') })
    images = []
  }
  for (const [k, h] of hunks.entries()) {
    const lines = hunkLines(h, re, digits, width)
    for (const [i, line] of lines.entries()) {
      let text = lineText(line, count, blank)
      if (done + pending() + text.length + ROW_COST > FILE_SVG_CAP) {
        hidden = lines.slice(i).filter(rest => rest.kind !== ' ').length
        for (const rest of hunks.slice(k + 1)) {
          hidden += rest.lines.filter(source => !source.startsWith(' ')).length
        }
        close(h)
        return { hunks: drawn, hidden }
      }
      if (count > 0 && pending() + text.length + ROW_COST > SVG_CAP) {
        flush()
        text = lineText(line, 0, blank)
      }
      if (line.kind !== run) {
        endRun()
        run = line.kind
      }
      texts += text
      count += line.rows.length
    }
    close(h)
  }
  return { hunks: drawn, hidden }
}
