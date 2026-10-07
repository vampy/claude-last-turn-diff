import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { CODE_CAP, MAX_SIZE } from '../hooks/diff'
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

/** What a shell command in a test does to the disk. */
type Shell = { put: (path: string, text: string) => void; del: (path: string) => void }

type WorldOptions = {
  lies?: Record<string, 'deny' | 'error' | 'staged'>
  unplaced?: string
  /** The version control CWD is in; absent, none: git exits 128 and `cm` is not installed. */
  vcs?: 'git' | 'cm'
  /** The base revision (git's HEAD, Plastic's loaded changeset) by path; the disk starts from `files`. */
  base?: Record<string, string>
  /** Bash and PowerShell commands by their text. `git commit…` also commits the disk, `cm ci…` checks it in. */
  shell?: Record<string, (fs: Shell) => void>
  /** Plastic moves by new path: an `MV` and a `CH` record while the new path is on disk. */
  moves?: Record<string, string>
  /** Paths Plastic's RevisionType calls binary. */
  binaries?: string[]
  /** Status exits 1 with plain text, as on an authentication error. */
  isStatusBroken?: boolean
}

const ROOT = 'c:/proj/'
const rel = (key: string) => key.slice(ROOT.length)
const xmlText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The engine beneath the plugin, from memory: a disk under `$.fs`, Edit and Write tools that change it,
 * the session's cwd, panes, and the bottoms of the events the plugin passes on. No `session.turns`:
 * it counts slash commands as turns, so the mod must not ask it.
 * A path in `lies` is changed on disk and then answered with that outcome, so a recorded call would show.
 * `unplaced` is the reason every pane waits undrawn, as on a surface that places none.
 * `vcs` answers `process.run` as git or `cm` would, from the disk and the base revisions; `calls` holds each argv.
 */
