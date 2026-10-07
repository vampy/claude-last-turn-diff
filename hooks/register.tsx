import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileDiff, Hunk, LastTurn } from '../types'
import { blocks, clean, diffFile, fileKey, MAX_SIZE, paginate, relativePath, textSize } from './diff'

const PANE = 'last-turn-diff'
const TITLE = 'Last turn'
/** Code text per pane draw: Desktop reportedly freezes for good on a draw past ~256 KB. */
const PAGE_BUDGET = 90_000

const turns = atom({ plugin: 'last-turn-diff', key: 'turns' } as const, 0)
const recording = atom({ plugin: 'last-turn-diff', key: 'recording' } as const, null)
const lastTurn = atom({ plugin: 'last-turn-diff', key: 'lastTurn' } as const, null)
const isBandHidden = atom({ plugin: 'last-turn-diff', key: 'isBandHidden' } as const, false)
const page = atom({ plugin: 'last-turn-diff', key: 'page' } as const, 0)
const PENDING = { plugin: 'last-turn-diff', key: 'pending' } as const

/** The file's text; null when it does not exist, undefined when too large or unreadable. */
async function snapshot($: EngineInterface, path: string): Promise<string | null | undefined> {
  if (!(await $.fs.exists(path).catch(() => true))) return null
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat?.kind !== 'file' || stat.size > MAX_SIZE) return undefined
  return $.fs.read(path).catch(() => undefined)
}

const count = (files: readonly FileDiff[]) => `${files.length} file${files.length === 1 ? '' : 's'}`
const totals = (files: readonly FileDiff[]) => ({
  added: files.reduce((sum, f) => sum + f.added, 0),
  removed: files.reduce((sum, f) => sum + f.removed, 0),
})

function describe(turn: LastTurn | null): string {
  if (turn === null) return 'No turn has finished yet.'
  if (turn.files.length === 0) return `T${turn.turn}: the last turn changed no files.`
  const { added, removed } = totals(turn.files)
  const names = turn.files.slice(0, 10).map(f => f.path)
  if (turn.files.length > 10) names.push(`${turn.files.length - 10} more`)
  return `T${turn.turn} · ${count(turn.files)} · +${added} −${removed}: ${names.join(', ')}`
}

