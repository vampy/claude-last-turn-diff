import type { FileDiff, Hunk } from '../types'

/** Context lines around each change. */
const CONTEXT = 3
/** Past this many LCS cells the changed middle goes to a Myers diff instead. */
export const MAX_CELLS = 2_000_000
/** Past this many changed lines (added and removed) Myers gives up: one delete block and one insert block. */
export const MAX_EDITS = 4_000
/** Past this many steps (diagonals tried, lines matched along them) Myers gives up too: about 0.2 s in the hook. */
export const MAX_WORK = 10 * MAX_CELLS
/** Files larger than this (bytes on disk, characters in memory) are not diffed. */
export const MAX_SIZE = 2 * 1024 * 1024
/** What one `Code` source may hold. */
export const CODE_CAP = 10_000
/** Diff text kept per file; past it hunks are counted, not shown. */
export const FILE_CAP = 60_000
/** Longer lines are cut for display, so one line always fits a Code source. */
const LINE_CAP = 2_000
/** Room left for a hunk header when filling a Code source. */
const HEADER_ROOM = 64

type Op = readonly [kind: ' ' | '-' | '+', text: string]

/** The lines of a text without their `\n` or `\r\n`; a final newline ends the last line. */
export function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

export function eolStyle(text: string): 'CRLF' | 'LF' | 'mixed' | 'none' {
  let lf = 0
  let crlf = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    lf++
    if (text[i - 1] === '\r') crlf++
  }
  return lf === 0 ? 'none' : crlf === 0 ? 'LF' : crlf === lf ? 'CRLF' : 'mixed'
}

/**
 * The [i, j] pairs of the lines x and y keep in a shortest diff, in order; null past MAX_EDITS changed lines or
 * MAX_WORK steps. Myers' greedy walk costs about n + m + D² for D changed lines, so edits far apart in a large file
 * cost little, but lines that match along many diagonals (a file of repeated lines) can take it to (n + m)·D.
 */
export function myers(x: ArrayLike<number>, y: ArrayLike<number>): [number, number][] | null {
  const n = x.length
  const m = y.length
  let work = 0
  // furthest[off + k]: how far into x a walk with the changes so far reaches on diagonal k = i - j
  const off = MAX_EDITS + 1
  const furthest = new Int32Array(2 * off + 1)
  // trace[d][(k + d) / 2]: furthest[off + k] after d changes, k from -d to d in steps of 2
  // ponytail: the trace holds about MAX_EDITS²/2 numbers (32 MB); Myers' linear-space variant if MAX_EDITS must grow
  const trace: Int32Array[] = []
  for (let d = 0; d <= MAX_EDITS; d++) {
    const row = new Int32Array(d + 1)
    for (let k = -d; k <= d; k += 2) {
      // from diagonal k + 1 with an added line, or from k - 1 with a removed one, whichever reached further
      const isAdd = k === -d || (k !== d && furthest[off + k - 1]! < furthest[off + k + 1]!)
      let i = isAdd ? furthest[off + k + 1]! : furthest[off + k - 1]! + 1
      let j = i - k
      const at = i
      while (i < n && j < m && x[i] === y[j]) {
        i++
        j++
      }
      work += 1 + i - at
      furthest[off + k] = i
      row[(k + d) >> 1] = i
      if (i >= n && j >= m) {
        // back from the end: each change came from diagonal k ± 1 one change before, then matched lines to here
        const same: [number, number][] = []
        i = n
        j = m
        for (let e = d; e > 0; e--) {
          const was = trace[e - 1]!
          const kk = i - j
          const wasAdd = kk === -e || (kk !== e && was[(kk + e - 2) >> 1]! < was[(kk + e) >> 1]!)
          const from = wasAdd ? kk + 1 : kk - 1
          const fromI = was[(from + e - 1) >> 1]!
          while (i > (wasAdd ? fromI : fromI + 1)) same.push([--i, --j])
          i = fromI
          j = fromI - from
        }
        while (i > 0) same.push([--i, --j])
        return same.reverse()
      }
      if (work > MAX_WORK) return null
    }
    trace.push(row)
  }
  return null
}