function world(
  on: On,
  files: Record<string, string>,
  { lies = {}, unplaced, vcs, base = files, shell = {}, moves = {}, binaries = [], isStatusBroken }: WorldOptions = {},
) {
  const disk = new Map(Object.entries(files).map(([path, text]) => [norm(path), text]))
  const lied = new Map(Object.entries(lies).map(([path, outcome]) => [norm(path), outcome]))
  const panes = new Set<string>()
  const calls: string[][] = []
  /** Bumped on each write a tool or command makes, as an mtime is. */
  const mtimes = new Map<string, number>()
  let clock = 0
  const put = (path: string, text: string) => {
    disk.set(norm(path), text)
    mtimes.set(norm(path), ++clock)
  }
  // git commits (h1, h2…) or Plastic changesets (7, 8…), each a tree of keys under ROOT; `head` is HEAD or the loaded one
  const tree = (from: ReadonlyMap<string, string>) => new Map([...from].filter(([key]) => key.startsWith(ROOT)))
  let head = vcs === 'cm' ? '7' : 'h1'
  const revs = new Map([[head, tree(new Map(Object.entries(base).map(([path, text]) => [norm(path), text])))]])
  const parents = new Map<string, string>()
  const movedTo = new Map(Object.entries(moves).map(([to, from]) => [norm(to), norm(from)]))
  const isBinary = new Set(binaries.map(norm))

  /** The paths whose disk content differs from HEAD's: [key, 'new' | 'deleted' | 'changed']. */
  const changes = () => {
    const at = revs.get(head)!
    const keys = new Set([...at.keys(), ...tree(disk).keys()])
    return [...keys].sort().flatMap(key => {
      const now = disk.get(key)
      const was = at.get(key)
      if (now === was) return []
      return [[key, was === undefined ? 'new' : now === undefined ? 'deleted' : 'changed'] as const]
    })
  }
  const answer = (exitCode: number, stdout = '') => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  const git = (args: readonly string[]) => {
    if (vcs !== 'git') return answer(128)
    const [verb, ...rest] = args[0] === '--no-optional-locks' ? args.slice(1) : args
    if (verb === 'rev-parse') return rest[0] === '--show-toplevel' ? answer(0, 'C:/proj\n') : answer(0, `${head}\n`)
    if (isStatusBroken === true) return answer(128)
    if (verb === 'status') {
      const code = { new: '??', deleted: ' D', changed: ' M' } as const
      return answer(0, changes().map(([key, kind]) => `${code[kind]} ${rel(key)}\0`).join(''))
    }
    if (verb === 'cat-file') {
      const [rev, path] = rest[rest.length - 1]!.split(':') as [string, string]
      const text = revs.get(rev)?.get(norm(ROOT + path))
      // without --filters git drops the CRLF checkout writes, as `git show` does
      return text === undefined ? answer(128) : answer(0, rest.includes('--filters') ? text : text.replace(/\r\n/g, '\n'))
    }
    if (verb === 'merge-base') {
      let at: string | undefined = rest[2]
      while (at !== undefined && at !== rest[1]) at = parents.get(at)
      return answer(at === undefined ? 1 : 0)
    }
    if (verb === 'diff') {
      const [from, to] = [revs.get(rest[rest.length - 2]!)!, revs.get(rest[rest.length - 1]!)!]
      const keys = [...new Set([...from.keys(), ...to.keys()])].filter(key => from.get(key) !== to.get(key))
      return answer(0, keys.map(key => `${!from.has(key) ? 'A' : !to.has(key) ? 'D' : 'M'}\0${rel(key)}\0`).join(''))
    }
    throw new Error(`git ${args.join(' ')}`)
  }
  const cm = (args: readonly string[]) => {
    if (vcs !== 'cm') return { deny: 'cm is not installed' }
    const [verb, ...rest] = args
    const option = (name: string) => rest.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
    if (verb === 'gwp') return answer(0, 'c:\\proj\r\n')
    if (isStatusBroken === true) return answer(1, 'Authentication failed for org@cloud.')
    if (verb === 'status') {
      const record = (type: string, key: string, oldKey = '') =>
        `<Change><Type>${type}</Type><Path>${xmlText(rel(key).replace(/\//g, '\\'))}</Path>` +
        `<OldPath>${xmlText(rel(oldKey).replace(/\//g, '\\'))}</OldPath>` +
        `<RevisionType>${isBinary.has(key) ? 'enBinaryFile' : type === 'PR' ? '' : 'enTextFile'}</RevisionType></Change>`
      const movedFrom = new Set([...movedTo].filter(([to]) => disk.has(to)).map(([, from]) => from))
      const records = changes().flatMap(([key, kind]) => {
        const from = movedTo.get(key)
        if (from !== undefined && kind === 'new') return [record('MV', key, from), record('CH', key)]
        if (movedFrom.has(key)) return []
        return [record({ new: 'PR', deleted: 'LD', changed: 'CH' }[kind], key)]
      })
      const changesXml = records.length === 0 ? '' : `<Changes>${records.join('')}</Changes>`
      const xml = `\ufeff<?xml version="1.0" encoding="utf-8"?><StatusOutput><WorkspaceStatus><Status><Changeset>${head}</Changeset></Status></WorkspaceStatus>${changesXml}</StatusOutput>`
      disk.set(norm(option('xml')!), xml)
      return answer(0)
    }
    if (verb === 'cat') {
      const [, path, rev] = /^rev:(.*)#cs:(.*)$/.exec(rest[0]!)!
      const text = revs.get(rev!)?.get(norm(ROOT + path))
      if (text === undefined) return answer(1, `The specified revision was not found ${rest[0]}`)
      const file = option('file')
      // through a pipe cm turns non-ASCII into '?'
      if (file === undefined) return answer(0, text.replace(/[^\x00-\x7f]/g, '?'))
      disk.set(norm(file), text)
      return answer(0)
    }
    throw new Error(`cm ${args.join(' ')}`)
  }
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    const [bin, ...args] = e.argv
    return bin === 'git' ? git(args) : bin === 'cm' ? cm(args) : { deny: `${bin} is not installed` }
  })
  const commit = (name: string) => {
    revs.set(name, tree(disk))
    parents.set(name, head)
    head = name
  }
  const run = (command: string) => {
    shell[command]?.({ put, del: path => disk.delete(norm(path)) })
    if (command.startsWith('git commit')) commit(`h${revs.size + 1}`)
    if (command.startsWith('cm ci')) commit(String(Number(head) + 1))
    // a branch of its own: no ancestor of HEAD
    if (command === 'git switch side') {
      revs.set('side', tree(disk))
      head = 'side'
    }
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  }
  on('tool.call', { tool: 'Bash' }, ($, e) => run(e.command))
  on('tool.call', { tool: 'PowerShell' }, ($, e) => run(e.command))
  on('env.get', ($, e) => ({ value: e.name === 'TEMP' ? 'C:\\Users\\me\\AppData\\Local\\Temp' : undefined }))
  on('session.id', () => ({ value: 'ab12cd34-0000-4000-8000-000000000000' }))
  on('fs.write', ($, e) => {
    disk.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: disk.has(norm(e.path)) }))
  on('fs.stat', ($, e) => {
    const text = disk.get(norm(e.path))
    return text === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file', size: text.length, mtimeMs: mtimes.get(norm(e.path)) ?? 0, isLink: false } }
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
    put(e.file_path, text.replace(e.old_string, e.new_string))
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
    put(e.file_path, e.content)
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
  return { disk, panes, calls }
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

  test('/turn-diff toggles the pane and says what changed', { options: { autoOpen: false } }, async ($, on) => {
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

  test('with autoOpen off the pane does not open by itself', { options: { autoOpen: false } }, async ($, on) => {
    const { panes } = world(on, { 'C:\\proj\\a.txt': 'a\n' })
    await start($, 't1')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    expect([...panes]).toEqual([])
  })

  test('by default the pane opens after a main turn with edits, not after one without', async ($, on) => {
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

const begin = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
const at = (file: string) => `${CWD}\\${file}`
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

for (const kind of ['git', 'cm'] as const) {
  describe(`shell edits through ${kind}`, () => {
    test('a shell change to a clean tracked file shows against the base, as checkout writes it', async ($, on) => {
      // git: CRLF that only `cat-file --filters` keeps; cm: non-ASCII that only `--file` keeps
      const [file, was, now] =
        kind === 'git'
          ? ['a.txt', 'one\r\ntwo\r\n', 'one\r\nTWO\r\n']
          : ['docs\\r&d notes.md', 'Done ✅\nnext\n', 'Done ✅\nnext ✅\n']
      world(on, { [at(file)]: was }, { vcs: kind, shell: { fix: fs => fs.put(at(file), now) } })
      await begin($)
      await start($, 't1')
      await bash($, 'fix')
      await complete($, 't1')
      const { rows, codes } = await pane($, 'desktop')
      const path = file.replace(/\\/g, '/')
      expect(rows).toEqual([`${path}  +1 −1`])
      expect(codes).toEqual([
        { path, source: kind === 'git' ? '@@ -1,2 +1,2 @@\n one\n-two\n+TWO' : '@@ -1,2 +1,2 @@\n Done ✅\n-next\n+next ✅' },
      ])
    })

    test('a file dirty at turn start diffs against its turn-start content; untouched ones do not show', async ($, on) => {
      const big = 'x\n'.repeat(MAX_SIZE)
      world(
        on,
        { [at('a.txt')]: 'start\n', [at('big.txt')]: big, [at('blob.bin')]: 'PNG\0start', [at('same.txt')]: 'mine\n' },
        {
          vcs: kind,
          base: { [at('a.txt')]: 'base\n', [at('big.txt')]: 'small\n', [at('blob.bin')]: 'PNG\0base', [at('same.txt')]: 'base\n' },
          shell: { fix: fs => fs.put(at('a.txt'), 'end\n'), noop: () => undefined },
        },
      )
      await begin($)
      await start($, 't1')
      await bash($, 'fix')
      await complete($, 't1')
      expect((await pane($, 'terminal')).codes).toEqual([{ path: 'a.txt', source: '@@ -1,1 +1,1 @@\n-start\n+end' }])
      await start($, 't2', 'Just look')
      await bash($, 'noop')
      await complete($, 't2')
      const { header, rows } = await pane($, 'desktop')
      expect(header).toBe('T2 · 0 files · +0 −0  Just look')
      expect(rows).toEqual([])
    })

    test('new files show new, deleted ones deleted', async ($, on) => {
      world(
        on,
        { [at('gone.txt')]: 'bye\n' },
        { vcs: kind, shell: { make: fs => (fs.put(at('src\\new.txt'), 'hello\n'), fs.del(at('gone.txt'))) } },
      )
      await begin($)
      await start($, 't1')
      await bash($, 'make')
      await complete($, 't1')
      expect((await pane($, 'desktop')).rows).toEqual(['gone.txt  +0 −1  deleted', 'src/new.txt  +1 −0  new'])
    })

    test('an Edit and a shell command on one file show as one net diff from turn start', async ($, on) => {
      const text = 'a\nb\nc\n'
      world(
        on,
        { [at('a.txt')]: text, [at('b.txt')]: text },
        { vcs: kind, shell: { both: fs => (fs.put(at('a.txt'), 'A\nb\nC\n'), fs.put(at('b.txt'), 'a\nb\nC\n')) } },
      )
      await begin($)
      await start($, 't1')
      await edit($, 'a.txt', 'a', 'A')
      await bash($, 'both')
      // the Edit reads b.txt after the shell changed it; the turn still shows b.txt from its turn-start content
      await edit($, 'b.txt', 'a', 'A')
      await complete($, 't1')
      expect((await pane($, 'terminal')).rows).toEqual(['a.txt  +2 −2', 'b.txt  +2 −2'])
    })

    test('a failed status gives no shell files and no error', async ($, on) => {
      world(
        on,
        { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' },
        { vcs: kind, isStatusBroken: true, shell: { fix: fs => fs.put(at('b.txt'), 'B\n') } },
      )
      await begin($)
      await start($, 't1')
      await edit($, 'a.txt', 'a', 'A')
      await bash($, 'fix')
      await complete($, 't1')
      const { rows, texts } = await pane($, 'terminal')
      expect(rows).toEqual(['a.txt  +1 −1'])
      expect(texts).toContain(`${kind} status failed at turn start: shell changes are not shown.`)
    })

    test('binary files show a binary badge and no code; one too large to diff, too large', async ($, on) => {
      // git knows binary by a NUL; Plastic by its RevisionType, NUL or not
      const blob = (tag: string) => (kind === 'git' ? `PNG\0${tag}` : `uasset ${tag}`)
      world(
        on,
        { [at('clean.bin')]: blob('one'), [at('dirty.bin')]: blob('two'), [at('big.txt')]: 'x\n'.repeat(MAX_SIZE) },
        {
          vcs: kind,
          base: { [at('clean.bin')]: blob('one'), [at('dirty.bin')]: blob('base'), [at('big.txt')]: 'small\n' },
          binaries: [at('clean.bin'), at('dirty.bin')],
          shell: {
            fix: fs => (
              fs.put(at('clean.bin'), blob('ONE!')), fs.put(at('dirty.bin'), blob('TWO!')), fs.put(at('big.txt'), 'y\n'.repeat(MAX_SIZE))
            ),
          },
        },
      )
      await begin($)
      await start($, 't1')
      await bash($, 'fix')
      await complete($, 't1')
      const { rows, codes } = await pane($, 'desktop')
      expect(rows).toEqual(['big.txt  +0 −0  too large', 'dirty.bin  +0 −0  binary', 'clean.bin  +0 −0  binary'])
      expect(codes).toEqual([])
    })

    test('shellEdits off runs no process at all', { options: { shellEdits: false } }, async ($, on) => {
      const { calls, panes } = world(on, { [at('b.txt')]: 'b\n' }, { vcs: kind, shell: { fix: fs => fs.put(at('b.txt'), 'B\n') } })
      await begin($)
      await start($, 't1')
      await bash($, 'fix')
      await complete($, 't1')
      expect(calls).toEqual([])
      expect([...panes]).toEqual([])
      expect((await pane($, 'terminal')).rows).toEqual([])
    })
  })
}

describe('shell edits without version control', () => {
  test('git exiting 128 and no cm installed: Edit-only, and nothing runs past detection', async ($, on) => {
    const { calls } = world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' }, { shell: { fix: fs => fs.put(at('b.txt'), 'B\n') } })
    await begin($)
    expect(calls).toEqual([
      ['git', 'rev-parse', '--show-toplevel'],
      ['cm', 'gwp', CWD, '--format={1}'],
    ])
    await start($, 't1')
    await edit($, 'a.txt', 'a', 'A')
    await bash($, 'fix')
    await complete($, 't1')
    expect(calls).toHaveLength(2)
    expect((await pane($, 'terminal')).rows).toEqual(['a.txt  +1 −1'])
  })
})

describe('shell edits, git only', () => {
  test('a commit during the turn still shows the committed file', async ($, on) => {
    world(on, { [at('a.txt')]: 'a\n' }, { vcs: 'git', shell: { 'git commit -am fix': fs => fs.put(at('a.txt'), 'A\n') } })
    await begin($)
    await start($, 't1')
    await bash($, 'git commit -am fix')
    await complete($, 't1')
    const { rows, texts } = await pane($, 'terminal')
    expect(rows).toEqual(['a.txt  +1 −1'])
    expect(texts.filter(text => text.startsWith('HEAD'))).toEqual([])
  })

  test('HEAD moving anywhere but forward gives a note', async ($, on) => {
    world(on, { [at('a.txt')]: 'a\n' }, { vcs: 'git', shell: { 'git switch side': fs => fs.put(at('a.txt'), 'A\n') } })
    await begin($)
    await start($, 't1')
    await bash($, 'git switch side')
    await complete($, 't1')
    const { texts } = await pane($, 'terminal')
    expect(texts).toContain('HEAD moved from h1 to side: files changed only by that move are not shown.')
  })
})

describe('shell edits, Plastic only', () => {
  test('a moved and edited item (MV and CH records) shows once, against its old path', async ($, on) => {
    world(
      on,
      { [at('old.txt')]: 'x\n' },
      {
        vcs: 'cm',
        moves: { [at('new.txt')]: at('old.txt') },
        shell: { 'cm mv old.txt new.txt': fs => (fs.del(at('old.txt')), fs.put(at('new.txt'), 'x\ny\n')) },
      },
    )
    await begin($)
    await start($, 't1')
    await bash($, 'cm mv old.txt new.txt')
    await complete($, 't1')
    const { rows, codes } = await pane($, 'terminal')
    expect(rows).toEqual(['new.txt  +1 −0'])
    expect(codes).toEqual([{ path: 'new.txt', source: '@@ -1,1 +1,2 @@\n x\n+y' }])
  })

  test('a changeset move, or a cm update, switch or merge, gives a note and keeps the Edits', async ($, on) => {
    world(
      on,
      { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' },
      { vcs: 'cm', shell: { 'cm ci -c fix': fs => fs.put(at('a.txt'), 'A\n'), 'cm update .': fs => fs.put(at('a.txt'), 'AA\n') } },
    )
    await begin($)
    await start($, 't1')
    await edit($, 'b.txt', 'b', 'B')
    await bash($, 'cm ci -c fix')
    await complete($, 't1')
    let drawn = await pane($, 'terminal')
    expect(drawn.rows).toEqual(['b.txt  +1 −1'])
    expect(drawn.texts).toContain('The workspace moved from cs:7 to cs:8: shell changes are not shown.')
    await start($, 't2')
    await edit($, 'b.txt', 'B', 'b')
    await $.tool.call({ tool: 'PowerShell', command: 'cm update .' })
    await complete($, 't2')
    drawn = await pane($, 'desktop')
    expect(drawn.rows).toEqual(['b.txt  +1 −1'])
    expect(drawn.texts).toContain('cm update, switch or merge ran this turn: shell changes are not shown.')
  })
})
