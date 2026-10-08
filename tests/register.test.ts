import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import { CODE_CAP, MAX_SIZE } from '../hooks/diff'
import { SVG_CAP } from '../hooks/svg'
import { parseHunks, svgRows } from './parse'
import { call, command, edit as editRow, patch, prompt, reply, skill, write } from './transcript'

const PLUGIN = 'last-turn-diff'
/** The session id the test world starts with. */
const SESSION = 'ab12cd34-0000-4000-8000-000000000000'
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
  /** `$.session.messages()` fails, as no engine's should. */
  isTranscriptBroken?: boolean
  /** The rows the transcript holds before the test's own, as in a resumed session. */
  transcript?: SessionMessage[]
  /** Called on each status run (git or cm), numbered from 1; the run waits for what it returns. */
  onStatus?: (n: number) => Promise<unknown> | undefined
  /** Environment variables besides TEMP, which is always set. */
  env?: Record<string, string>
  /** The session's cwd; CWD by default. */
  cwd?: string
  /** Folders that are links or junctions, by path: where each lands. */
  links?: Record<string, string>
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
 * `rows` is the transcript `$.session.messages()` reads the newest 4,096 entries of: `transcript`, then a row for each
 * prompt, each tool call and its result, and each turn's answer, as the session writes them.
 */