/** A line diff: the common prefix and suffix trimmed, then an LCS over the middle, or Myers past MAX_CELLS. */
export function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const ops: Op[] = a.slice(0, start).map(line => [' ', line] as const)
  const n = endA - start
  const m = endB - start
  /** The middle's lines as numbers, equal lines alike, so comparing two costs the same whatever their length. */
  const numbers = (): [Int32Array, Int32Array] => {
    const ids = new Map<string, number>()
    const id = (line: string) => {
      let value = ids.get(line)
      if (value === undefined) ids.set(line, (value = ids.size))
      return value
    }
    return [Int32Array.from(a.slice(start, endA), id), Int32Array.from(b.slice(start, endB), id)]
  }
  if (n * m > MAX_CELLS) {
    // the lines between two matches as removed, then added; with nothing matched, one delete block and one insert block.
    // A diff changes at least |n - m| lines, so past MAX_EDITS of them Myers isn't even tried.
    const same = (Math.abs(n - m) > MAX_EDITS ? null : myers(...numbers())) ?? []
    same.push([n, m])
    let i = 0
    let j = 0
    for (const [toI, toJ] of same) {
      while (i < toI) ops.push(['-', a[start + i++]!])
      while (j < toJ) ops.push(['+', b[start + j++]!])
      // [n, m] only marks the end
      if (i < n) {
        ops.push([' ', a[start + i++]!])
        j++
      }
    }
  } else {
    const [x, y] = numbers()
    // lcs[i * w + j]: the LCS length of x[i..] and y[j..]
    const w = m + 1
    const lcs = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) {
        ops.push([' ', a[start + i++]!])
        j++
      } else if (j === m || (i < n && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
        ops.push(['-', a[start + i++]!])
      } else {
        ops.push(['+', b[start + j++]!])
      }
    }
  }
  for (const line of a.slice(endA)) ops.push([' ', line])
  return ops
}

export const cut = (text: string) => (text.length > LINE_CAP ? `${text.slice(0, LINE_CAP)}…` : text)

/** Groups a diff into unified hunks with CONTEXT lines around each run of changes. */
export function toHunks(ops: readonly Op[]): Hunk[] {
  // oldAt[i], newAt[i]: how many old and new lines come before ops[i]
  const oldAt = [0]
  const newAt = [0]
  for (const [kind] of ops) {
    oldAt.push(oldAt[oldAt.length - 1]! + (kind === '+' ? 0 : 1))
    newAt.push(newAt[newAt.length - 1]! + (kind === '-' ? 0 : 1))
  }
  const hunks: Hunk[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i]![0] === ' ') {
      i++
      continue
    }
    const start = Math.max(0, i - CONTEXT)
    let end = i + 1
    for (let j = end; j < ops.length; j++) {
      if (ops[j]![0] !== ' ') end = j + 1
      else if (j - end >= 2 * CONTEXT) break
    }
    const stop = Math.min(ops.length, end + CONTEXT)
    hunks.push({
      oldStart: oldAt[start]! + 1,
      oldLines: oldAt[stop]! - oldAt[start]!,
      newStart: newAt[start]! + 1,
      newLines: newAt[stop]! - newAt[start]!,
      lines: ops.slice(start, stop).map(([kind, text]) => kind + cut(text)),
    })
    i = stop
  }
  return hunks
}

/** The hunk's `@@` line; an empty side names the line before it, as diff does. */
export function hunkHeader(h: Hunk): string {
  const old = h.oldLines === 0 ? h.oldStart - 1 : h.oldStart
  const now = h.newLines === 0 ? h.newStart - 1 : h.newStart
  return `@@ -${old},${h.oldLines} +${now},${h.newLines} @@`
}

/** The hunk as unified-diff text. */
export const hunkText = (h: Hunk) => [hunkHeader(h), ...h.lines].join('\n')

/** Cuts a hunk too long for one Code source into consecutive hunks with their own headers. */
export function splitHunk(h: Hunk, max = CODE_CAP): Hunk[] {
  const parts: Hunk[] = []
  let part: Hunk = { oldStart: h.oldStart, oldLines: 0, newStart: h.newStart, newLines: 0, lines: [] }
  let size = HEADER_ROOM
  for (const line of h.lines) {
    if (part.lines.length > 0 && size + line.length + 1 > max) {
      parts.push(part)
      part = {
        oldStart: part.oldStart + part.oldLines,
        oldLines: 0,
        newStart: part.newStart + part.newLines,
        newLines: 0,
        lines: [],
      }
      size = HEADER_ROOM
    }
    part.lines.push(line)
    size += line.length + 1
    if (!line.startsWith('+')) part.oldLines++
    if (!line.startsWith('-')) part.newLines++
  }
  parts.push(part)
  return parts
}

/** Packs whole hunks (each already under `max`, see splitHunk) into Code sources of at most `max` characters. */
export function blocks(hunks: readonly Hunk[], max = CODE_CAP): string[] {
  const sources: string[] = []
  for (const text of hunks.map(hunkText)) {
    const last = sources.length - 1
    if (last >= 0 && sources[last]!.length + 1 + text.length <= max) sources[last] += `\n${text}`
    else sources.push(text)
  }
  return sources
}

