import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { CODE_CAP } from '../hooks/diff'
import { parseHunks } from './parse'

const PLUGIN = 'last-turn-diff'
const CWD = 'C:\\proj'
const SURFACES = ['terminal', 'desktop'] as const
const PANE = {
  component: 'Pane',
  requestId: 'last-turn-diff',
  props: {
    title: 'Last turn',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const
/** How Windows tells two spellings of a path apart: it does not. */
const norm = (path: string) => path.replace(/\\/g, '/').toLowerCase()

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

/**
 * The engine beneath the plugin, from memory: a disk under `$.fs`, Edit and Write tools that change it,
 * the session's cwd, panes, and the bottoms of the events the plugin passes on. No `session.turns`:
 * it counts slash commands as turns, so the mod must not ask it.
 * A path in `lies` is changed on disk and then answered with that outcome, so a recorded call would show.
 * `unplaced` is the reason every pane waits undrawn, as on a surface that places none.
 */
function world(
  on: On,
  files: Record<string, string>,
  { lies = {}, unplaced }: { lies?: Record<string, 'deny' | 'error' | 'staged'>; unplaced?: string } = {},
) {
  const disk = new Map(Object.entries(files).map(([path, text]) => [norm(path), text]))
  const lied = new Map(Object.entries(lies).map(([path, outcome]) => [norm(path), outcome]))
  const panes = new Set<string>()
  on('fs.exists', ($, e) => ({ value: disk.has(norm(e.path)) }))
  on('fs.stat', ($, e) => {
    const text = disk.get(norm(e.path))
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = disk.get(norm(e.path))
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('session.cwd', () => ({ value: CWD }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.open', ($, e) => {
    panes.add(e.id)
    return { value: unplaced === undefined ? { isPlaced: true } : { isPlaced: false, reason: unplaced } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(id => {
      const isPlaced = unplaced === undefined
      return { id, title: id, isShown: isPlaced, isFocused: false, isPlaced }
    }),
  }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ key: 'engine' }))
  const lie = (path: string) => {
    const outcome = lied.get(norm(path))
    if (outcome === 'deny') return { deny: 'not allowed' }
    if (outcome === 'error') return { isError: true, result: 'failed', text: 'failed' } as const
    return undefined
  }
  on('tool.call', { tool: 'Edit' }, ($, e) => {
    const text = disk.get(norm(e.file_path))
    if (text === undefined || !text.includes(e.old_string)) return { isError: true, result: 'no match', text: 'no match' }
    disk.set(norm(e.file_path), text.replace(e.old_string, e.new_string))
    return (
      lie(e.file_path) ?? {
        result: {
          filePath: e.file_path,
          oldString: e.old_string,
          newString: e.new_string,
          // as 2.1.289 reports it: CRLF turned into LF
          originalFile: text.replace(/\r\n/g, '\n'),
          structuredPatch: [],
          userModified: false,
          replaceAll: false,
          ...(lied.get(norm(e.file_path)) === 'staged' ? { staged: true } : {}),
        },
      }
    )
  })
  on('tool.call', { tool: 'Write' }, ($, e) => {
    const text = disk.get(norm(e.file_path))
    disk.set(norm(e.file_path), e.content)
    return (
      lie(e.file_path) ?? {
        result: {
          type: text === undefined ? 'create' : 'update',
          filePath: e.file_path,
          content: e.content,
          structuredPatch: [],
          originalFile: text ?? null,
          ...(lied.get(norm(e.file_path)) === 'staged' ? { staged: true } : {}),
        },
      }
    )
  })
  return { disk, panes }
}

const start = ($: Engine, turnId: string, text = 'Fix the thing\nwith details') => $.turn.start({ text, turnId })
const complete = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer', ...(agentId ? { agentId } : {}) })
const RUN = {
  command: 'turn-diff',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const
const edit = ($: Engine, file: string, from: string, to: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${CWD}\\${file}`, old_string: from, new_string: to })

const mountPane = ($: Engine, surface: (typeof SURFACES)[number]) => $.ui.mount({ plugin: PLUGIN, surface, ...PANE })

/** What a drawn element shows on one line: Text runs joined, a Box's parts two spaces apart, a Button's label. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const element = node as { type?: string; props?: { label?: unknown }; children?: unknown[] } | undefined
  if (element?.type === 'Button') return String(element.props?.label ?? '')
  const parts = (element?.children ?? []).map(textOf)
  return element?.type === 'Box' ? parts.filter(part => part !== '').join('  ') : parts.join('')
}

/** The pane drawn: its header, file rows, Texts, Buttons' labels and Code blocks. */
async function look(ui: Awaited<ReturnType<typeof mountPane>>) {
  const header = textOf(await ui.find({ key: 'header' }))
  const rows = (await ui.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('line-')).map(textOf)
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  const buttons = (await ui.findAll({ type: 'Button' })).map(found => found.text)
  const codes = (await ui.findAll({ type: 'Code' })).map(found => ({
    path: found.props.path,
    source: String(found.props.source),
  }))
  return { header, rows, texts, buttons, codes }
}

const pane = async ($: Engine, surface: (typeof SURFACES)[number]) => look(await mountPane($, surface))

describe('recording', () => {
  test('two Edits to one file in one turn show as one net diff', async ($, on) => {
    world(on, { 'C:\\proj\\a.txt': 'one\r\ntwo\r\nthree\r\n' })
    await start($, 't1')
    await edit($, 'a.txt', 'two', 'TWO')
    await $.tool.call({ tool: 'Edit', file_path: 'c:/PROJ/A.txt', old_string: 'three', new_string: 'THREE' })
    await complete($, 't1')
    for (const surface of SURFACES) {
      const { header, rows, codes } = await pane($, surface)
      expect(header).toBe('T1 · 1 file · +2 −2  Fix the thing')
      expect(rows).toEqual(['a.txt  +2 −2'])
      // CRLF on both sides: no line-ending flag although the tool reported LF
      expect(codes).toEqual([{ path: 'a.txt', source: '@@ -1,3 +1,3 @@\n one\n-two\n-three\n+TWO\n+THREE' }])
    }
  })

  test('a new file, a deleted one and a rewrite in one turn', async ($, on) => {
    const { disk } = world(on, { 'C:\\proj\\gone.txt': 'bye\n', 'C:\\proj\\b.txt': 'b\r\n' })
    await start($, 't1')
    await $.tool.call({ tool: 'Write', file_path: 'C:\\proj\\new.txt', content: 'hello\n' })
    await $.tool.call({ tool: 'Write', file_path: 'c:/PROJ/b.txt', content: 'b\n' })
    await edit($, 'gone.txt', 'bye', 'bye!')
    disk.delete(norm('C:\\proj\\gone.txt'))
    await complete($, 't1')
    const { rows } = await pane($, 'desktop')
    expect(rows).toEqual(['new.txt  +1 −0  new', 'b.txt  +0 −0  CRLF→LF', 'gone.txt  +0 −1  deleted'])
  })

  test('denied, errored and staged edits are ignored', async ($, on) => {
    world(
      on,
      { 'C:\\proj\\d.txt': 'd\n', 'C:\\proj\\e.txt': 'e\n', 'C:\\proj\\s.txt': 's\n', 'C:\\proj\\ok.txt': 'ok\n' },
      { lies: { 'C:\\proj\\d.txt': 'deny', 'C:\\proj\\e.txt': 'error', 'C:\\proj\\s.txt': 'staged' } },
    )
    await start($, 't1')
    for (const file of ['d.txt', 'e.txt', 's.txt']) await edit($, file, file[0]!, 'changed')
    await $.tool.call({ tool: 'Write', file_path: 'C:\\proj\\s.txt', content: 'staged write\n' })
    await edit($, 'ok.txt', 'ok', 'OK')
    await complete($, 't1')
    const { rows } = await pane($, 'terminal')
    expect(rows).toEqual(['ok.txt  +1 −1'])
  })

  test("edits outside a turn are not recorded, and a subagent's turn.complete keeps the last turn", async ($, on) => {
    world(on, { 'C:\\proj\\a.txt': 'a\n', 'C:\\proj\\b.txt': 'b\n', 'C:\\proj\\c.txt': 'c\n' })
    await edit($, 'c.txt', 'c', 'C')
    await start($, 't1')
    await edit($, 'a.txt', 'a', 'A')
    // a subagent ends its run mid-turn: the main turn records on
    await complete($, 'sub-1', 'agent-1')
    await edit($, 'b.txt', 'b', 'B')
    await complete($, 't1')
    // a background subagent finishing after the turn leaves T1 standing
    await complete($, 'sub-2', 'agent-2')
    const { header, rows } = await pane($, 'terminal')
    expect(header).toBe('T1 · 2 files · +2 −2  Fix the thing')
    expect(rows).toEqual(['a.txt  +1 −1', 'b.txt  +1 −1'])
  })

  test('a turn without edits replaces the last one', async ($, on) => {
    world(on, { 'C:\\proj\\a.txt': 'a\n' })
    await start($, 't1')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', 'Just a question')
    await complete($, 't2')
    for (const surface of SURFACES) {
      const { header, texts, codes } = await pane($, surface)
      expect(header).toBe('T2 · 0 files · +0 −0  Just a question')
      expect(texts).toContain('The last turn changed no files.')
      expect(codes).toEqual([])
    }
  })
})

describe('pane', () => {
  test('pages a large turn under the draw budget; rows jump, Prev and Next page', async ($, on) => {
    const big = (tag: string) => Array.from({ length: 4000 }, (_, i) => `${tag} ${i}\n`).join('')
    world(on, { 'C:\\proj\\x.txt': big('x'), 'C:\\proj\\y.txt': big('y'), 'C:\\proj\\z.txt': big('z') })
    await start($, 't1')
    for (const tag of ['x', 'y', 'z']) {
      await $.tool.call({ tool: 'Write', file_path: `${CWD}\\${tag}.txt`, content: big(tag.toUpperCase()) })
    }
    await complete($, 't1')
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      let drawn = await look(ui)
      expect(drawn.texts).toContain('Page 1 of 3')
      expect(drawn.buttons).toContain('Next')
      expect(drawn.buttons).not.toContain('Prev')
      const pages = [drawn.codes]
      await ui.press({ key: 'next' })
      drawn = await look(ui)
      expect(drawn.texts).toContain('Page 2 of 3')
      pages.push(drawn.codes)
      await ui.press({ key: 'row-2' })
      drawn = await look(ui)
      expect(drawn.texts).toContain('Page 3 of 3')
      expect(drawn.buttons).toContain('Prev')
      expect(drawn.buttons).not.toContain('Next')
      pages.push(drawn.codes)
      expect(pages.map(codes => [...new Set(codes.map(code => code.path))])).toEqual([['x.txt'], ['y.txt'], ['z.txt']])
      for (const codes of pages) {
        expect(codes.reduce((sum, code) => sum + code.source.length, 0)).toBeLessThan(100_000)
        for (const { source } of codes) {
          expect(source.length).toBeLessThanOrEqual(CODE_CAP)
          expect(parseHunks(source)).toBeGreaterThan(0)
        }
      }
      await ui.press({ key: 'prev' })
      expect((await look(ui)).texts).toContain('Page 2 of 3')
      await ui.press({ key: 'row-0' })
      expect((await look(ui)).texts).toContain('Page 1 of 3')
      await ui.unmount()
    }
  })

  test('mobile is left to the engine', async ($, on) => {
    world(on, {})
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'mobile', ...PANE })
    expect(await ui.find({ key: 'engine' })).toBeDefined()
  })
})

describe('band and command', () => {
  test('the band shows after a turn with edits, opens the pane, hides until the next turn', async ($, on) => {
    const { panes } = world(on, { 'C:\\proj\\a.txt': 'a\nb\n' })
    for (const surface of SURFACES) {
      const turn = `t-${surface}`
      await start($, turn)
      await edit($, 'a.txt', surface === 'terminal' ? 'a' : 'A', surface === 'terminal' ? 'A' : 'a')
      await complete($, turn)
      const band = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      expect(textOf(await band.find({ type: 'Text' }))).toBe('Last turn: 1 file +1 −1')
      panes.clear()
      await band.press({ key: 'view' })
      expect([...panes]).toEqual(['last-turn-diff'])
      await band.press({ key: 'hide' })
      expect(await band.find({ key: 'view' })).toBeUndefined()
      expect(await band.find({ key: 'engine' })).toBeDefined()
      const working = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND, props: { ...BAND.props, isWorking: true } })
      expect(await working.find({ key: 'view' })).toBeUndefined()
    }
    await start($, 't-last')
    await edit($, 'a.txt', 'b', 'B')
    await complete($, 't-last')
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await band.find({ key: 'view' })).toBeDefined()
  })

  test('the band stays out of the way with no edits', async ($, on) => {
    world(on, {})
    for (const surface of SURFACES) {
      const band = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      expect(await band.find({ key: 'engine' })).toBeDefined()
    }
    await start($, 't1')
    await complete($, 't1')
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    expect(await band.find({ key: 'view' })).toBeUndefined()
  })

  test('/turn-diff toggles the pane and says what changed', async ($, on) => {
    const { panes } = world(on, { 'C:\\proj\\a.txt': 'a\n' })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    expect(await $.command.run(RUN)).toMatchObject({ text: 'No turn has finished yet.' })
    expect([...panes]).toEqual(['last-turn-diff'])
    expect(await $.command.run(RUN)).toMatchObject({ text: 'Closed the last-turn diff.' })
    expect([...panes]).toEqual([])
    await start($, 't1')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    expect(await $.command.run(RUN)).toMatchObject({ text: 'T1 · 1 file · +1 −1: a.txt' })
    // slash commands between turns start no turn: the next one is T2
    await $.command.run(RUN)
    await start($, 't2')
    await edit($, 'a.txt', 'A', 'a')
    await complete($, 't2')
    expect(await $.command.run(RUN)).toMatchObject({ text: 'T2 · 1 file · +1 −1: a.txt' })
  })

  test('the pane does not open by itself by default', async ($, on) => {
    const { panes } = world(on, { 'C:\\proj\\a.txt': 'a\n' })
    await start($, 't1')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    expect([...panes]).toEqual([])
  })

  test('autoOpen opens the pane after a main turn with edits, not after one without', { options: { autoOpen: true } }, async ($, on) => {
    const { panes } = world(on, { 'C:\\proj\\a.txt': 'a\n' })
    await start($, 't1')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 'sub-1', 'agent-1')
    expect([...panes]).toEqual([])
    await complete($, 't1')
    expect([...panes]).toEqual(['last-turn-diff'])
    panes.clear()
    await start($, 't2', 'Just a question')
    await complete($, 't2')
    expect([...panes]).toEqual([])
  })

  test('/turn-diff says why when no surface shows the pane', async ($, on) => {
    world(on, {}, { unplaced: 'no attached surface places panes' })
    const said = { text: 'No turn has finished yet. (no pane shown: no attached surface places panes)' }
    expect(await $.command.run(RUN)).toMatchObject(said)
    // the pane is open but not on screen: running it again says why again rather than closing it
    expect(await $.command.run(RUN)).toMatchObject(said)
  })
})