function world(
  on: On,
  files: Record<string, string>,
  { lies = {}, unplaced, vcs, base = files, shell = {}, moves = {}, binaries = [], isStatusBroken, isTranscriptBroken, transcript = [], onStatus, env = {}, cwd = CWD, links = {} }: WorldOptions = {},
) {
  const rows = [...transcript]
  let reads = 0
  on('session.messages', () => {
    reads++
    if (isTranscriptBroken === true) throw new Error('no transcript')
    return { value: rows.slice(-4096) }
  })
  // the main conversation's compaction leaves its summary alone
  on('session.compact', ($, e) => {
    if (e.agentId !== undefined) return { messages: e.messages }
    rows.splice(0, rows.length, prompt('This session is being continued from a previous conversation that ran out of context.'))
    return { messages: [...rows] }
  })
  let sessionId = SESSION
  /** Another conversation in its place, as a /clear or a resume leaves: another id, another transcript. */
  const swap = (id: string, next: readonly SessionMessage[]) => {
    sessionId = id
    rows.splice(0, rows.length, ...next)
  }
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  /** Writes the call and its outcome to the transcript; a denied or errored call keeps its reason as its result. */
  const record = <R extends { deny?: string; isError?: boolean; result?: unknown; text?: string }>(
    tool: string,
    input: Record<string, unknown>,
    ran: R,
  ): R => {
    const isError = ran.deny !== undefined || ran.isError === true
    const text = ran.deny ?? ran.text ?? `${tool} ran`
    rows.push(...call(tool, input, { text, result: isError ? text : ran.result, ...(isError ? { isError } : {}) }))
    return ran
  }
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
  let statuses = 0
  on('process.run', async ($, e) => {
    calls.push([...e.argv])
    if (e.argv.includes('status')) await onStatus?.(++statuses)
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
  on('tool.call', { tool: 'Bash' }, ($, e) => record('Bash', { command: e.command }, run(e.command)))
  on('tool.call', { tool: 'PowerShell' }, ($, e) => record('PowerShell', { command: e.command }, run(e.command)))
  on('env.get', ($, e) => ({ value: ({ TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp', ...env } as Record<string, string>)[e.name] }))
  on('session.id', () => ({ value: sessionId }))
  on('fs.write', ($, e) => {
    disk.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: disk.has(norm(e.path)) }))
  on('fs.stat', ($, e) => {
    const link = Object.entries(links).find(([from]) => norm(from) === norm(e.path))
    if (link !== undefined) {
      return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, ...(e.resolve ? { realPath: link[1] } : {}) } }
    }
    const text = disk.get(norm(e.path))
    return text === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file', size: text.length, mtimeMs: mtimes.get(norm(e.path)) ?? 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = disk.get(norm(e.path))
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('session.cwd', () => ({ value: cwd }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // a continuation starts with no typed prompt, and no row
  on('turn.start', ($, e) => {
    if (e.text !== '') rows.push(prompt(e.text))
    return { turnId: e.turnId }
  })
  on('turn.complete', ($, e) => {
    if (e.agentId === undefined) rows.push(reply(e.answer || 'Done.'))
    return { text: e.answer }
  })
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
    const input = { file_path: e.file_path, old_string: e.old_string, new_string: e.new_string }
    const text = disk.get(norm(e.file_path))
    if (text === undefined || !text.includes(e.old_string)) {
      return record('Edit', input, { isError: true, result: 'no match', text: 'no match' } as const)
    }
    const after = text.replace(e.old_string, () => e.new_string)
    put(e.file_path, after)
    return record(
      'Edit',
      input,
      lie(e.file_path) ?? {
        result: {
          filePath: e.file_path,
          oldString: e.old_string,
          newString: e.new_string,
          // as 2.1.289 reports it: CRLF turned into LF
          originalFile: text.replace(/\r\n/g, '\n'),
          structuredPatch: patch(text, after),
          userModified: false,
          replaceAll: false,
          ...(lied.get(norm(e.file_path)) === 'staged' ? { staged: true } : {}),
        },
      },
    )
  })
  on('tool.call', { tool: 'Write' }, ($, e) => {
    const text = disk.get(norm(e.file_path))
    put(e.file_path, e.content)
    return record(
      'Write',
      { file_path: e.file_path, content: e.content },
      lie(e.file_path) ?? {
        result: {
          type: text === undefined ? ('create' as const) : ('update' as const),
          filePath: e.file_path,
          content: e.content,
          structuredPatch: text === undefined ? [] : patch(text, e.content),
          originalFile: text ?? null,
          ...(lied.get(norm(e.file_path)) === 'staged' ? { staged: true } : {}),
        },
      },
    )
  })
  return { disk, panes, calls, rows, swap, reads: () => reads }
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

/** The pane drawn: its header, file rows, Texts, Buttons' labels, Code blocks and Svg images. */
async function look(ui: Awaited<ReturnType<typeof mountPane>>) {
  const header = textOf(await ui.find({ key: 'header' }))
  const rows = (await ui.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('line-')).map(textOf)
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  const buttons = (await ui.findAll({ type: 'Button' })).map(found => found.text)
  const codes = (await ui.findAll({ type: 'Code' })).map(found => ({
    path: found.props.path,
    source: String(found.props.source),
  }))
  const svgs = (await ui.findAll({ type: 'Svg' })).map(found => ({
    alt: String(found.props.alt),
    source: String(found.props.source),
  }))
  return { header, rows, texts, buttons, codes, svgs }
}

/** The pane mounted, read and unmounted. */
async function pane($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await mountPane($, surface)
  const drawn = await look(ui)
  await ui.unmount()
  return drawn
}

describe('recording', () => {
  test('two Edits to one file in one turn show as one net diff', async ($, on) => {
    world(on, { 'C:\\proj\\a.txt': 'one\r\ntwo\r\nthree\r\n' })
    await start($, 't1')
    await edit($, 'a.txt', 'two', 'TWO')
    await $.tool.call({ tool: 'Edit', file_path: 'c:/PROJ/A.txt', old_string: 'three', new_string: 'THREE' })
    await complete($, 't1')
    for (const surface of SURFACES) {
      const { header, rows, texts, codes, svgs } = await pane($, surface)
      expect(header).toBe('T1 · 1 file · +2 −2  Fix the thing')
      expect(rows).toEqual(['a.txt  +2 −2'])
      // CRLF on both sides: no line-ending flag although the tool reported LF
      if (surface === 'terminal') {
        expect(codes).toEqual([{ path: 'a.txt', source: '@@ -1,3 +1,3 @@\n one\n-two\n-three\n+TWO\n+THREE' }])
        expect(svgs).toEqual([])
      } else {
        expect(codes).toEqual([])
        expect(texts).toContain('@@ -1,3 +1,3 @@')
        expect(svgs.map(({ alt, source }) => [alt, svgRows(source)])).toEqual([
          ['Diff of a.txt, @@ -1,3 +1,3 @@', ['1   one', '2 - two', '3 - three', '2 + TWO', '3 + THREE']],
        ])
      }
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

  test("a turn a background task's notification starts shows its summary, not the tag", async ($, on) => {
    world(on, { 'C:\\proj\\a.txt': 'a\n' })
    const notice = (summary: string) =>
      `<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n${summary}</task-notification>\n`
    await start($, 't1', notice('<summary>Background command "npm test" completed (exit code 0)</summary>\n'))
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    expect((await pane($, 'terminal')).header).toBe('T1 · 1 file · +1 −1  Background command "npm test" completed (exit code 0)')
    await start($, 't2', notice(''))
    await edit($, 'a.txt', 'A', 'a')
    await complete($, 't2')
    expect((await pane($, 'desktop')).header).toBe('T2 · 1 file · +1 −1  Background task finished')
  })

  test('a turn without edits leaves the last one on show', async ($, on) => {
    world(on, { 'C:\\proj\\a.txt': 'a\n' })
    await start($, 't1')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', 'Just a question')
    await complete($, 't2')
    for (const surface of SURFACES) {
      const { header, rows } = await pane($, surface)
      expect(header).toBe('T1 · 1 file · +1 −1  Fix the thing')
      expect(rows).toEqual(['a.txt  +1 −1'])
    }
  })

  test('a turn without edits that ran a shell command its note doubts is shown, the note on it', async ($, on) => {
    world(on, { 'C:\\proj\\a.txt': 'a\n' }, { vcs: 'git', isStatusBroken: true, shell: { build: () => undefined } })
    await begin($)
    await start($, 't1')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', 'Build it')
    await bash($, 'build')
    await complete($, 't2')
    const note = 'git status failed at turn start: shell changes are not shown.'
    for (const surface of SURFACES) {
      const { header, texts, codes } = await pane($, surface)
      expect(header).toBe(`T2 · 0 files · +0 −0  Build it  ${note}`)
      expect(texts).toContain('This turn changed no files.')
      expect(codes).toEqual([])
    }
    expect(await $.command.run(RUN)).toMatchObject({ text: 'Closed the last-turn diff.' })
    expect(await $.command.run(RUN)).toMatchObject({ text: 'T2 changed no files.' })
    // listed while it is the live one
    const ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · Fix the thing', 'T2 · 0 files · Build it'], value: '2' })
    await ui.unmount()
    // the same note on a turn that ran no shell command leaves T2 on show
    await start($, 't3', 'Just a question')
    await complete($, 't3')
    expect((await pane($, 'terminal')).header).toBe(`T2 · 0 files · +0 −0  Build it  ${note}`)
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
      const pages = [drawn]
      await ui.press({ key: 'next' })
      drawn = await look(ui)
      expect(drawn.texts).toContain('Page 2 of 3')
      pages.push(drawn)
      await ui.press({ key: 'row-2' })
      drawn = await look(ui)
      expect(drawn.texts).toContain('Page 3 of 3')
      expect(drawn.buttons).toContain('Prev')
      expect(drawn.buttons).not.toContain('Next')
      pages.push(drawn)
      const shown = ({ codes, svgs }: typeof drawn) => [
        ...new Set([...codes.map(code => code.path), ...svgs.map(svg => svg.alt.replace(/^Diff of (.+?), @@.*$/, '$1'))]),
      ]
      expect(pages.map(shown)).toEqual([['x.txt'], ['y.txt'], ['z.txt']])
      for (const { texts, codes, svgs } of pages) {
        // one count of what is not shown, past the diff's cap or the drawing's
        expect(texts.filter(text => text.endsWith(' more changed lines not shown'))).toHaveLength(1)
        expect(codes.reduce((sum, code) => sum + code.source.length, 0)).toBeLessThan(100_000)
        for (const { source } of codes) {
          expect(source.length).toBeLessThanOrEqual(CODE_CAP)
          expect(parseHunks(source)).toBeGreaterThan(0)
        }
        // desktop refuses a draw past 262,144 characters
        expect(svgs.reduce((sum, svg) => sum + svg.source.length, 0)).toBeLessThan(200_000)
        for (const { source } of svgs) expect(source.length).toBeLessThanOrEqual(SVG_CAP)
        expect(svgs.length > 0).toBe(surface === 'desktop')
      }
      await ui.press({ key: 'prev' })
      expect((await look(ui)).texts).toContain('Page 2 of 3')
      await ui.press({ key: 'row-0' })
      expect((await look(ui)).texts).toContain('Page 1 of 3')
      await ui.unmount()
    }
  })

  test("on desktop each hunk's Copy button copies its lines as they are now", async ($, on) => {
    const copies: { text: string; surface?: string }[] = []
    on('ui.copy', ($, e) => {
      copies.push({ text: e.text, surface: e.surface })
      return { value: { isCopied: true } }
    })
    const text = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i}\n`).join('')
    world(on, { 'C:\\proj\\a.ts': text })
    await start($, 't1')
    await edit($, 'a.ts', 'v1 = 1', 'v1 = 10')
    await edit($, 'a.ts', 'const v18 = 18\n', '')
    await complete($, 't1')
    const ui = await mountPane($, 'desktop')
    expect((await ui.findAll({ type: 'Button', text: 'Copy' })).map(found => found.key)).toEqual(['copy-0-0', 'copy-0-1'])
    await ui.press({ key: 'copy-0-1' })
    await ui.press({ key: 'copy-0-0' })
    expect(copies).toEqual([
      { text: ['const v15 = 15', 'const v16 = 16', 'const v17 = 17', 'const v19 = 19'].join('\n'), surface: 'desktop' },
      { text: ['const v0 = 0', 'const v1 = 10', 'const v2 = 2', 'const v3 = 3', 'const v4 = 4'].join('\n'), surface: 'desktop' },
    ])
    // the terminal keeps its diff code blocks
    expect(await (await mountPane($, 'terminal')).findAll({ type: 'Button', text: 'Copy' })).toEqual([])
  })

  test('with svgDiffs off desktop draws diff code blocks, as the terminal does', { options: { svgDiffs: false } }, async ($, on) => {
    world(on, { 'C:\\proj\\a.ts': 'const a = 1\n' })
    await start($, 't1')
    await edit($, 'a.ts', '1', '2')
    await complete($, 't1')
    const ui = await mountPane($, 'desktop')
    expect(await ui.findAll({ type: 'Svg' })).toEqual([])
    expect((await ui.findAll({ type: 'Code' })).map(({ props }) => [props.format, props.path, props.source])).toEqual([
      ['diff', 'a.ts', '@@ -1,1 +1,1 @@\n-const a = 1\n+const a = 2'],
    ])
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

  test('the band stays out of the way with no edits, and goes after a turn without them', async ($, on) => {
    world(on, { 'C:\\proj\\a.txt': 'a\n' })
    for (const surface of SURFACES) {
      const band = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      expect(await band.find({ key: 'engine' })).toBeDefined()
    }
    const view = async () => {
      const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
      const found = await band.find({ key: 'view' })
      await band.unmount()
      return found
    }
    await start($, 't1')
    await complete($, 't1')
    expect(await view()).toBeUndefined()
    await start($, 't2')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't2')
    expect(await view()).toBeDefined()
    await start($, 't3', 'Just a question')
    await complete($, 't3')
    expect(await view()).toBeUndefined()
  })

  test('/turn-diff toggles the pane and says what changed', { options: { autoOpen: false } }, async ($, on) => {
    const { panes, rows } = world(on, { 'C:\\proj\\a.txt': 'a\n' })
    /** Runs /turn-diff, its row written to the transcript as a local command's is. */
    const turnDiff = () => (rows.push(command('turn-diff')), $.command.run(RUN))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    expect(await turnDiff()).toMatchObject({ text: 'No finished turn has changed files yet.' })
    expect([...panes]).toEqual(['last-turn-diff'])
    expect(await turnDiff()).toMatchObject({ text: 'Closed the last-turn diff.' })
    expect([...panes]).toEqual([])
    await start($, 't1')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    expect(await turnDiff()).toMatchObject({ text: 'T1 · 1 file · +1 −1: a.txt' })
    // slash commands between turns start no turn: the next one is T2
    await turnDiff()
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
    const said = { text: 'No finished turn has changed files yet. (no pane shown: no attached surface places panes)' }
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
      const { rows, texts, svgs } = await pane($, 'desktop')
      const path = file.replace(/\\/g, '/')
      expect(rows).toEqual([`${path}  +1 −1`])
      expect(texts).toContain('@@ -1,2 +1,2 @@')
      const lines = kind === 'git' ? ['1   one', '2 - two', '2 + TWO'] : ['1   Done ✅', '2 - next', '2 + next ✅']
      expect(svgs.map(svg => svgRows(svg.source))).toEqual([lines])
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
      // a turn with no changes leaves T1 on show
      const { header, rows } = await pane($, 'desktop')
      expect(header).toBe('T1 · 1 file · +1 −1  Fix the thing')
      expect(rows).toEqual(['a.txt  +1 −1'])
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

const REBUILT = 'Rebuilt from the transcript: Edit, Write and NotebookEdit calls only; line endings not compared.'

/** The turn picker as drawn: its options' labels and the value shown; undefined when there is none. */
async function picker(ui: Awaited<ReturnType<typeof mountPane>>) {
  const found = await ui.find({ key: 'turn' })
  if (found === undefined) return undefined
  const options = found.props.options as readonly { value: string; label?: string }[]
  return { labels: options.map(option => option.label), value: found.props.value }
}

describe('turn picker', () => {
  test('lists the transcript turns that changed files; a picked one is rebuilt, the last is the live recording', async ($, on) => {
    world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' })
    await start($, 't1', 'First')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', `Second, with a prompt long enough to be cut in the picker's list\nmore`)
    await edit($, 'b.txt', 'b', 'B')
    await complete($, 't2')
    await start($, 't3', 'Just a question')
    await complete($, 't3')
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await picker(ui)).toEqual({
        labels: ['T1 · 1 file · First', "T2 · 1 file · Second, with a prompt long enough to be cut in the picker's…"],
        value: '2',
      })
      expect((await look(ui)).rows).toEqual(['b.txt  +1 −1'])
      await ui.select({ key: 'turn', value: '1' })
      const { header, rows, codes, svgs } = await look(ui)
      expect(header).toBe(`T1 · 1 file · +1 −1  First  ${REBUILT}`)
      expect(rows).toEqual(['a.txt  +1 −1'])
      if (surface === 'terminal') expect(codes).toEqual([{ path: 'a.txt', source: '@@ -1,1 +1,1 @@\n-a\n+A' }])
      else expect(svgs.map(svg => [svg.alt, svgRows(svg.source)])).toEqual([['Diff of a.txt, @@ -1,1 +1,1 @@', ['1 - a', '1 + A']]])
      expect((await picker(ui))?.value).toBe('1')
      await ui.select({ key: 'turn', value: '2' })
      expect((await look(ui)).header).toBe("T2 · 1 file · +1 −1  Second, with a prompt long enough to be cut in the picker's list")
      await ui.unmount()
    }
  })

  test("a rebuilt turn can't flag the line-ending change its live recording did", async ($, on) => {
    world(on, { [at('a.txt')]: 'one\r\ntwo\r\n' })
    await start($, 't1', 'Rewrite')
    await $.tool.call({ tool: 'Write', file_path: at('a.txt'), content: 'one\nTWO\n' })
    await complete($, 't1')
    expect((await pane($, 'terminal')).rows).toEqual(['a.txt  +1 −1  CRLF→LF'])
    await start($, 't2', 'Next')
    await $.tool.call({ tool: 'Write', file_path: at('b.txt'), content: 'b\n' })
    await complete($, 't2')
    const ui = await mountPane($, 'terminal')
    await ui.select({ key: 'turn', value: '1' })
    const { header, rows, texts, codes } = await look(ui)
    expect(header).toBe(`T1 · 1 file · +1 −1  Rewrite  ${REBUILT}`)
    expect(rows).toEqual(['a.txt  +1 −1'])
    expect(texts.filter(text => text.includes('line endings'))).toEqual([REBUILT])
    expect(codes).toEqual([{ path: 'a.txt', source: '@@ -1,2 +1,2 @@\n one\n-two\n+TWO' }])
  })

  test('history survives --resume: the newest turn shows rebuilt, the next live one is numbered after it', async ($, on) => {
    const transcript = [
      prompt('Old one'),
      ...editRow(at('a.txt'), 'a\n', 'a', 'A'),
      reply(),
      command('turn-diff'),
      prompt('Old two'),
      ...write(at('new.txt'), 'hello\n', null),
      reply(),
    ]
    world(on, { [at('a.txt')]: 'A\n', [at('new.txt')]: 'hello\n' }, { transcript })
    await begin($)
    // /turn-diff says what the pane shows
    expect(await $.command.run(RUN)).toMatchObject({ text: 'T2 · 1 file · +1 −0: new.txt' })
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · Old one', 'T2 · 1 file · Old two'], value: '2' })
      const { header, rows } = await look(ui)
      expect(header).toBe(`T2 · 1 file · +1 −0  Old two  ${REBUILT}`)
      expect(rows).toEqual(['new.txt  +1 −0  new'])
      // the band is for a turn this session finished
      const band = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      expect(await band.find({ key: 'engine' })).toBeDefined()
      await ui.unmount()
    }
    await start($, 't3', 'New one')
    await edit($, 'a.txt', 'A', 'a')
    await complete($, 't3')
    const ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({
      labels: ['T1 · 1 file · Old one', 'T2 · 1 file · Old two', 'T3 · 1 file · New one'],
      value: '3',
    })
    expect((await look(ui)).header).toBe('T3 · 1 file · +1 −1  New one')
  })

  test('a resumed file past ~10 KB, whose original the transcript drops, shows call by call', async ($, on) => {
    const text = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}\n`).join('')
    const later = text.replace('line 3\n', 'LINE 3\n')
    const transcript = [
      prompt('Big'),
      ...editRow(at('big.txt'), text, 'line 3\n', 'LINE 3\n', null),
      ...editRow(at('big.txt'), later, 'line 1900\n', 'LINE 1900\n', null),
      reply(),
    ]
    world(on, { [at('big.txt')]: later.replace('line 1900\n', 'LINE 1900\n') }, { transcript })
    await begin($)
    const { header, rows, texts, codes } = await pane($, 'terminal')
    expect(header).toBe(`T1 · 1 file · +2 −2  Big  ${REBUILT}`)
    expect(rows).toEqual(['big.txt  +2 −2'])
    expect(texts).toContain('shown call by call: the transcript keeps no copy of this file')
    expect(codes.map(code => code.source.match(/^@@.*@@$/gm))).toEqual([['@@ -1,6 +1,6 @@', '@@ -1897,7 +1897,7 @@']])
  })

  test("local slash commands open no turn; a skill's command does, shown as typed", async ($, on) => {
    const { rows } = world(on, { [at('a.txt')]: 'a\n' })
    await start($, 't1', 'First')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    rows.push(command('effort', 'high'), command('turn-diff'))
    await start($, 't2', skill('review', '42').text)
    await edit($, 'a.txt', 'A', 'a')
    await complete($, 't2')
    const ui = await mountPane($, 'desktop')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · First', 'T2 · 1 file · /review 42'], value: '2' })
    expect((await look(ui)).header).toBe('T2 · 1 file · +1 −1  /review 42')
  })

  test('only the newest 4,096 entries are read: a turn they cut is left out, the numbering starts after it', async ($, on) => {
    const reads = Array.from({ length: 2100 }, () => call('Read', { file_path: at('a.txt') })).flat()
    const transcript = [
      prompt('Cut off'),
      ...editRow(at('a.txt'), 'a\n', 'a', 'A'),
      ...reads,
      reply(),
      prompt('Kept'),
      ...editRow(at('b.txt'), 'b\n', 'b', 'B'),
      reply(),
    ]
    world(on, { [at('a.txt')]: 'A\n', [at('b.txt')]: 'B\n', [at('c.txt')]: 'c\n' }, { transcript })
    await begin($)
    let ui = await mountPane($, 'terminal')
    // one turn, nothing to pick
    expect(await picker(ui)).toBeUndefined()
    expect((await look(ui)).header).toBe(`T1 · 1 file · +1 −1  Kept  ${REBUILT}`)
    await ui.unmount()
    await start($, 't2', 'New')
    await edit($, 'c.txt', 'c', 'C')
    await complete($, 't2')
    ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · Kept', 'T2 · 1 file · New'], value: '2' })
  })

  test("a turn with no prompt row (a continuation) is numbered after the transcript's last", async ($, on) => {
    world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' })
    await start($, 't1', 'First')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', '')
    await edit($, 'b.txt', 'b', 'B')
    await complete($, 't2')
    const ui = await mountPane($, 'terminal')
    // the transcript has no row to split them at: its T1 holds both
    expect(await picker(ui)).toEqual({ labels: ['T1 · 2 files · First', 'T2 · 1 file'], value: '2' })
    expect((await look(ui)).header).toBe('T2 · 1 file · +1 −1')
    await ui.select({ key: 'turn', value: '1' })
    expect((await look(ui)).rows).toEqual(['a.txt  +1 −1', 'b.txt  +1 −1'])
  })

  test('read mid-turn (after a reload or a resume), the running turn is not offered until it ends', async ($, on) => {
    const transcript = [prompt('Old one'), ...editRow(at('a.txt'), 'a\n', 'a', 'A'), reply(), prompt('Old two'), reply()]
    world(on, { [at('a.txt')]: 'A\n', [at('b.txt')]: 'b\n' }, { transcript })
    await begin($)
    await start($, 't3', 'Running')
    await edit($, 'b.txt', 'b', 'B')
    // Old two changed nothing: the newest turn with changes is shown, and the only one to pick
    let ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toBeUndefined()
    expect((await look(ui)).header).toBe(`T1 · 1 file · +1 −1  Old one  ${REBUILT}`)
    await ui.unmount()
    await complete($, 't3')
    ui = await mountPane($, 'terminal')
    expect((await picker(ui))?.labels).toEqual(['T1 · 1 file · Old one', 'T3 · 1 file · Running'])
    expect((await look(ui)).header).toBe('T3 · 1 file · +1 −1  Running')
  })

  test('a picked turn opens on its first page; the next turn shows itself', async ($, on) => {
    const big = (tag: string) => Array.from({ length: 4000 }, (_, i) => `${tag} ${i}\n`).join('')
    world(on, { [at('x.txt')]: big('x'), [at('y.txt')]: big('y'), [at('z.txt')]: big('z'), [at('a.txt')]: 'a\n' })
    await start($, 't1', 'Big')
    for (const tag of ['x', 'y', 'z']) await $.tool.call({ tool: 'Write', file_path: at(`${tag}.txt`), content: big(tag.toUpperCase()) })
    await complete($, 't1')
    await start($, 't2', 'Small')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't2')
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await look(ui)).texts.filter(text => text.startsWith('Page'))).toEqual([])
      await ui.select({ key: 'turn', value: '1' })
      expect((await look(ui)).texts).toContain('Page 1 of 3')
      await ui.press({ key: 'next' })
      expect((await look(ui)).texts).toContain('Page 2 of 3')
      await ui.select({ key: 'turn', value: '2' })
      expect((await look(ui)).rows).toEqual(['a.txt  +1 −1'])
      await ui.select({ key: 'turn', value: '1' })
      const drawn = await look(ui)
      expect(drawn.texts).toContain('Page 1 of 3')
      expect(drawn.rows).toEqual(['x.txt  +4000 −4000', 'y.txt  +4000 −4000', 'z.txt  +4000 −4000'])
      // the pick is the session's, not the drawing's: back to the newest for the next surface, T1 left for the last
      if (surface !== 'desktop') await ui.select({ key: 'turn', value: '2' })
      await ui.unmount()
    }
    await start($, 't3', 'Third')
    await edit($, 'a.txt', 'A', 'a')
    await complete($, 't3')
    const ui = await mountPane($, 'terminal')
    expect((await picker(ui))?.value).toBe('3')
  })

  test('View on the band and /turn-diff show the newest turn again', { options: { autoOpen: false } }, async ($, on) => {
    world(on, { [at('a.txt')]: 'a\n' })
    await start($, 't1', 'There')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', 'Back')
    await edit($, 'a.txt', 'A', 'a')
    await complete($, 't2')
    const pick = async () => {
      const ui = await mountPane($, 'terminal')
      await ui.select({ key: 'turn', value: '1' })
      expect((await look(ui)).header).toBe(`T1 · 1 file · +1 −1  There  ${REBUILT}`)
      await ui.unmount()
    }
    await pick()
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    await band.press({ key: 'view' })
    expect((await pane($, 'terminal')).header).toBe('T2 · 1 file · +1 −1  Back')
    await pick()
    // View left the pane open: the first /turn-diff closes it, the second opens it on the newest turn
    expect(await $.command.run(RUN)).toMatchObject({ text: 'Closed the last-turn diff.' })
    expect(await $.command.run(RUN)).toMatchObject({ text: 'T2 · 1 file · +1 −1: a.txt' })
    expect((await pane($, 'desktop')).header).toBe('T2 · 1 file · +1 −1  Back')
  })

  test('a /compact drops the turns before it: a picked one falls back to the newest, numbered from the summary', async ($, on) => {
    const { reads } = world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' })
    await start($, 't1', 'One')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', 'Two')
    await edit($, 'b.txt', 'b', 'B')
    await complete($, 't2')
    const ui = await mountPane($, 'terminal')
    await ui.select({ key: 'turn', value: '1' })
    expect((await look(ui)).header).toBe(`T1 · 1 file · +1 −1  One  ${REBUILT}`)
    await ui.unmount()
    // a subagent's compaction leaves the main transcript, and what was read of it, alone
    const read = reads()
    await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: [prompt('Sub')] })
    expect((await pane($, 'terminal')).header).toBe(`T1 · 1 file · +1 −1  One  ${REBUILT}`)
    expect(reads()).toBe(read)
    // no session.start: the compaction alone says the transcript changed
    await $.session.compact({ trigger: 'manual', messages: [prompt('One'), reply(), prompt('Two'), reply()] })
    const drawn = await mountPane($, 'terminal')
    expect(await picker(drawn)).toBeUndefined()
    expect((await look(drawn)).header).toBe('T1 · 1 file · +1 −1  Two')
    await drawn.unmount()
    // a turn with no changes after it keeps its number
    await start($, 't3', 'Three')
    await complete($, 't3')
    expect((await pane($, 'terminal')).header).toBe('T1 · 1 file · +1 −1  Two')
    await start($, 't4', 'Four')
    await edit($, 'a.txt', 'A', 'a')
    await complete($, 't4')
    expect((await pane($, 'terminal')).header).toBe('T2 · 1 file · +1 −1  Four')
  })

  test('a /clear or a resume starts another conversation: its turns alone, from the first page, no band', async ($, on) => {
    const big = (tag: string) => Array.from({ length: 4000 }, (_, i) => `${tag} ${i}\n`).join('')
    const { swap } = world(on, { [at('x.txt')]: big('x'), [at('y.txt')]: big('y'), [at('z.txt')]: big('z'), [at('a.txt')]: 'a\n' })
    const end = (reason: 'clear' | 'resume', id: string) => $.session.end({ reason, sessionId: id, resume: { id } })
    /** The band's View button, if it shows. */
    const band = async () => {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
      const view = await ui.find({ key: 'view' })
      await ui.unmount()
      return view
    }
    await start($, 't1', 'One')
    for (const tag of ['x', 'y', 'z']) await $.tool.call({ tool: 'Write', file_path: at(`${tag}.txt`), content: big(tag.toUpperCase()) })
    await complete($, 't1')
    await start($, 't2', 'Two')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't2')
    // T1 picked, on its second page
    const ui = await mountPane($, 'desktop')
    expect((await picker(ui))?.labels).toEqual(['T1 · 3 files · One', 'T2 · 1 file · Two'])
    await ui.select({ key: 'turn', value: '1' })
    await ui.press({ key: 'next' })
    expect((await look(ui)).texts).toContain('Page 2 of 3')
    await ui.unmount()
    expect(await band()).toBeDefined()
    // no session.start follows: the session goes on under another id
    await end('clear', SESSION)
    expect(await band()).toBeUndefined()
    // drawn before the next conversation is in place: nothing of the one that ended
    expect((await pane($, 'terminal')).texts).toEqual(['No finished turn has changed files yet.'])
    swap('cd34', [])
    expect((await pane($, 'terminal')).texts).toEqual(['No finished turn has changed files yet.'])
    await end('resume', 'cd34')
    swap('ef56', [
      prompt('One'),
      ...editRow(at('a.txt'), 'A\n', 'A', 'a'),
      reply(),
      prompt('Other two'),
      ...['x', 'y', 'z'].flatMap(tag => write(at(`${tag}.txt`), big(tag), big(tag.toUpperCase()))),
      reply(),
    ])
    const drawn = await mountPane($, 'terminal')
    // the old pick (T1 · One) and page are gone with the old conversation
    expect(await picker(drawn)).toEqual({ labels: ['T1 · 1 file · One', 'T2 · 3 files · Other two'], value: '2' })
    const { header, texts } = await look(drawn)
    expect(header).toBe(`T2 · 3 files · +12000 −12000  Other two  ${REBUILT}`)
    expect(texts).toContain('Page 1 of 3')
  })

  test('the transcript is read when a turn is first shown after it ends, and again to rebuild a pick', { options: { autoOpen: false } }, async ($, on) => {
    const { reads } = world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' })
    await start($, 't1', 'One')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', 'Two')
    await edit($, 'b.txt', 'b', 'B')
    await complete($, 't2')
    // nothing drawn, nothing read
    expect(reads()).toBe(0)
    let ui = await mountPane($, 'terminal')
    expect(reads()).toBe(1)
    await ui.unmount()
    ui = await mountPane($, 'desktop')
    expect(reads()).toBe(1)
    await ui.select({ key: 'turn', value: '1' })
    expect(reads()).toBe(2)
    // the live turn and the turn last rebuilt are drawn from memory
    await ui.select({ key: 'turn', value: '2' })
    await ui.select({ key: 'turn', value: '1' })
    expect(reads()).toBe(2)
    await ui.unmount()
    await start($, 't3', 'Three')
    await complete($, 't3')
    expect(reads()).toBe(2)
    expect(await $.command.run(RUN)).toMatchObject({ text: 'T2 · 1 file · +1 −1: b.txt' })
    expect(reads()).toBe(3)
  })

  test('turns with the same prompt are told apart by number', async ($, on) => {
    world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n', [at('c.txt')]: 'c\n' })
    // T3 changes nothing: once T4 is recorded, it no longer counts
    for (const [turn, file] of [['t1', 'a'], ['t2', 'b'], ['t3', ''], ['t4', 'c']] as const) {
      await start($, turn, 'go on')
      if (file !== '') await edit($, `${file}.txt`, file, file.toUpperCase())
      await complete($, turn)
    }
    const ui = await mountPane($, 'terminal')
    expect((await picker(ui))?.labels).toEqual(['T1 · 1 file · go on', 'T2 · 1 file · go on', 'T4 · 1 file · go on'])
    for (const [value, row] of [['2', 'b.txt'], ['1', 'a.txt'], ['4', 'c.txt'], ['2', 'b.txt']] as const) {
      await ui.select({ key: 'turn', value })
      expect([(await picker(ui))?.value, (await look(ui)).rows]).toEqual([value, [`${row}  +1 −1`]])
    }
  })

  test('a `!` command after a turn is not a turn: the last turn keeps its number', { options: { autoOpen: false } }, async ($, on) => {
    const { rows } = world(on, { [at('a.txt')]: 'a\n' })
    await start($, 't1', 'Fix')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    rows.push(prompt('<bash-input>git status</bash-input>'), prompt('<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>'))
    expect(await $.command.run(RUN)).toMatchObject({ text: 'T1 · 1 file · +1 −1: a.txt' })
    const ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toBeUndefined()
    expect((await look(ui)).header).toBe('T1 · 1 file · +1 −1  Fix')
  })

  test('a draw while a turn ends shows the turn before it, as it was, until this one is in', async ($, on) => {
    let reached: () => void = () => undefined
    let release: () => void = () => undefined
    const atEnd = new Promise<void>(resolve => (reached = resolve))
    const held = new Promise<void>(resolve => (release = resolve))
    // statuses: T1 start (1), T1 end (2), T2 start (3), T2 end (4)
    const onStatus = (n: number) => (n === 4 ? (reached(), held) : undefined)
    world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' }, { vcs: 'git', onStatus })
    await begin($)
    await start($, 't1', 'One')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', 'Two')
    await edit($, 'b.txt', 'b', 'B')
    // drawn mid-turn: the running turn is left out
    const mid = await mountPane($, 'desktop')
    expect(await picker(mid)).toBeUndefined()
    await mid.unmount()
    const ending = complete($, 't2')
    await atEnd
    expect((await pane($, 'terminal')).header).toBe('T1 · 1 file · +1 −1  One')
    release()
    await ending
    const ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · One', 'T2 · 1 file · Two'], value: '2' })
    expect((await look(ui)).header).toBe('T2 · 1 file · +1 −1  Two')
  })

  test('the picker lists the newest 64 turns, all a Select takes; the pane still draws past them', async ($, on) => {
    const transcript = Array.from({ length: 205 }, (_, i) => [
      prompt(`Fix ${i + 1}`),
      ...editRow(at(`f${i + 1}.txt`), 'a\n', 'a', 'A'),
      reply(),
    ]).flat()
    world(on, {}, { transcript })
    await begin($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const found = await picker(ui)
      expect([found?.labels.length, found?.labels[0], found?.labels[63], found?.value]).toEqual([
        64,
        'T142 · 1 file · Fix 142',
        'T205 · 1 file · Fix 205',
        '205',
      ])
      await ui.select({ key: 'turn', value: '142' })
      expect((await look(ui)).header).toBe(`T142 · 1 file · +1 −1  Fix 142  ${REBUILT}`)
      await ui.select({ key: 'turn', value: '205' })
      await ui.unmount()
    }
  })

  test("a drawing is not reused for another conversation's turn of the same number, prompt and counts", async ($, on) => {
    const { swap } = world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' })
    await start($, 't1', 'fix')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', 'other')
    await edit($, 'b.txt', 'b', 'B')
    await complete($, 't2')
    const pickFirst = async () => {
      const ui = await mountPane($, 'desktop')
      await ui.select({ key: 'turn', value: '1' })
      const { header, svgs } = await look(ui)
      await ui.unmount()
      return [header, svgs.map(svg => svgRows(svg.source))]
    }
    expect(await pickFirst()).toEqual([`T1 · 1 file · +1 −1  fix  ${REBUILT}`, [['1 - a', '1 + A']]])
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
    swap('cd34', [prompt('fix'), ...editRow(at('a.txt'), 'x\n', 'x', 'X'), reply(), prompt('other'), ...editRow(at('b.txt'), 'b\n', 'b', 'B'), reply()])
    expect(await pickFirst()).toEqual([`T1 · 1 file · +1 −1  fix  ${REBUILT}`, [['1 - x', '1 + X']]])
  })

  test('a pick among turns with the same prompt stays on its turn when the window slides under it', async ($, on) => {
    const reads = Array.from({ length: 2043 }, () => call('Read', { file_path: at('a.txt') })).flat()
    const transcript = [prompt('Oldest'), ...reads, reply(), prompt('go on'), ...editRow(at('b.txt'), 'b\n', 'b', 'B'), reply()]
    const { rows } = world(on, { [at('b.txt')]: 'B\n', [at('c.txt')]: 'c\n' }, { transcript })
    await start($, 't3', 'go on')
    await edit($, 'c.txt', 'c', 'C')
    await complete($, 't3')
    const ui = await mountPane($, 'terminal')
    expect((await picker(ui))?.labels).toEqual(['T2 · 1 file · go on', 'T3 · 1 file · go on'])
    rows.push(command('effort', 'high'), command('turn-diff'), command('turn-diff'))
    // T2 as drawn: the first "go on", b.txt, which the slide numbers T1
    await ui.select({ key: 'turn', value: '2' })
    const { header, rows: files } = await look(ui)
    expect([header, files]).toEqual([`T1 · 1 file · +1 −1  go on  ${REBUILT}`, ['b.txt  +1 −1']])
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · go on', 'T2 · 1 file · go on'], value: '1' })
  })

  test('a first draw while a turn ends, with nothing read before, numbers the turn before it right', async ($, on) => {
    let reached: () => void = () => undefined
    let release: () => void = () => undefined
    const atEnd = new Promise<void>(resolve => (reached = resolve))
    const held = new Promise<void>(resolve => (release = resolve))
    const onStatus = (n: number) => (n === 4 ? (reached(), held) : undefined)
    world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' }, { vcs: 'git', onStatus })
    await begin($)
    await start($, 't1', 'One')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', 'Two')
    await edit($, 'b.txt', 'b', 'B')
    const ending = complete($, 't2')
    await atEnd
    const ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toBeUndefined()
    expect((await look(ui)).header).toBe('T1 · 1 file · +1 −1  One')
    await ui.unmount()
    release()
    await ending
    expect((await pane($, 'terminal')).header).toBe('T2 · 1 file · +1 −1  Two')
  })

  test('a turn that ends unrecorded (its turn.start never reached the mod) is listed all the same', async ($, on) => {
    const transcript = [prompt('Old'), ...editRow(at('a.txt'), 'a\n', 'a', 'A'), reply()]
    const { rows } = world(on, { [at('a.txt')]: 'A\n', [at('b.txt')]: 'B\n' }, { transcript })
    await begin($)
    expect((await pane($, 'terminal')).header).toBe(`T1 · 1 file · +1 −1  Old  ${REBUILT}`)
    // only its rows and its end
    rows.push(prompt('Outside'), ...editRow(at('b.txt'), 'b\n', 'b', 'B'))
    await complete($, 't-outside')
    const ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · Old', 'T2 · 1 file · Outside'], value: '2' })
    expect((await look(ui)).header).toBe(`T2 · 1 file · +1 −1  Outside  ${REBUILT}`)
  })

  test("a turn with no prompt row is the transcript's next, whatever older turn has its prompt", async ($, on) => {
    const { rows } = world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' })
    // an image alone: a row whose text is '', the prompt a continuation has too
    rows.push(prompt(''))
    await start($, 't1', '')
    await complete($, 't1')
    await start($, 't2', 'Fix')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't2')
    await start($, 't3', '')
    await edit($, 'b.txt', 'b', 'B')
    await complete($, 't3')
    const ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T2 · 2 files · Fix', 'T3 · 1 file'], value: '3' })
    expect((await look(ui)).rows).toEqual(['b.txt  +1 −1'])
  })

  test('a session.end with no new id after it (a resume that failed) hides nothing once a turn runs', async ($, on) => {
    world(on, { [at('a.txt')]: 'a\n' })
    await $.session.end({ reason: 'resume', sessionId: SESSION, resume: { id: SESSION } })
    await start($, 't1', 'Still here')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    expect(await $.command.run(RUN)).toMatchObject({ text: 'Closed the last-turn diff.' })
    expect(await $.command.run(RUN)).toMatchObject({ text: 'T1 · 1 file · +1 −1: a.txt' })
    expect((await pane($, 'desktop')).header).toBe('T1 · 1 file · +1 −1  Still here')
  })

  test('a transcript that cannot be read leaves the live turn on show, numbered from nothing', async ($, on) => {
    world(on, { [at('a.txt')]: 'a\n' }, { transcript: [prompt('Old'), reply()], isTranscriptBroken: true })
    await start($, 't1', 'Fix')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    const ui = await mountPane($, 'desktop')
    expect(await picker(ui)).toBeUndefined()
    expect((await look(ui)).header).toBe('T1 · 1 file · +1 −1  Fix')
  })

  test("a prompt cut for the picker's list never splits an emoji", async ($, on) => {
    world(on, { [at('a.txt')]: 'a\n' })
    await start($, 't1', 'First')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', `x${'😀'.repeat(70)}`)
    await edit($, 'a.txt', 'A', 'a')
    await complete($, 't2')
    expect((await picker(await mountPane($, 'desktop')))?.labels).toEqual(['T1 · 1 file · First', `T2 · 1 file · x${'😀'.repeat(58)}…`])
  })

  test('turnHistory off: the transcript is never read, no picker, the last turn numbered since the mod loaded', { options: { turnHistory: false } }, async ($, on) => {
    const transcript = [prompt('Old one'), ...editRow(at('a.txt'), 'x\n', 'x', 'a'), reply(), prompt('Old two'), reply()]
    const { rows, reads } = world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' }, { transcript })
    await begin($)
    // a resumed session's turns are not shown
    expect(await $.command.run(RUN)).toMatchObject({ text: 'No finished turn has changed files yet.' })
    expect((await pane($, 'desktop')).texts).toEqual(['No finished turn has changed files yet.'])
    await start($, 't1', 'First')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    // slash commands start no turn: the next one is T2
    rows.push(command('turn-diff'))
    await start($, 't2', 'Second')
    await edit($, 'b.txt', 'b', 'B')
    await complete($, 't2')
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await picker(ui)).toBeUndefined()
      expect((await look(ui)).header).toBe('T2 · 1 file · +1 −1  Second')
      await ui.unmount()
    }
    expect(await $.command.run(RUN)).toMatchObject({ text: 'Closed the last-turn diff.' })
    expect(await $.command.run(RUN)).toMatchObject({ text: 'T2 · 1 file · +1 −1: b.txt' })
    // a turn without changes leaves T2 on show
    await start($, 't3', 'Just a question')
    await complete($, 't3')
    expect((await pane($, 'terminal')).header).toBe('T2 · 1 file · +1 −1  Second')
    expect(reads()).toBe(0)
  })

  test('a pick stays on its turn when the 4,096-entry window slides under it', async ($, on) => {
    // 4,086 rows of reads: with the turns below the window is full once T3 ends
    const reads = Array.from({ length: 2043 }, () => call('Read', { file_path: at('a.txt') })).flat()
    const transcript = [prompt('Oldest'), ...reads, reply(), prompt('Second'), ...editRow(at('b.txt'), 'b\n', 'b', 'B'), reply()]
    const { rows } = world(on, { [at('b.txt')]: 'B\n', [at('c.txt')]: 'c\n' }, { transcript })
    await start($, 't3', 'Third')
    await edit($, 'c.txt', 'c', 'C')
    await complete($, 't3')
    expect(rows).toHaveLength(4096)
    const ui = await mountPane($, 'terminal')
    expect((await picker(ui))?.labels).toEqual(['T2 · 1 file · Second', 'T3 · 1 file · Third'])
    // slash commands between the drawing and the pick push the oldest turn out
    rows.push(command('effort', 'high'), command('turn-diff'), command('turn-diff'))
    await ui.select({ key: 'turn', value: '2' })
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · Second', 'T2 · 1 file · Third'], value: '1' })
    expect((await look(ui)).header).toBe(`T1 · 1 file · +1 −1  Second  ${REBUILT}`)
    await ui.select({ key: 'turn', value: '2' })
    expect((await look(ui)).header).toBe('T2 · 1 file · +1 −1  Third')
  })

  test('View on the band and /turn-diff go back to the first page of the newest turn', { options: { autoOpen: false } }, async ($, on) => {
    const big = (tag: string) => Array.from({ length: 4000 }, (_, i) => `${tag} ${i}\n`).join('')
    world(on, { [at('x.txt')]: big('x'), [at('y.txt')]: big('y'), [at('z.txt')]: big('z') })
    for (const [turn, isUpper] of [['t1', true], ['t2', false]] as const) {
      await start($, turn, `Case ${isUpper ? 'X' : 'x'}`)
      for (const tag of ['x', 'y', 'z']) {
        await $.tool.call({ tool: 'Write', file_path: at(`${tag}.txt`), content: big(isUpper ? tag.toUpperCase() : tag) })
      }
      await complete($, turn)
    }
    const pickLastPage = async () => {
      const ui = await mountPane($, 'terminal')
      await ui.select({ key: 'turn', value: '1' })
      await ui.press({ key: 'next' })
      await ui.press({ key: 'next' })
      expect((await look(ui)).texts).toContain('Page 3 of 3')
      await ui.unmount()
    }
    await pickLastPage()
    await (await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })).press({ key: 'view' })
    let drawn = await pane($, 'terminal')
    expect(drawn.header).toBe('T2 · 3 files · +12000 −12000  Case x')
    expect(drawn.texts).toContain('Page 1 of 3')
    await pickLastPage()
    // View left the pane open: the first /turn-diff closes it, the second opens it
    await $.command.run(RUN)
    await $.command.run(RUN)
    drawn = await pane($, 'terminal')
    expect(drawn.header).toBe('T2 · 3 files · +12000 −12000  Case x')
    expect(drawn.texts).toContain('Page 1 of 3')
  })

  test("a rebuilt turn holds Claude's own calls, not shell changes", async ($, on) => {
    world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' }, { vcs: 'git', shell: { fix: fs => fs.put(at('b.txt'), 'B\n') } })
    await begin($)
    await start($, 't1', 'Mixed')
    await edit($, 'a.txt', 'a', 'A')
    await bash($, 'fix')
    await complete($, 't1')
    expect((await pane($, 'terminal')).rows).toEqual(['a.txt  +1 −1', 'b.txt  +1 −1'])
    await start($, 't2', 'Next')
    await edit($, 'a.txt', 'A', 'a')
    await complete($, 't2')
    const ui = await mountPane($, 'terminal')
    await ui.select({ key: 'turn', value: '1' })
    expect((await look(ui)).rows).toEqual(['a.txt  +1 −1'])
  })

  test('turns without changes are not listed and leave the pane as it was: its turn, pick and page', async ($, on) => {
    const big = (tag: string) => Array.from({ length: 4000 }, (_, i) => `${tag} ${i}\n`).join('')
    world(on, { [at('x.txt')]: big('x'), [at('y.txt')]: big('y'), [at('z.txt')]: big('z'), [at('a.txt')]: 'a\n' })
    await start($, 't1', 'Big')
    for (const tag of ['x', 'y', 'z']) await $.tool.call({ tool: 'Write', file_path: at(`${tag}.txt`), content: big(tag.toUpperCase()) })
    await complete($, 't1')
    await start($, 't2', 'Small')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't2')
    let ui = await mountPane($, 'desktop')
    await ui.select({ key: 'turn', value: '1' })
    await ui.press({ key: 'next' })
    await ui.unmount()
    for (const [turn, text] of [['t3', 'Just a question'], ['t4', 'Small']] as const) {
      await start($, turn, text)
      await complete($, turn)
    }
    ui = await mountPane($, 'desktop')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 3 files · Big', 'T2 · 1 file · Small'], value: '1' })
    expect((await look(ui)).texts).toContain('Page 2 of 3')
    // the live T2 keeps its number, though the last turn has its prompt
    await ui.select({ key: 'turn', value: '2' })
    expect((await look(ui)).header).toBe('T2 · 1 file · +1 −1  Small')
    await ui.unmount()
    await start($, 't5', 'More')
    await edit($, 'a.txt', 'A', 'a')
    await complete($, 't5')
    ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 3 files · Big', 'T2 · 1 file · Small', 'T5 · 1 file · More'], value: '5' })
    await ui.select({ key: 'turn', value: '2' })
    expect((await look(ui)).header).toBe(`T2 · 1 file · +1 −1  Small  ${REBUILT}`)
  })

  test('a draw while a turn without changes ends keeps the last turn and its number', async ($, on) => {
    let reached: () => void = () => undefined
    let release: () => void = () => undefined
    const atEnd = new Promise<void>(resolve => (reached = resolve))
    const held = new Promise<void>(resolve => (release = resolve))
    const onStatus = (n: number) => (n === 4 ? (reached(), held) : undefined)
    world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' }, { vcs: 'git', onStatus })
    await begin($)
    await start($, 't1', 'One')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    await start($, 't2', 'Two')
    const ending = complete($, 't2')
    await atEnd
    expect((await pane($, 'terminal')).header).toBe('T1 · 1 file · +1 −1  One')
    release()
    await ending
    expect((await pane($, 'terminal')).header).toBe('T1 · 1 file · +1 −1  One')
    await start($, 't3', 'Three')
    await edit($, 'b.txt', 'b', 'B')
    await complete($, 't3')
    const ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · One', 'T3 · 1 file · Three'], value: '3' })
  })

  test('a turn that ends unrecorded after the last turn leaves its number alone, and shows as the newest', async ($, on) => {
    const { rows } = world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'B\n' })
    await start($, 't1', 'Mine')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    // only its rows and its end
    rows.push(prompt('Outside'), ...editRow(at('b.txt'), 'b\n', 'b', 'B'))
    await complete($, 't-outside')
    const ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · Mine', 'T2 · 1 file · Outside'], value: '2' })
    expect((await look(ui)).header).toBe(`T2 · 1 file · +1 −1  Outside  ${REBUILT}`)
    await ui.select({ key: 'turn', value: '1' })
    expect((await look(ui)).header).toBe('T1 · 1 file · +1 −1  Mine')
  })

  test('turns without changes and with no prompt row (continuations) or an empty one (an image alone) keep the number', async ($, on) => {
    const { rows } = world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' })
    for (const [turn, text] of [['t1', 'go on'], ['t2', 'go on']] as const) {
      await start($, turn, text)
      await edit($, turn === 't1' ? 'a.txt' : 'b.txt', turn === 't1' ? 'a' : 'b', 'X')
      await complete($, turn)
    }
    await start($, 't3', '')
    await complete($, 't3')
    rows.push(prompt(''))
    await start($, 't4', '')
    await complete($, 't4')
    await start($, 't5', '')
    await complete($, 't5')
    let ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · go on', 'T2 · 1 file · go on'], value: '2' })
    expect((await look(ui)).rows).toEqual(['b.txt  +1 −1'])
    await ui.unmount()
    await start($, 't6', 'Next')
    await edit($, 'a.txt', 'X', 'a')
    await complete($, 't6')
    // the image's row is T3, the continuations have none
    ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · go on', 'T2 · 1 file · go on', 'T4 · 1 file · Next'], value: '4' })
  })

  test('a turn whose edits cancel out is not listed, and leaves a pick among same prompts where it was', async ($, on) => {
    world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n', [at('c.txt')]: 'c\n', [at('d.txt')]: 'd\n' })
    for (const [turn, file] of [['t1', 'a'], ['t2', 'b'], ['t3', 'c']] as const) {
      await start($, turn, 'go on')
      await edit($, `${file}.txt`, file, file.toUpperCase())
      await complete($, turn)
    }
    let ui = await mountPane($, 'terminal')
    await ui.select({ key: 'turn', value: '2' })
    await ui.unmount()
    await start($, 't4', 'Try and undo')
    await edit($, 'd.txt', 'd', 'X')
    await edit($, 'd.txt', 'X', 'd')
    await complete($, 't4')
    ui = await mountPane($, 'terminal')
    expect((await picker(ui))?.labels).toEqual(['T1 · 1 file · go on', 'T2 · 1 file · go on', 'T3 · 1 file · go on'])
    expect([(await picker(ui))?.value, (await look(ui)).rows]).toEqual(['2', ['b.txt  +1 −1']])
    await ui.select({ key: 'turn', value: '3' })
    expect((await look(ui)).header).toBe('T3 · 1 file · +1 −1  go on')
  })

  test('a turn whose edits cancel out is not shown before any turn has changes, nor after a resume', async ($, on) => {
    const transcript = [prompt('go on'), ...editRow(at('a.txt'), 'a\n', 'a', 'A'), reply(), prompt('go on'), ...editRow(at('b.txt'), 'b\n', 'b', 'B'), reply()]
    const { swap } = world(on, { [at('a.txt')]: 'A\n', [at('b.txt')]: 'B\n', [at('c.txt')]: 'c\n' })
    // its prompt is one of the resumed conversation's too: the resume forgets it
    await start($, 't1', 'go on')
    await edit($, 'c.txt', 'c', 'X')
    await edit($, 'c.txt', 'X', 'c')
    await complete($, 't1')
    expect((await pane($, 'terminal')).texts).toEqual(['No finished turn has changed files yet.'])
    await $.session.end({ reason: 'resume', sessionId: SESSION, resume: { id: 'cd34' } })
    swap('cd34', transcript)
    let ui = await mountPane($, 'terminal')
    await ui.select({ key: 'turn', value: '1' })
    await ui.unmount()
    await start($, 't2', 'go on')
    await edit($, 'c.txt', 'c', 'X')
    await edit($, 'c.txt', 'X', 'c')
    await complete($, 't2')
    ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · go on', 'T2 · 1 file · go on'], value: '1' })
    expect((await look(ui)).rows).toEqual(['a.txt  +1 −1'])
  })

  test('turns without changes whose prompt has no row (a message from another session) keep the number', async ($, on) => {
    const { rows } = world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' })
    await start($, 't1', 'A')
    await edit($, 'a.txt', 'a', 'X')
    await complete($, 't1')
    await start($, 't2', '')
    await edit($, 'b.txt', 'b', 'X')
    await complete($, 't2')
    for (const turn of ['t3', 't4']) {
      await start($, turn, `From another session ${turn}`)
      rows.pop()
      await complete($, turn)
    }
    const ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 2 files · A', 'T2 · 1 file'], value: '2' })
    expect((await look(ui)).rows).toEqual(['b.txt  +1 −1'])
  })

  test('mixed turns after the last one place it: unrecorded, continuation, image alone, question', async ($, on) => {
    const { rows } = world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n', [at('c.txt')]: 'C\n' })
    await start($, 't1', 'A')
    await edit($, 'a.txt', 'a', 'X')
    await complete($, 't1')
    await start($, 't2', 'Fix')
    await edit($, 'b.txt', 'b', 'X')
    await complete($, 't2')
    rows.push(prompt('Outside'), ...editRow(at('c.txt'), 'c\n', 'c', 'C'))
    await complete($, 't-outside')
    await start($, 't3', '')
    await complete($, 't3')
    rows.push(prompt(''))
    await start($, 't4', '')
    await complete($, 't4')
    await start($, 't5', 'Q')
    await complete($, 't5')
    const ui = await mountPane($, 'terminal')
    // the unrecorded turn keeps its edits, and is the newest
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · A', 'T2 · 1 file · Fix', 'T3 · 1 file · Outside'], value: '3' })
    await ui.select({ key: 'turn', value: '2' })
    expect((await look(ui)).header).toBe('T2 · 1 file · +1 −1  Fix')
  })

  test('denied, errored and staged calls stay out of a rebuilt turn too', async ($, on) => {
    world(
      on,
      { [at('d.txt')]: 'd\n', [at('e.txt')]: 'e\n', [at('s.txt')]: 's\n', [at('ok.txt')]: 'ok\n' },
      { lies: { [at('d.txt')]: 'deny', [at('e.txt')]: 'error', [at('s.txt')]: 'staged' } },
    )
    await start($, 't1', 'Mixed')
    for (const file of ['d.txt', 'e.txt', 's.txt']) await edit($, file, file[0]!, 'changed')
    await $.tool.call({ tool: 'Write', file_path: at('s.txt'), content: 'staged write\n' })
    await edit($, 'ok.txt', 'ok', 'OK')
    await complete($, 't1')
    await start($, 't2', 'Next')
    await edit($, 'ok.txt', 'OK', 'ok')
    await complete($, 't2')
    const ui = await mountPane($, 'desktop')
    await ui.select({ key: 'turn', value: '1' })
    expect((await look(ui)).rows).toEqual(['ok.txt  +1 −1'])
  })
})

describe("Claude's own files", () => {
  const TEMP = 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\C--proj\\s1\\scratchpad\\msg.txt'
  const save = ($: Engine, path: string, content = 'msg\n') => $.tool.call({ tool: 'Write', file_path: path, content })

  test('are left out of a turn, live and rebuilt; a turn changing only them changes nothing', async ($, on) => {
    // the folder where it lands too, as the CLI hands it out: here TEMP is a junction
    const links = { 'C:\\Users\\me\\AppData\\Local\\Temp': 'D:\\Temp' }
    world(on, { [at('a.txt')]: 'a\n', [at('b.txt')]: 'b\n' }, { links })
    await start($, 't1', 'Commit')
    await save($, TEMP)
    await save($, 'D:\\Temp\\claude\\s1\\scratchpad\\two.txt')
    await edit($, 'a.txt', 'a', 'A')
    await complete($, 't1')
    expect((await pane($, 'terminal')).rows).toEqual(['a.txt  +1 −1'])
    await start($, 't2', 'Write it down')
    await save($, TEMP, 'again\n')
    await complete($, 't2')
    expect((await pane($, 'terminal')).header).toBe('T1 · 1 file · +1 −1  Commit')
    await start($, 't3', 'Next')
    await edit($, 'b.txt', 'b', 'B')
    await complete($, 't3')
    const ui = await mountPane($, 'terminal')
    expect(await picker(ui)).toEqual({ labels: ['T1 · 1 file · Commit', 'T3 · 1 file · Next'], value: '3' })
    await ui.select({ key: 'turn', value: '1' })
    expect((await look(ui)).rows).toEqual(['a.txt  +1 −1'])
  })

  test('hideClaudeFiles off: they show like any other file', { options: { hideClaudeFiles: false } }, async ($, on) => {
    world(on, { [at('b.txt')]: 'b\n' })
    await start($, 't1', 'Commit')
    await save($, TEMP)
    await complete($, 't1')
    const shown = 'C:/Users/me/AppData/Local/Temp/claude/C--proj/s1/scratchpad/msg.txt  +1 −0  new'
    expect((await pane($, 'terminal')).rows).toEqual([shown])
    await start($, 't2', 'Next')
    await edit($, 'b.txt', 'b', 'B')
    await complete($, 't2')
    const ui = await mountPane($, 'terminal')
    expect((await picker(ui))?.labels).toEqual(['T1 · 1 file · Commit', 'T2 · 1 file · Next'])
    await ui.select({ key: 'turn', value: '1' })
    expect((await look(ui)).rows).toEqual([shown])
  })

  test('CLAUDE_CODE_TMPDIR names the folder; a session run inside it sees its own files', async ($, on) => {
    world(on, { 'D:\\tmp\\claude\\work\\c.txt': 'c\n' }, { env: { CLAUDE_CODE_TMPDIR: 'D:\\tmp\\' }, cwd: 'D:\\tmp\\claude\\work' })
    await start($, 't1', 'Here')
    await save($, 'D:\\tmp\\claude\\work\\a.txt')
    await save($, 'D:\\tmp\\claude\\other\\b.txt')
    // a folder whose name starts with the cwd's is not under it
    await save($, 'D:\\tmp\\claude\\work2\\x.txt')
    // the system's temporary folder is not Claude's while CLAUDE_CODE_TMPDIR is set
    await save($, TEMP)
    await complete($, 't1')
    const rows = ['a.txt  +1 −0  new', 'C:/Users/me/AppData/Local/Temp/claude/C--proj/s1/scratchpad/msg.txt  +1 −0  new']
    expect((await pane($, 'terminal')).rows).toEqual(rows)
    await start($, 't2', 'Next')
    await $.tool.call({ tool: 'Edit', file_path: 'D:\\tmp\\claude\\work\\c.txt', old_string: 'c', new_string: 'C' })
    await complete($, 't2')
    const ui = await mountPane($, 'terminal')
    expect((await picker(ui))?.labels).toEqual(['T1 · 2 files · Here', 'T2 · 1 file · Next'])
    await ui.select({ key: 'turn', value: '1' })
    expect((await look(ui)).rows).toEqual(rows)
  })

  test('its memory and plans are left out, under CLAUDE_CONFIG_DIR or else ~/.claude, from any cwd', async ($, on) => {
    const home = 'C:\\Users\\me\\.claude'
    const transcript = [
      prompt('Plan'),
      ...call('NotebookEdit', { notebook_path: `${home}\\projects\\C--proj\\memory\\nb.ipynb` }, { text: 'ok', result: { original_file: '{}', updated_file: '{"cells":[]}' } }),
      ...write(`${home}\\notes.md`, 'n\n', null),
      reply(),
    ]
    world(on, {}, { env: { USERPROFILE: 'C:\\Users\\me' }, cwd: 'C:\\Users\\me', transcript })
    await start($, 't1', 'Remember')
    await save($, `${home}\\projects\\C--proj\\memory\\note.md`)
    await save($, `${home}\\agent-memory\\reviewer\\MEMORY.md`)
    await save($, `${home}\\plans\\plan.md`)
    // the rest of the config folder is the user's: settings, instructions, skills
    await save($, `${home}\\CLAUDE.md`)
    await complete($, 't1')
    const ui = await mountPane($, 'terminal')
    expect((await look(ui)).rows).toEqual(['.claude/CLAUDE.md  +1 −0  new'])
    expect((await picker(ui))?.labels).toEqual(['T1 · 1 file · Plan', 'T2 · 1 file · Remember'])
    await ui.select({ key: 'turn', value: '1' })
    expect((await look(ui)).rows).toEqual(['.claude/notes.md  +1 −0  new'])
  })

  test('CLAUDE_CONFIG_DIR names the config folder: ~/.claude is then the user\'s', async ($, on) => {
    world(on, {}, { env: { CLAUDE_CONFIG_DIR: 'D:\\cfg', USERPROFILE: 'C:\\Users\\me' } })
    await start($, 't1', 'Plan')
    await save($, 'D:\\cfg\\plans\\p.md')
    await save($, 'C:\\Users\\me\\.claude\\plans\\q.md')
    await complete($, 't1')
    expect((await pane($, 'terminal')).rows).toEqual(['C:/Users/me/.claude/plans/q.md  +1 −0  new'])
  })

  test('on Linux and macOS: under TMPDIR, /tmp and HOME', async ($, on) => {
    // the test kit, on Windows, shows a mod no POSIX file on disk: a resumed session's rebuilt turn holds them
    const transcript = [
      prompt('Old'),
      ...write('/var/folders/x/T/claude/s1/scratchpad/m.txt', 'm\n', null),
      ...write('/tmp/claude/s1/scratchpad/n.txt', 'n\n', null),
      ...write('/home/me/.claude/plans/p.md', 'p\n', null),
      ...write('/home/me/proj/a.txt', 'a\n', null),
      reply(),
    ]
    world(on, {}, { env: { TMPDIR: '/var/folders/x/T/', HOME: '/home/me' }, cwd: '/home/me/proj', transcript })
    await begin($)
    expect((await pane($, 'terminal')).header).toBe(`T1 · 1 file · +1 −0  Old  ${REBUILT}`)
    expect((await pane($, 'terminal')).rows).toEqual(['a.txt  +1 −0  new'])
  })

  test('showMemoryAndPlans: memory and plans show again, live and rebuilt; temporary files stay hidden', { options: { showMemoryAndPlans: true } }, async ($, on) => {
    const home = 'C:\\Users\\me\\.claude'
    world(on, { [at('b.txt')]: 'b\n' }, { env: { USERPROFILE: 'C:\\Users\\me' } })
    await start($, 't1', 'Remember')
    await save($, TEMP)
    await save($, `${home}\\projects\\C--proj\\memory\\note.md`)
    await save($, `${home}\\agent-memory\\reviewer\\MEMORY.md`)
    await save($, `${home}\\plans\\plan.md`)
    await complete($, 't1')
    const rows = [
      'C:/Users/me/.claude/projects/C--proj/memory/note.md  +1 −0  new',
      'C:/Users/me/.claude/agent-memory/reviewer/MEMORY.md  +1 −0  new',
      'C:/Users/me/.claude/plans/plan.md  +1 −0  new',
    ]
    expect((await pane($, 'terminal')).rows).toEqual(rows)
    await start($, 't2', 'Next')
    await edit($, 'b.txt', 'b', 'B')
    await complete($, 't2')
    const ui = await mountPane($, 'terminal')
    expect((await picker(ui))?.labels).toEqual(['T1 · 3 files · Remember', 'T2 · 1 file · Next'])
    await ui.select({ key: 'turn', value: '1' })
    expect((await look(ui)).rows).toEqual(rows)
  })

  test('showMemoryAndPlans is in /config only while hideClaudeFiles is on', async ($, on) => {
    world(on, {})
    on('config.describe', ($, e) => ({ label: e.label, description: e.description, isHidden: e.isHidden }))
    const row = (key: string) =>
      $.config.describe({ key, label: 'Show', isHidden: false, provider: { plugin: 'last-turn-diff', tier: 'user' } })
    expect((await row('last-turn-diff.showMemoryAndPlans')).isHidden).toBe(false)
  })

  test('hideClaudeFiles off: showMemoryAndPlans leaves /config, and every file shows', { options: { hideClaudeFiles: false, showMemoryAndPlans: false } }, async ($, on) => {
    world(on, {}, { env: { USERPROFILE: 'C:\\Users\\me' } })
    on('config.describe', ($, e) => ({ label: e.label, description: e.description, isHidden: e.isHidden }))
    const row = (key: string) =>
      $.config.describe({ key, label: 'Show', isHidden: false, provider: { plugin: 'last-turn-diff', tier: 'user' } })
    for (const key of ['last-turn-diff.showMemoryAndPlans', 'last-turn-diff@inline.showMemoryAndPlans']) {
      expect((await row(key)).isHidden).toBe(true)
    }
    // the other rows stay
    expect((await row('last-turn-diff.hideClaudeFiles')).isHidden).toBe(false)
    expect((await row('other-mod.showMemoryAndPlans')).isHidden).toBe(false)
    await start($, 't1', 'Remember')
    await save($, TEMP)
    await save($, 'C:\\Users\\me\\.claude\\plans\\plan.md')
    await complete($, 't1')
    expect((await pane($, 'terminal')).rows).toEqual([
      'C:/Users/me/AppData/Local/Temp/claude/C--proj/s1/scratchpad/msg.txt  +1 −0  new',
      'C:/Users/me/.claude/plans/plan.md  +1 −0  new',
    ])
  })

  test('on Windows a folder spelled from / is not one: /tmp lands on the session\'s drive', async ($, on) => {
    // where the test kit, as the engine, takes /tmp on Windows
    world(on, {}, { links: { 'D:\\tmp': 'D:\\tmp' } })
    await start($, 't1', 'Mine')
    await save($, 'D:\\tmp\\claude\\notes\\x.txt')
    await complete($, 't1')
    expect((await pane($, 'terminal')).rows).toEqual(['D:/tmp/claude/notes/x.txt  +1 −0  new'])
  })
})