export const textSize = (hunks: readonly Hunk[]) => hunks.reduce((sum, h) => sum + hunkText(h).length + 1, 0)

/** Groups items into pages of at most `budget` in size; an item larger than that gets a page alone. */
export function paginate(sizes: readonly number[], budget: number): number[][] {
  const pages: number[][] = []
  let size = 0
  sizes.forEach((one, i) => {
    const page = pages[pages.length - 1]
    if (page !== undefined && size + one <= budget) {
      page.push(i)
      size += one
    } else {
      pages.push([i])
      size = one
    }
  })
  return pages
}

/** Text a surface takes: control characters but tab and newline become their visible symbols, lone surrogates U+FFFD. */
export function clean(text: string): string {
  return text
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, c => String.fromCharCode(c === '\x7f' ? 0x2421 : 0x2400 + c.charCodeAt(0)))
    .replace(/[\x80-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')
}

/** One key per file however the path is spelled: forward slashes, and case-folded on a drive letter path. */
export function fileKey(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed
}

/** The path relative to `cwd` when inside it, else whole; forward slashes either way. */
export function relativePath(cwd: string, path: string): string {
  const file = path.replace(/\\/g, '/')
  const root = cwd.replace(/\\/g, '/').replace(/\/?$/, '/')
  const isInside = /^[a-z]:\//i.test(file)
    ? file.toLowerCase().startsWith(root.toLowerCase())
    : file.startsWith(root)
  return isInside ? file.slice(root.length) : file
}

export type FileInput = {
  path: string
  /** Before the turn; null when unknown (too large or unreadable). */
  before: string | null
  /** After the turn; null when the file is gone, undefined when too large or unreadable. */
  after: string | null | undefined
  isNew: boolean
  /** From the tools' structuredPatch: the counts shown when the file is too large to diff. */
  added: number
  removed: number
  /** Known binary without its content (Plastic's RevisionType, or a NUL seen at turn start). */
  isBinary?: boolean
}

/** One file's net change over the turn, or null when there is none. A null before counts as changed. */
export function diffFile(f: FileInput): FileDiff | null {
  const isDeleted = f.after === null
  if (f.isNew && isDeleted) return null
  const badges = f.isNew ? ['new'] : isDeleted ? ['deleted'] : []
  const before = f.before
  const after = f.after === null ? '' : f.after
  if (f.isBinary === true || before?.includes('\0') || after?.includes('\0')) {
    if (before === after && badges.length === 0) return null
    return { path: f.path, added: f.added, removed: f.removed, badges: [...badges, 'binary'], notes: [], hunks: [] }
  }
  if (before === null || after === undefined || before.length > MAX_SIZE || after.length > MAX_SIZE) {
    return {
      path: f.path,
      added: f.added,
      removed: f.removed,
      badges: [...badges, 'too large'],
      notes: ['too large to diff'],
      hunks: [],
    }
  }
  if (before === after && badges.length === 0) return null
  const ops = diffLines(splitLines(before), splitLines(after))
  const added = ops.filter(([kind]) => kind === '+').length
  const removed = ops.filter(([kind]) => kind === '-').length
  const notes: string[] = []
  const was = eolStyle(before)
  const now = eolStyle(after)
  if (was !== now && was !== 'none' && now !== 'none') {
    badges.push(`${was}→${now}`)
    notes.push(`line endings changed (${was}→${now})`)
  }
  if (before !== '' && after !== '' && before.endsWith('\n') !== after.endsWith('\n')) {
    notes.push(after.endsWith('\n') ? 'newline added at end of file' : 'no newline at end of file')
  }
  if (added + removed === 0 && notes.length === 0) {
    if (badges.length > 0) {
      notes.push('empty file')
    } else {
      // the bytes differ only where splitLines does not look: line endings moved around
      badges.push('EOL')
      notes.push('line endings changed')
    }
  }
  return { path: f.path, added, removed, badges, notes, hunks: capHunks(toHunks(ops), notes) }
}

/** The hunks split to fit Code sources and kept up to FILE_CAP; the changed lines past it are counted in `notes`. */
export function capHunks(all: readonly Hunk[], notes: string[]): Hunk[] {
  const hunks: Hunk[] = []
  let size = 0
  let hidden = 0
  for (const h of all.flatMap(one => splitHunk(one))) {
    size += hunkText(h).length + 1
    if (size <= FILE_CAP) hunks.push(h)
    else hidden += h.lines.filter(line => !line.startsWith(' ')).length
  }
  if (hidden > 0) notes.push(`${hidden} more changed lines not shown`)
  return hunks
}
