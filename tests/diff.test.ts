import { describe, expect, test } from 'claude-code/testing'

import { blocks, CODE_CAP, diffFile, diffLines, MAX_CELLS, MAX_EDITS, MAX_SIZE, myers, runHunks, toHunks } from '../hooks/diff'
import type { FileInput } from '../hooks/diff'
import type { Hunk } from '../types'
import { parseHunks } from './parse'

const file = (before: string | null, after: string | null | undefined, more: Partial<FileInput> = {}) =>
  diffFile({ path: 'a.txt', before, after, isNew: false, added: 0, removed: 0, ...more })

/** `count` numbered lines, each ending in a newline. */
const numbered = (count: number, tag = 'line') =>
  Array.from({ length: count }, (_, i) => `${tag} ${i + 1}\n`).join('')

describe('diff', () => {
  test('runHunks numbers removed runs by the old file, the rest by the new, and caps runs and headers per file', () => {
    const h: Hunk = { oldStart: 10, oldLines: 5, newStart: 20, newLines: 5, lines: [' a', '-b', '+B', '+C', ' c', ' d', '-e'] }
    expect(runHunks([h])).toEqual({
      hunks: [
        {
          header: '@@ -10,5 +20,5 @@',
          runs: [
            { kind: ' ', start: 20, lines: ['a'] },
            { kind: '-', start: 11, lines: ['b'] },
            { kind: '+', start: 21, lines: ['B', 'C'] },
            { kind: ' ', start: 23, lines: ['c', 'd'] },
            { kind: '-', start: 14, lines: ['e'] },
          ],
        },
      ],
      hidden: 0,
    })
    // a header and three runs fit: the rest of the hunk and all of the next are counted, changed lines only
    const capped = runHunks([h, h], 4)
    expect(capped.hunks.map(one => one.runs.map(run => run.kind))).toEqual([[' ', '-', '+']])
    expect(capped.hidden).toBe(1 + 4)
  })

  test('runHunks cuts a run whose marked source would pass CODE_CAP, numbering on across the cut', () => {
    // empty lines: two characters each in the diff text, three once marked, so a split hunk's run overflows
    const diff = file('x\n', '\n'.repeat(6000))
    const runs = runHunks(diff?.hunks ?? []).hunks.flatMap(hunk => hunk.runs)
    for (const run of runs) expect(run.lines.map(line => `${run.kind} ${line}`).join('\n').length).toBeLessThanOrEqual(CODE_CAP)
    const added = runs.filter(run => run.kind === '+')
    expect(added.reduce((n, run) => n + run.lines.length, 0)).toBe(6000)
    added.slice(1).forEach((run, i) => expect(run.start).toBe(added[i]!.start + added[i]!.lines.length))
  })

  test('insert', () => {
    const diff = file('a\nb\nc\n', 'a\nb\nX\nc\n')
    expect(diff?.hunks).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' a', ' b', '+X', ' c'] },
    ])
    expect([diff?.added, diff?.removed]).toEqual([1, 0])
    expect(blocks(diff?.hunks ?? [])).toEqual(['@@ -1,3 +1,4 @@\n a\n b\n+X\n c'])
  })

  test('delete', () => {
    const diff = file('a\nb\nc\nd\n', 'a\nd\n')
    expect(blocks(diff?.hunks ?? [])).toEqual(['@@ -1,4 +1,2 @@\n a\n-b\n-c\n d'])
    expect([diff?.added, diff?.removed]).toEqual([0, 2])
  })

  test('replace', () => {
    const diff = file('a\nb\nc\n', 'a\nB\nc\n')
    expect(blocks(diff?.hunks ?? [])).toEqual(['@@ -1,3 +1,3 @@\n a\n-b\n+B\n c'])
  })

  test('two hunks', () => {
    const before = numbered(20)
    const after = before.replace('line 2\n', 'line two\n').replace('line 18\n', 'line eighteen\n')
    const diff = file(before, after)
    expect(diff?.hunks.map(h => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 5, 1, 5],
      [15, 6, 15, 6],
    ])
    expect([diff?.added, diff?.removed]).toEqual([2, 2])
  })

  test('changes 6 lines apart share one hunk, 7 apart do not', () => {
    const before = numbered(30)
    const near = before.replace('line 5\n', 'x\n').replace('line 12\n', 'y\n')
    const far = before.replace('line 5\n', 'x\n').replace('line 13\n', 'y\n')
    expect(file(before, near)?.hunks).toHaveLength(1)
    expect(file(before, far)?.hunks).toHaveLength(2)
  })

  test('new file', () => {
    const diff = file('', 'a\nb\n', { isNew: true })
    expect(diff?.badges).toEqual(['new'])
    expect(blocks(diff?.hunks ?? [])).toEqual(['@@ -0,0 +1,2 @@\n+a\n+b'])
  })

  test('deleted file', () => {
    const diff = file('a\nb\n', null)
    expect(diff?.badges).toEqual(['deleted'])
    expect(blocks(diff?.hunks ?? [])).toEqual(['@@ -1,2 +0,0 @@\n-a\n-b'])
  })

  test('a file made and removed in one turn is no change', () => {
    expect(file('', null, { isNew: true })).toBe(null)
  })

  test('an unchanged file is no change', () => {
    expect(file('a\r\nb\r\n', 'a\r\nb\r\n')).toBe(null)
  })

  test('a change of line endings alone is listed and flagged', () => {
    const diff = file('a\r\nb\r\n', 'a\nb\n')
    expect(diff?.hunks).toEqual([])
    expect(diff?.badges).toEqual(['CRLF→LF'])
    expect(diff?.notes).toEqual(['line endings changed (CRLF→LF)'])
  })

  test('mixed endings normalized by an edit: the content change and the flag', () => {
    const diff = file('one\r\ntwo\nthree\r\nfour\n', 'ONE\ntwo\nthree\nfour\n')
    expect(blocks(diff?.hunks ?? [])).toEqual(['@@ -1,4 +1,4 @@\n-one\n+ONE\n two\n three\n four'])
    expect(diff?.badges).toEqual(['mixed→LF'])
  })

  test('line endings moved between lines are still noted', () => {
    const diff = file('a\r\nb\n', 'a\nb\r\n')
    expect(diff?.hunks).toEqual([])
    expect(diff?.notes).toEqual(['line endings changed'])
  })

  test('the newline at the end of the file', () => {
    expect(file('a\nb', 'a\nb\n')?.notes).toEqual(['newline added at end of file'])
    expect(file('a\nb\n', 'a\nb')?.notes).toEqual(['no newline at end of file'])
  })

  test('the LCS just under the cell cap stays well inside the hook budget', () => {
    const before = numbered(1400, 'a')
    const after = numbered(1400, 'b').replace('b 700\n', 'a 700\n')
    const started = performance.now()
    const diff = file(before, after)
    const ms = performance.now() - started
    expect(diff?.removed).toBe(1399)
    expect(ms).toBeLessThan(3000)
  })

  test('too large to diff: counts from the tools', () => {
    const huge = 'x'.repeat(MAX_SIZE + 1)
    expect(file(huge, 'y', { added: 3, removed: 1 })).toEqual({
      path: 'a.txt',
      added: 3,
      removed: 1,
      badges: ['too large'],
      notes: ['too large to diff'],
      hunks: [],
    })
    expect(file(null, 'y', { added: 2, removed: 0 })?.notes).toEqual(['too large to diff'])
    expect(file('a', undefined)?.badges).toEqual(['too large'])
  })

  test('every Code source holds at most 10,000 characters and parses as hunks', () => {
    const long = `${'w'.repeat(5000)}\n`
    const cases = [
      file('', numbered(5000), { isNew: true }), // one huge hunk, split
      file(numbered(3000), numbered(3000).replace(/line (\d*7)\n/g, 'LINE $1\n')), // many hunks
      file('a\n', `a\n${long.repeat(20)}`), // lines past LINE_CAP
    ]
    for (const diff of cases) {
      const sources = blocks(diff?.hunks ?? [])
      expect(sources.length).toBeGreaterThan(1)
      for (const source of sources) {
        expect(source.length).toBeLessThanOrEqual(CODE_CAP)
        expect(parseHunks(source)).toBeGreaterThan(0)
      }
    }
  })

  test('a file past FILE_CAP keeps the start and says how much is left out', () => {
    const diff = file('', numbered(20000), { isNew: true })
    expect(diff?.added).toBe(20000)
    const shown = diff?.hunks.reduce((sum, h) => sum + h.newLines, 0) ?? 0
    expect(shown).toBeLessThan(20000)
    expect(diff?.notes).toEqual([`${20000 - shown} more changed lines not shown`])
  })
})