/** The path cut from the left to fit `room` cells. */
const fit = (path: string, room: number) => (path.length > room ? `…${path.slice(-(Math.max(room, 10) - 1))}` : path)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'turn-diff', description: "Shows or hides the last turn's file changes" })
    return next(e)
  })

  on('command.run', { command: 'turn-diff' }, async $ => {
    // close only what is on screen: an open pane left unplaced, or behind another tab, opens again
    if ((await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)) {
      await $.ui.close({ id: PANE })
      return { text: 'Closed the last-turn diff.' }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const unplaced = opened.isPlaced ? '' : ` (no pane shown: ${opened.reason})`
    return { text: describe(await read($, lastTurn)) + unplaced }
  })

  // Only the main loop raises turn.start; a subagent's run and a slash command do not.
  // ($.session.turns() counts a command's rows as turns, so the mod counts its own.)
  on('turn.start', async ($, e, next) => {
    const turn = await update($, turns, n => n + 1)
    const first = e.text.split('\n').find(line => line.trim() !== '') ?? ''
    await update($, recording, () => ({ turnId: e.turnId, turn, prompt: clean(first.trim()).slice(0, 200), keys: [] }))
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const open = await read($, recording)
    if (open === null) return next(e)
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    const id = fileKey(path)
    // The tools' originalFile comes back with CRLF turned into LF, so the before is read from disk.
    const before = open.keys.includes(id) ? undefined : await snapshot($, path)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const result = ran.result as { staged?: boolean; structuredPatch?: readonly Hunk[] } | undefined
    if (result?.staged === true) return ran
    const lines = (result?.structuredPatch ?? []).flatMap(h => h.lines)
    const added = lines.filter(line => line.startsWith('+')).length
    const removed = lines.filter(line => line.startsWith('-')).length
    await update($, { ...PENDING, id }, held =>
      held?.turnId === open.turnId
        ? { ...held, added: held.added + added, removed: held.removed + removed }
        : { turnId: open.turnId, path, before: before === null ? '' : (before ?? null), isNew: before === null, added, removed },
    )
    await update($, recording, rec =>
      rec?.turnId === open.turnId && !rec.keys.includes(id) ? { ...rec, keys: [...rec.keys, id] } : rec,
    )
    return ran
  })

  // A subagent's run completes with its agentId and leaves the main turn alone.
  on('turn.complete', async ($, e, next) => {
    const open = await read($, recording)
    if (e.agentId !== undefined || open === null) return next(e)
    await update($, recording, () => null)
    const cwd = await $.session.cwd()
    const files: FileDiff[] = []
    for (const id of open.keys) {
      const held = await read($, { ...PENDING, id })
      await update($, { ...PENDING, id }, () => null)
      if (held?.turnId !== open.turnId) continue
      const after = await snapshot($, held.path)
      const file = diffFile({ ...held, path: clean(relativePath(cwd, held.path)), after })
      if (file !== null) files.push(file)
    }
    await update($, lastTurn, () => ({ turn: open.turn, prompt: open.prompt, files }))
    await update($, isBandHidden, () => false)
    await update($, page, () => 0)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const turn = await read($, lastTurn)
    if (turn === null) return <Text dimColor>No turn has finished yet.</Text>
    const width = e.props.bodyColumns
    const rule = (
      <Text dimColor wrap="truncate">
        {'─'.repeat(width)}
      </Text>
    )
    /** `+a −r`, colored, then the badges dim. */
    const counts = (changes: { added: number; removed: number }, badges: readonly string[] = []) => (
      <Text>
        <Text color="success">+{changes.added}</Text> <Text color="error">−{changes.removed}</Text>
        {badges.map(badge => (
          <Text dimColor>{`  ${badge}`}</Text>
        ))}
      </Text>
    )
    const all = totals(turn.files)
    const header = (
      <Box key="header" flexDirection="column">
        <Text bold>
          T{turn.turn} · {count(turn.files)} · <Text color="success">+{all.added}</Text>{' '}
          <Text color="error">−{all.removed}</Text>
        </Text>
        {turn.prompt !== '' && (
          <Text dimColor wrap="truncate-end">
            {turn.prompt}
          </Text>
        )}
      </Box>
    )
    if (turn.files.length === 0) {
      return (
        <Box flexDirection="column" width={width}>
          {header}
          <Text dimColor>The last turn changed no files.</Text>
        </Box>
      )
    }
    const pages = paginate(
      turn.files.map(file => textSize(file.hunks)),
      PAGE_BUDGET,
    )
    const last = pages.length - 1
    const at = Math.min(await read($, page), last)
    const show = async (i: number) => {
      await update($, page, () => pages.findIndex(files => files.includes(i)))
      // best effort: the page has switched whether or not the surface scrolls
      await $.ui.scroll({ in: PANE, to: { key: `file-${i}` }, block: 'start' }).catch(() => undefined)
    }
    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Box flexDirection="column" marginTop={1}>
          {turn.files.map((file, i) => {
            const tail = [`+${file.added} −${file.removed}`, ...file.badges].join('  ').length
            return (
              <Box key={`line-${i}`} justifyContent="space-between" gap={2}>
                <Button key={`row-${i}`} plain label={fit(file.path, width - tail - 2)} onPress={() => show(i)} />
                {counts(file, file.badges)}
              </Box>
            )
          })}
        </Box>
        {last > 0 && (
          <Box gap={1} marginTop={1}>
            {at > 0 && <Button key="prev" label="Prev" onPress={() => update($, page, p => Math.max(0, Math.min(p, last) - 1))} />}
            <Text dimColor>
              Page {at + 1} of {last + 1}
            </Text>
            {at < last && <Button key="next" label="Next" onPress={() => update($, page, p => Math.min(p + 1, last))} />}
          </Box>
        )}
        {(pages[at] ?? []).map(i => {
          const file = turn.files[i]!
          return (
            <Box key={`file-${i}`} flexDirection="column" marginTop={1}>
              {rule}
              <Box gap={2}>
                <Text bold>{file.path}</Text>
                {counts(file, file.badges)}
              </Box>
              {rule}
              {file.notes.map(note => (
                <Text dimColor>{note}</Text>
              ))}
              {blocks(file.hunks).map(source => (
                <Code format="diff" path={file.path} source={clean(source)} />
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'mobile' || e.props.hasSurvey || e.props.isWorking) return next(e)
    const turn = await read($, lastTurn)
    if (turn === null || turn.files.length === 0 || (await read($, isBandHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = totals(turn.files)
    return (
      <Box gap={1}>
        <Text>
          Last turn: {count(turn.files)} <Text color="success">+{all.added}</Text>{' '}
          <Text color="error">−{all.removed}</Text>
        </Text>
        <Button key="view" label="View" onPress={() => $.ui.open({ id: PANE, title: TITLE })} />
        <Button key="hide" label="x" role="dismiss" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })
}
