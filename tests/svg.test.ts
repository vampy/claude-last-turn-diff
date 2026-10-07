import { describe, expect, test } from 'claude-code/testing'

import { drawHunks, FILE_SVG_CAP, lex, SVG_CAP, syntaxOf, wrap } from '../hooks/svg'
import { svgRows } from './parse'

const TS = syntaxOf('a.ts')

describe('lex', () => {
  test('colors keywords, types, calls, strings, numbers and comments', () => {
    expect(lex('const x = Foo.bar("a", 1) // note', TS, false)).toEqual([
      [
        ['k', 'const'],
        ['', ' x = '],
        ['t', 'Foo'],
        ['', '.'],
        ['f', 'bar'],
        ['', '('],
        ['s', '"a"'],
        ['', ', '],
        ['n', '1'],
        ['', ') '],
        ['c', '// note'],
      ],
      false,
    ])
  })

  test('a block comment carries to the next line; a doc comment line counts as one', () => {
    expect(lex('let a /* open', TS, false)).toEqual([[['k', 'let'], ['', ' a '], ['c', '/* open']], true])
    expect(lex('still */ b', TS, true)).toEqual([[['c', 'still */'], ['', ' b']], false])
    expect(lex(' * @param x', TS, false)).toEqual([[['c', ' * @param x']], true])
    expect(lex(' */', TS, false)).toEqual([[['c', ' */']], false])
  })

  test('hash and dash comments by extension or name; plain text stays plain', () => {
    expect(lex('def f(): # note', syntaxOf('a.py'), false)).toEqual([
      [['k', 'def'], ['', ' '], ['f', 'f'], ['', '(): '], ['c', '# note']],
      false,
    ])
    expect(lex('select 1 -- x', syntaxOf('q.sql'), false)).toEqual([[['', 'select '], ['n', '1'], ['', ' '], ['c', '-- x']], false])
    expect(syntaxOf('build/Makefile')).toBe(syntaxOf('a.sh'))
    expect(lex('# Title "quoted"', syntaxOf('README.md'), false)).toEqual([[['', '# Title "quoted"']], false])
  })
})

describe('drawHunks', () => {
  test('numbers each line in its own file, marks and colors rows, escapes text and expands tabs', () => {
    const hunk = { oldStart: 9, oldLines: 3, newStart: 9, newLines: 3, lines: [' a<b', '-\tx && y', '+\tx || y', ' end'] }
    const { hunks, hidden } = drawHunks('a.ts', [hunk], 80)
    expect(hidden).toBe(0)
    expect(hunks.map(drawn => [drawn.header, drawn.images.length])).toEqual([['@@ -9,3 +9,3 @@', 1]])
    const source = hunks[0]!.images[0]!
    expect(svgRows(source)).toEqual([' 9   a<b', '10 -     x && y', '10 +     x || y', '11   end'])
    expect(source).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    expect(source).toContain('a&lt;b')
    expect(source).toContain('class="rr"')
    expect(source).toContain('class="ra"')
    // what Copy takes: the lines as they are now, as the file has them
    expect(hunks[0]!.code).toBe('a<b\n\tx || y\nend')
  })

  test('each hunk is drawn on its own, with its own header and code', () => {
    const first = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] }
    const second = { oldStart: 20, oldLines: 2, newStart: 20, newLines: 1, lines: [' keep', '-gone'] }
    const { hunks } = drawHunks('a.txt', [first, second], 80)
    expect(hunks.map(({ header, images, code }) => [header, images.flatMap(svgRows), code])).toEqual([
      ['@@ -1,1 +1,1 @@', [' 1 - a', ' 1 + A'], 'A'],
      ['@@ -20,2 +20,1 @@', ['20   keep', '21 - gone'], 'keep'],
    ])
  })

  test('a long line wraps under its number, after a space when one leaves the row half full', () => {
    const lines = [`+${'a'.repeat(45)}`, '+alpha beta gamma delta epsilon zeta']
    const hunk = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines }
    // 24 columns: 4 for the gutter and room, 20 for code
    expect(svgRows(drawHunks('a.txt', [hunk], 24).hunks[0]!.images[0]!)).toEqual([
      `1 + ${'a'.repeat(20)}`,
      `    ${'a'.repeat(20)}`,
      `    ${'a'.repeat(5)}`,
      '2 + alpha beta gamma ',
      '    delta epsilon zeta',
    ])
    // a cut keeps each part's color
    expect(wrap([['k', 'const'], ['', ' x = '], ['s', `"${'a'.repeat(23)}"`]], 20)).toEqual([
      [['k', 'const'], ['', ' x = '], ['s', `"${'a'.repeat(9)}`]],
      [['s', `${'a'.repeat(14)}"`]],
    ])
  })

  test('splits a hunk over images under SVG_CAP, counts what is past FILE_SVG_CAP, and copies every line', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `+${String(i).padStart(3, '0')}${'x'.repeat(900)}`)
    const { hunks, hidden } = drawHunks('a.txt', [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 200, lines }], 1000)
    const sources = hunks[0]!.images
    expect(sources).toHaveLength(2)
    for (const source of sources) {
      expect(source.length).toBeLessThanOrEqual(SVG_CAP)
      // each source is a document of its own, its rows from the top
      expect(source).toMatch(/<g transform="translate\(4 0\)"><text y="17"/)
    }
    expect(sources[0]!.length + sources[1]!.length).toBeLessThanOrEqual(FILE_SVG_CAP)
    const rows = sources.flatMap(svgRows)
    expect(rows.map(row => row.slice(0, 9))).toEqual(
      Array.from({ length: rows.length }, (_, i) => `${String(i + 1).padStart(3)} + ${String(i).padStart(3, '0')}`),
    )
    expect(rows.length + hidden).toBe(200)
    expect(hidden).toBeGreaterThan(0)
    expect(hunks[0]!.code.split('\n')).toHaveLength(200)
  })
})