/** A seeded random number in [0, 1), so a failing case runs the same again. */
const random = (seed: number) => () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32

/** The LCS length by the textbook table, a row at a time: the shortest diff changes n + m − 2·LCS lines. */
function lcsLength<T>(a: readonly T[], b: readonly T[]): number {
  let row = new Uint32Array(b.length + 1)
  for (const line of a) {
    const next = new Uint32Array(b.length + 1)
    for (let j = 0; j < b.length; j++) next[j + 1] = line === b[j] ? row[j]! + 1 : Math.max(row[j + 1]!, next[j]!)
    row = next
  }
  return row[b.length]!
}

/** The cells an LCS of the middle would take: what is left once the common start and end are trimmed. */
function middleCells(a: readonly string[], b: readonly string[]): number {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  return (a.length - start - end) * (b.length - start - end)
}

/** The old lines with the hunks applied, each hunk checked against them: its header, context and removed lines. */
function apply(old: readonly string[], hunks: readonly Hunk[]): string[] {
  const out: string[] = []
  let at = 0
  for (const h of hunks) {
    expect(h.oldStart - 1).toBeGreaterThanOrEqual(at)
    while (at < h.oldStart - 1) out.push(old[at++]!)
    expect(h.newStart - 1).toBe(out.length)
    expect(h.oldLines).toBe(h.lines.filter(line => !line.startsWith('+')).length)
    expect(h.newLines).toBe(h.lines.filter(line => !line.startsWith('-')).length)
    for (const line of h.lines) {
      if (line.startsWith('+')) {
        out.push(line.slice(1))
        continue
      }
      expect(old[at]).toBe(line.slice(1))
      if (line.startsWith(' ')) out.push(old[at]!)
      at++
    }
  }
  return [...out, ...old.slice(at)]
}

