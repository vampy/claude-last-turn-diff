const textOf = (markup: string) =>
  markup.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** An Svg diff's rows read back as text: each `<text>`, and each of its wrapped rows (a tspan at x 0), tags dropped. */
export const svgRows = (source: string) =>
  [...source.matchAll(/<text\b[^>]*>(.*?)<\/text>/g)].flatMap(([, line]) => line!.split(/(?=<tspan x="0")/).map(textOf))

/** Reads a Code source as `format: 'diff'` must: hunks whose headers count the lines that follow. */
export function parseHunks(source: string): number {
  const rows = source.split('\n')
  let hunks = 0
  for (let i = 0; i < rows.length; ) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(rows[i++] ?? '')
    if (header === null) throw new Error(`row ${i - 1} is no hunk header: ${rows[i - 1]}`)
    let old = Number(header[2])
    let now = Number(header[4])
    while (old > 0 || now > 0) {
      const row = rows[i++]
      if (row === undefined) throw new Error('hunk cut short')
      if (row.startsWith(' ')) {
        old--
        now--
      } else if (row.startsWith('-')) old--
      else if (row.startsWith('+')) now--
      else throw new Error(`not a hunk line: ${row}`)
    }
    if (old !== 0 || now !== 0) throw new Error('hunk header counts do not match its lines')
    hunks++
  }
  return hunks
}
