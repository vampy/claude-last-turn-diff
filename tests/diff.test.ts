import { describe, expect, test } from 'claude-code/testing'

import { blocks, CODE_CAP, diffFile, MAX_SIZE } from '../hooks/diff'
import type { FileInput } from '../hooks/diff'
import { parseHunks } from './parse'

const file = (before: string | null, after: string | null | undefined, more: Partial<FileInput> = {}) =>
  diffFile({ path: 'a.txt', before, after, isNew: false, added: 0, removed: 0, ...more })

/** `count` numbered lines, each ending in a newline. */
const numbered = (count: number, tag = 'line') =>
  Array.from({ length: count }, (_, i) => `${tag} ${i + 1}\n`).join('')

describe('diff', () => {
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

  test('past the cell cap the changed middle is one delete block and one insert block', () => {
    const before = `same\n${numbered(1500, 'old')}same\n`
    const after = `same\n${numbered(1500, 'new')}same\n`
    const diff = file(before, after)
    const lines = diff?.hunks.flatMap(h => h.lines) ?? []
    const kinds = lines.map(line => line[0]).join('')
    expect(kinds).toBe(` ${'-'.repeat(1500)}${'+'.repeat(1500)} `)
    expect([diff?.added, diff?.removed]).toEqual([1500, 1500])
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