/** The ops as runs of one kind: [kind, length] each. */
function runs(ops: ReturnType<typeof diffLines>): [string, number][] {
  const out: [string, number][] = []
  for (const [kind] of ops) {
    const last = out[out.length - 1]
    if (last?.[0] === kind) last[1]++
    else out.push([kind, 1])
  }
  return out
}

describe('diff past the LCS cell cap', () => {
  test('myers on every pair of sequences of up to 5 of 3 letters: matched pairs in order, as many as an LCS has', () => {
    const all: number[][] = [[]]
    for (let at = 0; all[at]!.length < 5; at++) for (const letter of [0, 1, 2]) all.push([...all[at]!, letter])
    expect(all).toHaveLength(364)
    const wrong: string[] = []
    for (const x of all) {
      for (const y of all) {
        const same = myers(x, y)
        const isMatch = ([i, j]: [number, number], at: number) =>
          x[i] === y[j] && (at === 0 || (i > same![at - 1]![0] && j > same![at - 1]![1]))
        if (same?.every(isMatch) !== true || same.length !== lcsLength(x, y)) {
          wrong.push(`${x.join('')} → ${y.join('')}: ${JSON.stringify(same)}`)
        }
      }
    }
    expect(wrong.slice(0, 5)).toEqual([])
  })

  test('two one-line edits 3,000 lines apart show as two small hunks, not every line between them', () => {
    // as reported: a 3,071-line doc edited at lines 53 and 3063, shown whole as removed and added
    const before = numbered(3071)
    const after = before.replace('line 53\n', 'LINE 53\n').replace('line 3063\n', 'LINE 3063\n')
    const diff = file(before, after)
    expect([diff?.added, diff?.removed]).toEqual([2, 2])
    expect(diff?.notes).toEqual([])
    expect(blocks(diff?.hunks ?? [])).toEqual([
      [
        '@@ -50,7 +50,7 @@',
        ...[' line 50', ' line 51', ' line 52', '-line 53', '+LINE 53', ' line 54', ' line 55', ' line 56'],
        '@@ -3060,7 +3060,7 @@',
        ...[' line 3060', ' line 3061', ' line 3062', '-line 3063', '+LINE 3063', ' line 3064', ' line 3065', ' line 3066'],
      ].join('\n'),
    ])
  })

  test('an insertion near the start and a deletion near the end: their counts and line numbers', () => {
    const before = numbered(4000)
    const after = before.replace('line 10\n', 'line 10\nnew a\nnew b\nnew c\n').replace('line 3990\nline 3991\n', '')
    const diff = file(before, after)
    expect([diff?.added, diff?.removed]).toEqual([3, 2])
    // the deletion's old line 3987 is new line 3990, after the 3 lines inserted
    expect(blocks(diff?.hunks ?? [])).toEqual([
      [
        '@@ -8,6 +8,9 @@',
        ...[' line 8', ' line 9', ' line 10', '+new a', '+new b', '+new c', ' line 11', ' line 12', ' line 13'],
        '@@ -3987,8 +3990,6 @@',
        ...[' line 3987', ' line 3988', ' line 3989', '-line 3990', '-line 3991', ' line 3992', ' line 3993', ' line 3994'],
      ].join('\n'),
    ])
  })

  test('a replaced block shows its removed lines before its added ones', () => {
    const before = numbered(3000)
    const after = before.replace('line 100\nline 101\n', 'new 1\nnew 2\nnew 3\n').replace('line 2900\n', 'LINE 2900\n')
    const diff = file(before, after)
    expect([diff?.added, diff?.removed]).toEqual([4, 3])
    expect(diff?.hunks[0]?.lines).toEqual([
      ...[' line 97', ' line 98', ' line 99', '-line 100', '-line 101'],
      ...['+new 1', '+new 2', '+new 3', ' line 102', ' line 103', ' line 104'],
    ])
  })

  test('a 1,010-line section moved 2,000 lines up shows as removed and added once, not every line between', () => {
    const lines = numbered(3071).split('\n').slice(0, -1)
    const section = lines.slice(2000, 3010)
    const rest = [...lines.slice(0, 2000), ...lines.slice(3010)]
    const moved = [...rest.slice(0, 50), ...section, ...rest.slice(50)]
    expect(runs(diffLines(lines, moved))).toEqual([
      [' ', 50],
      ['+', 1010],
      [' ', 1950],
      ['-', 1010],
      [' ', 61],
    ])
  })

  test('changes all through a file of repeated lines: a shortest diff, whose hunks turn the old lines into the new', () => {
    // blank lines and braces repeat, so many alignments are equally short
    const POOL = ['', '', '', '}', '}', '{', '  return x', 'end']
    const next = random(42)
    const pick = () => POOL[Math.floor(next() * POOL.length)]!
    for (let round = 0; round < 12; round++) {
      const a = Array.from({ length: 1500 + Math.floor(next() * 500) }, pick)
      const b = [...a]
      // one change at each end keeps the middle past the cell cap, the rest anywhere
      b.splice(Math.floor(next() * 5), 0, 'first')
      b.splice(b.length - Math.floor(next() * 5), 0, 'last')
      for (let edits = Math.floor(next() * 40); edits > 0; edits--) {
        const at = Math.floor(next() * b.length)
        const what = next()
        if (what < 1 / 3) b.splice(at, 1)
        else if (what < 2 / 3) b.splice(at, 0, pick())
        else b[at] = pick()
      }
      expect(middleCells(a, b)).toBeGreaterThan(MAX_CELLS)
      const ops = diffLines(a, b)
      expect(ops.filter(([kind]) => kind !== '+').map(([, line]) => line)).toEqual(a)
      expect(ops.filter(([kind]) => kind !== '-').map(([, line]) => line)).toEqual(b)
      expect(ops.filter(([kind]) => kind !== ' ').length).toBe(a.length + b.length - 2 * lcsLength(a, b))
      expect(apply(a, toHunks(ops))).toEqual(b)
    }
  })

  test('up to MAX_EDITS changed lines show line by line; one more, and the middle is one delete block and one insert block', () => {
    const size = 2 * MAX_EDITS
    const base = Array.from({ length: size }, (_, i) => `line ${i + 1}`)
    /** base with `count` new lines spread from before its first line to before its last but one. */
    const spread = (count: number) => {
      const out = [...base]
      for (let t = count - 1; t >= 0; t--) out.splice(Math.floor((t * size) / count), 0, `new ${t}`)
      return out
    }
    const within = runs(diffLines(base, spread(MAX_EDITS)))
    expect(within.filter(([kind]) => kind !== ' ')).toEqual(Array.from({ length: MAX_EDITS }, () => ['+', 1]))
    // past it nothing is matched but the two lines after the last new one: one more line added...
    expect(runs(diffLines(base, spread(MAX_EDITS + 1)))).toEqual([
      ['-', size - 2],
      ['+', size - 2 + MAX_EDITS + 1],
      [' ', 2],
    ])
    // ...or one removed, which leaves the lengths less than MAX_EDITS apart
    expect(runs(diffLines(base, spread(MAX_EDITS).filter(line => line !== 'line 2')))).toEqual([
      ['-', size - 2],
      ['+', size - 3 + MAX_EDITS],
      [' ', 2],
    ])
  })

  test('lines matching along every diagonal make Myers give up within its budget, not run on for seconds', () => {
    // ~2 MiB a side, under 2,000 changed lines, yet each diagonal follows long runs of matches: about n·D steps
    const tail = Array.from({ length: 1_048_000 - 999 }, (_, i) => (i % 2 === 0 ? '1' : '0'))
    const x = ['9', ...Array<string>(997).fill('0'), ...tail, '7']
    const y = ['8', ...Array<string>(997).fill('1'), ...tail, '6']
    const started = performance.now()
    const ops = diffLines(x, y)
    const ms = performance.now() - started
    // nothing in common at either end, so nothing is matched
    expect(runs(ops)).toEqual([
      ['-', 1_048_000],
      ['+', 1_048_000],
    ])
    expect(ms).toBeLessThan(3000)
  })

  test('a rewrite of a file near MAX_SIZE gives up quickly: one delete block and one insert block', () => {
    const tag = (word: string) => word.padEnd(40, '.')
    const before = `same\n${numbered(40000, tag('old'))}same\n`
    const after = `same\n${numbered(40000, tag('new'))}same\n`
    expect(after.length).toBeLessThan(MAX_SIZE)
    const started = performance.now()
    const diff = file(before, after)
    const ms = performance.now() - started
    expect([diff?.added, diff?.removed]).toEqual([40000, 40000])
    expect(diff?.hunks[0]?.lines.slice(0, 2)).toEqual([' same', `-${tag('old')} 1`])
    expect(ms).toBeLessThan(3000)
  })
})
