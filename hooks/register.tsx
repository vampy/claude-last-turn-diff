import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileDiff, Hunk, LastTurn, PendingFile, PickedTurn, Recording, ToolRun, Vcs } from '../types'
import { blocks, clean, diffFile, fileKey, MAX_SIZE, paginate, relativePath, RUN_CAP, runHunks, textSize } from './diff'
import { editsOf, pathOf, promptLine, rebuildFiles, turnsOf } from './history'
import type { TranscriptTurn } from './history'
import type { Entry, Status } from './vcs'
import { drawHunks } from './svg'
import type { Drawing } from './svg'
import { join, nearest, parseCmStatus, parseGitStatus, parseNameStatus, pool } from './vcs'

const PANE = 'last-turn-diff'
const TITLE = 'Last turn'
/** Code text per pane draw: Desktop reportedly freezes for good on a draw past ~256 KB. */
const PAGE_BUDGET = 90_000
/** Svg text per pane draw on desktop, which refuses a tree past 262,144 characters (the file rows count too). */
const SVG_PAGE_BUDGET = 160_000
/** Turns the picker lists, the newest: the engine refuses a Select of more than 64 options (and the whole pane with it). */
const PICKS = 64
/** Per hunk on desktop, its header row and Copy button: enough that a page of small hunks stays under 2,000 elements. */
const HUNK_COST = 800
/** Per run and hunk header with selectableDiffs, so that a page holds RUN_CAP of them, about 1,200 elements. */
const RUN_COST = PAGE_BUDGET / RUN_CAP
/** Status files tracked per turn; past it they are left out of the diff. */
const MAX_FILES = 1000
/** Content kept for files dirty at turn start; past it they are recorded by size and mtime. */
const MAX_BYTES = 16 * 1024 * 1024
/** Base revisions fetched at once. */
const LANES = 8
/** A Bash or PowerShell command that moves a Plastic workspace, which makes its status misleading. */
const CM_MOVES = /\bcm(?:\.exe)?["']?\s+(?:update|upd|switch|stb|merge)\b/i

const turns = atom({ plugin: 'last-turn-diff', key: 'turns' } as const, 0)
const vcs = atom({ plugin: 'last-turn-diff', key: 'vcs' } as const, null)
const recording = atom({ plugin: 'last-turn-diff', key: 'recording' } as const, null)
const lastTurn = atom({ plugin: 'last-turn-diff', key: 'lastTurn' } as const, null)
const later = atom({ plugin: 'last-turn-diff', key: 'later' } as const, [])
const isBandHidden = atom({ plugin: 'last-turn-diff', key: 'isBandHidden' } as const, false)
const page = atom({ plugin: 'last-turn-diff', key: 'page' } as const, 0)
const picked = atom({ plugin: 'last-turn-diff', key: 'picked' } as const, null)
const PENDING = { plugin: 'last-turn-diff', key: 'pending' } as const

/** The file's text; null when it does not exist, undefined when too large or unreadable. */
async function snapshot($: EngineInterface, path: string): Promise<string | null | undefined> {
  if (!(await $.fs.exists(path).catch(() => true))) return null
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat?.kind !== 'file' || stat.size > MAX_SIZE) return undefined
  return $.fs.read(path).catch(() => undefined)
}

/** A status of a big repository or workspace takes seconds; `cm cat` from a cloud repo about one each. */
const SLOW_RUN = 120_000

/** The command's outcome; null when it could not start (not installed) or timed out. */
const run = ($: EngineInterface, argv: readonly string[], cwd: string, timeoutMs = 30_000) =>
  $.process.run(argv, { cwd, timeoutMs }).catch(() => null)

/** git's repository or Plastic's workspace holding the cwd. Never by looking for `.git`: an empty one makes git fail. */
async function detect($: EngineInterface, cwd: string): Promise<Vcs | null> {
  const [git, cm] = await Promise.all([
    run($, ['git', 'rev-parse', '--show-toplevel'], cwd),
    run($, ['cm', 'gwp', cwd, '--format={1}'], cwd, 15_000),
  ])
  const found: Vcs[] = []
  if (git?.exitCode === 0 && git.stdout.trim() !== '') found.push({ kind: 'git', root: git.stdout.trim() })
  if (cm?.exitCode === 0 && cm.stdout.trim() !== '') found.push({ kind: 'cm', root: cm.stdout.trim() })
  return nearest(found)
}

/**
 * The status of the whole repository or workspace; null when it failed, which means no snapshot, never
 * no changes. Plastic writes it to `<prefix>-status.xml`: through a pipe `cm` turns non-ASCII into `?`.
 */
async function status($: EngineInterface, vcs: Vcs, prefix: string | undefined): Promise<Status | null> {
  if (vcs.kind === 'git') {
    const [head, listed] = await Promise.all([
      run($, ['git', 'rev-parse', '--verify', '--quiet', 'HEAD'], vcs.root),
      run(
        $,
        ['git', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
        vcs.root,
        SLOW_RUN,
      ),
    ])
    if (head === null || listed?.exitCode !== 0 || listed.isStdoutTruncated) return null
    // --verify --quiet HEAD exits 1, silent, before the first commit
    return { rev: head.exitCode === 0 ? head.stdout.trim() : '', entries: parseGitStatus(listed.stdout) }
  }
  if (prefix === undefined) return null
  const file = `${prefix}-status.xml`
  // makes the folder, and an earlier status can never pass for this one
  if ((await $.fs.write(file, '').catch(() => false)) === false) return null
  const ran = await run(
    $,
    ['cm', 'status', '--controlledchanged', '--changed', '--localdeleted', '--private', `--xml=${file}`, '--encoding=utf-8'],
    vcs.root,
    SLOW_RUN,
  )
  // an authentication or server error prints plain text, not XML
  if (ran?.exitCode !== 0) return null
  const xml = await $.fs.read(file).catch(() => undefined)
  await $.fs.write(file, '').catch(() => undefined)
  return xml === undefined ? null : parseCmStatus(xml)
}

/**
 * A file's content at `rev`, as checkout writes it: null when the revision has no such file, undefined when it
 * could not be fetched or is too large.
 */
async function baseText($: EngineInterface, vcs: Vcs, rev: string, path: string, prefix: string | undefined) {
  if (vcs.kind === 'git') {
    if (rev === '') return null
    // --filters keeps the CRLF core.autocrlf writes; `git show` would not
    const ran = await run($, ['git', 'cat-file', '--filters', `${rev}:${path}`], vcs.root)
    if (ran === null) return undefined
    return ran.exitCode !== 0 ? null : ran.isStdoutTruncated ? undefined : ran.stdout
  }
  if (prefix === undefined) return undefined
  const file = `${prefix}-cat.tmp`
  const ran = await run($, ['cm', 'cat', `rev:${path}#cs:${rev}`, '--raw', `--file=${file}`], vcs.root, SLOW_RUN)
  if (ran?.exitCode !== 0) return undefined
  const text = await snapshot($, file)
  await $.fs.write(file, '').catch(() => undefined)
  return text ?? undefined
}

/** The files a fast-forward of HEAD from `from` to `to` changed; null for any other move. */
async function landed($: EngineInterface, vcs: Vcs, from: string, to: string): Promise<Entry[] | null> {
  if (from === '' || to === '') return null
  const ancestor = await run($, ['git', 'merge-base', '--is-ancestor', from, to], vcs.root)
  if (ancestor?.exitCode !== 0) return null
  const diff = await run($, ['git', 'diff', '--name-status', '-z', '--no-renames', from, to], vcs.root)
  return diff?.exitCode !== 0 || diff.isStdoutTruncated ? null : parseNameStatus(diff.stdout)
}

/**
 * Where `cm` writes its output: a per-user folder outside the workspace and the watched mod folder, a fixed set of
 * names as `$.fs` cannot delete. Keyed by the session id's first two digits, so sessions seldom share one. Never a
 * shared `/tmp`: another user could plant a symlink there for the mod to empty, or read the base revisions. Undefined,
 * so no Plastic shell edits, when no per-user folder is known.
 */
async function scratch($: EngineInterface): Promise<string | undefined> {
  // per-user: Linux's XDG_RUNTIME_DIR (mode 0700; TMPDIR is mostly unset there), Windows' TEMP, macOS's TMPDIR.
  // ponytail: a TMPDIR set to a shared folder is trusted; check its mode if that ever matters
  const home = (await $.env.get('HOME')) || undefined
  const tmp =
    (await $.env.get('XDG_RUNTIME_DIR')) ||
    (await $.env.get('TEMP')) ||
    (await $.env.get('TMP')) ||
    (await $.env.get('TMPDIR')) ||
    (home && join(home, '.cache'))
  return tmp ? join(tmp, `claude-last-turn-diff/${(await $.session.id()).slice(0, 2)}`) : undefined
}

/** Which of Claude Code's own files are left out: none, its temporary ones, or its memory and plans too. */
type Hidden = 'none' | 'temp' | 'all'

/**
 * Where Claude Code keeps the files `hidden` names, as keys ending in `/`: its temporary folder (scratchpads, pasted
 * images), `claude` under `$CLAUDE_CODE_TMPDIR` or else the system's; and its memory and plans, `projects`,
 * `agent-memory` and `plans` in its config folder, `$CLAUDE_CONFIG_DIR` or else `.claude` in the home folder. Each
 * folder the environment names, as the CLI picks one by platform, under the parent as spelled and where it lands: the
 * CLI hands out the temporary folder's real path (macOS: /var and /tmp under /private; a junction's target).
 */
async function claudeOwn($: EngineInterface, cwd: string, hidden: Hidden): Promise<string[]> {
  if (hidden === 'none') return []
  // the engine lists the variables a module reads: each name spelled out
  const tmp = (await $.env.get('CLAUDE_CODE_TMPDIR')) || undefined
  const tmps = tmp !== undefined ? [tmp] : [await $.env.get('TEMP'), await $.env.get('TMP'), await $.env.get('TMPDIR'), '/tmp']
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || undefined
  const homes = config !== undefined ? [] : [await $.env.get('HOME'), await $.env.get('USERPROFILE')]
  const configs = hidden !== 'all' ? [] : config !== undefined ? [config] : homes.map(home => home && join(home, '.claude'))
  // on Windows a folder spelled from / lands on the session's drive, never where Claude Code keeps anything
  const isWindows = /^(?:[a-z]:|\\\\)/i.test(cwd)
  const places = [
    ...tmps.map(base => ({ base, names: ['claude'] })),
    ...configs.map(base => ({ base, names: ['projects', 'agent-memory', 'plans'] })),
  ].filter((place): place is { base: string; names: string[] } => !!place.base && !(isWindows && /^[\\/]/.test(place.base)))
  const keys = await Promise.all(
    places.map(async ({ base, names }) => {
      const real = await $.fs.stat(base, { resolve: true }).then(found => found.realPath, () => undefined)
      return [base, real].flatMap(at => (at === undefined ? [] : names.map(name => fileKey(join(join(at, name), '')))))
    }),
  )
  return keys.flat()
}

/** A file of Claude Code's own: inside one of its folders, unless the session runs in that folder and the file is under its cwd. */
function isClaudeOwn(roots: readonly string[], cwd: string, path: string): boolean {
  const file = fileKey(path)
  const here = fileKey(join(cwd, ''))
  return roots.some(root => file.startsWith(root) && !(here.startsWith(root) && file.startsWith(here)))
}

/** Leeway around a call's run for a file system's coarse mtimes (FAT's 2 s) and a network share's clock. */
const MTIME_SLACK = 2000

/**
 * Whether one of the turn's calls was running as a file only the status lists (no Edit of the turn's) was last written,
 * by its mtime (undefined: deleted). A deleted file, or one that kept a date from before the turn (a copy, a move), goes
 * by its folder's, which changes as an entry comes or goes. Not what another session or an editor wrote between calls.
 */
async function isTurnWrite(
  $: EngineInterface,
  startedAt: number | undefined,
  runs: readonly ToolRun[],
  path: string,
  mtimeMs: number | undefined,
): Promise<boolean> {
  // recorded before calls were timed: everything counts, as it did then
  if (startedAt === undefined) return true
  const at =
    mtimeMs !== undefined && mtimeMs >= startedAt - MTIME_SLACK
      ? mtimeMs
      : await $.fs.stat(path.replace(/[\\/][^\\/]*$/, '')).then(folder => folder.mtimeMs, () => undefined)
  // its folder gone too: nothing tells
  if (at === undefined) return true
  return runs.some(run => at >= run.from - MTIME_SLACK && at <= (run.to ?? Infinity) + MTIME_SLACK)
}

const addNote = ($: EngineInterface, turnId: string, note: string) =>
  update($, recording, rec => (rec?.turnId === turnId ? { ...rec, notes: [...(rec.notes ?? []), note] } : rec))

/** A file the status lists at turn start: its text, or binary or past the caps its size and mtime; undefined for a folder. */
async function dirtyFile(
  $: EngineInterface,
  path: string,
  isBinary: boolean,
  room: number,
): Promise<Pick<PendingFile, 'before' | 'isNew' | 'stamp' | 'isBinary'> | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined) return { before: '', isNew: true }
  if (stat.kind !== 'file') return undefined
  const text = isBinary || stat.size > Math.min(MAX_SIZE, room) ? undefined : await $.fs.read(path).catch(() => undefined)
  if (text !== undefined && !text.includes('\0')) return { before: text, isNew: false }
  return { before: null, isNew: false, stamp: { size: stat.size, mtimeMs: stat.mtimeMs }, isBinary: isBinary || text !== undefined }
}

/** The turn-start status: each listed file into the turn's `pending`, as an Edit's first call puts one. */
async function snapshotStart($: EngineInterface, repo: Vcs, turnId: string) {
  const found = await status($, repo, await scratch($))
  if (found === null) return addNote($, turnId, `${repo.kind} status failed at turn start: shell changes are not shown.`)
  const ids = found.entries.map(entry => fileKey(join(repo.root, entry.path)))
  const tracked: string[] = []
  let room = MAX_BYTES
  for (const [i, entry] of found.entries.slice(0, MAX_FILES).entries()) {
    const path = join(repo.root, entry.path)
    const held = await dirtyFile($, path, entry.isBinary, room)
    if (held === undefined) continue
    room -= held.before?.length ?? 0
    tracked.push(ids[i]!)
    await update($, { ...PENDING, id: ids[i]! }, was =>
      was?.turnId === turnId ? was : { turnId, path, added: 0, removed: 0, ...held },
    )
  }
  await update($, recording, rec =>
    rec?.turnId === turnId
      ? { ...rec, base: { rev: found.rev, dirty: ids }, keys: [...rec.keys, ...tracked.filter(id => !rec.keys.includes(id))] }
      : rec,
  )
}

/**
 * Files the status lists now and did not at turn start (clean then), by `pending` id, with their base revision as
 * before. A file an Edit already holds is left to it, unless a shell command ran before that Edit.
 */
async function shellFiles(
  $: EngineInterface,
  repo: Vcs,
  open: Recording,
  touched: ReadonlyMap<string, PendingFile>,
  notes: string[],
): Promise<[string, PendingFile][]> {
  const base = open.base!
  if (repo.kind === 'cm' && open.isCmBusy === true) {
    notes.push('cm update, switch or merge ran this turn: shell changes are not shown.')
    return []
  }
  const dir = await scratch($)
  const now = await status($, repo, dir)
  if (now === null) {
    notes.push(`${repo.kind} status failed at turn end: shell changes are not shown.`)
    return []
  }
  let entries = now.entries
  if (now.rev !== base.rev) {
    if (repo.kind === 'cm') {
      notes.push(`The workspace moved from cs:${base.rev} to cs:${now.rev}: shell changes are not shown.`)
      return []
    }
    const committed = await landed($, repo, base.rev, now.rev)
    if (committed === null) {
      const name = (rev: string) => (rev === '' ? 'no commit' : rev.slice(0, 9))
      notes.push(`HEAD moved from ${name(base.rev)} to ${name(now.rev)}: files changed only by that move are not shown.`)
    } else entries = [...entries, ...committed]
  }
  const dirty = new Set(base.dirty)
  const fresh = new Map<string, Entry>()
  for (const entry of entries) {
    const id = fileKey(join(repo.root, entry.path))
    const held = touched.get(id)
    if (!dirty.has(id) && (held === undefined || held.isAfterShell === true) && !fresh.has(id)) fresh.set(id, entry)
  }
  const kept = [...fresh].slice(0, MAX_FILES)
  if (fresh.size > kept.length) notes.push(`${fresh.size - kept.length} more changed files are not shown.`)
  const files = await pool(kept, LANES, async ([id, entry], lane): Promise<[string, PendingFile] | null> => {
    const path = join(repo.root, entry.path)
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat !== undefined && stat.kind !== 'file') return null
    const was =
      entry.isNew ? null
      : entry.isBinary || (stat?.size ?? 0) > MAX_SIZE ? undefined
      : await baseText($, repo, base.rev, entry.oldPath ?? entry.path, dir && `${dir}-${lane}`)
    const before = { before: was === null ? '' : (was ?? null), isNew: was === null, ...(entry.isBinary ? { isBinary: true } : {}) }
    const held = touched.get(id)
    return [id, held === undefined ? { turnId: open.turnId, path, added: 0, removed: 0, ...before } : { ...held, ...before }]
  })
  return files.filter(file => file !== null)
}

const count = (files: number) => `${files} file${files === 1 ? '' : 's'}`
const totals = (files: readonly FileDiff[]) => ({
  added: files.reduce((sum, f) => sum + f.added, 0),
  removed: files.reduce((sum, f) => sum + f.removed, 0),
})

/** What the pane says with no turn to show. */
const NO_TURN = 'No finished turn has changed files yet.'
/** Where an open pane that does not draw is: Claude Code's own diff panel takes the dock's place and draws none. */
const COVERED = "behind Claude Code's diff panel: /diff hides it"

function describe(turn: Shown | null): string {
  if (turn === null) return NO_TURN
  if (turn.files.length === 0) return `T${turn.turn} changed no files.`
  const { added, removed } = totals(turn.files)
  const names = turn.files.slice(0, 10).map(f => f.path)
  if (turn.files.length > 10) names.push(`${turn.files.length - 10} more`)
  return `T${turn.turn} · ${count(turn.files.length)} · +${added} −${removed}: ${names.join(', ')}`
}

/** A turn as the pane shows it, numbered: the live recording, or one rebuilt from the transcript. */
type Shown = LastTurn & { isRebuilt?: true }
/** One turn the picker lists: its number, its prompt and how many files its calls changed. */
type Listed = { turn: number; prompt: string; files: number }
/**
 * The transcript's turns, read when first shown after a turn ends, a reload, a resume, a /clear or a /compact; the one
 * last rebuilt; the shown turn's files drawn as SVG; the session id they were read under; the prompt of a turn whose
 * end is being recorded, left out like a running one; and the id of a session a /clear or a resume ended.
 */
type History = {
  id?: string
  turns?: Listed[]
  rebuilt?: Shown
  drawn?: { key: string; files: Drawing[] }
  ending?: string
  ended?: string
}

/** Drops what was read of the transcript and drawn from it: its numbers may name other turns now. */
const forget = (history: History) => {
  history.turns = undefined
  history.rebuilt = undefined
  history.drawn = undefined
}

/**
 * Reads the transcript's turns into `history`, leaving out one still running or ending (read mid-turn after a reload or
 * a resume), and the calls on the Claude Code files `hidden` names.
 */
async function load($: EngineInterface, history: History, hidden: Hidden): Promise<TranscriptTurn[]> {
  const cwd = await $.session.cwd()
  const roots = await claudeOwn($, cwd, hidden)
  const found = turnsOf(await $.session.messages().catch(() => [])).map(t => ({
    ...t,
    uses: t.uses.filter(use => !isClaudeOwn(roots, cwd, pathOf(use) ?? '')),
  }))
  const open = (await read($, recording))?.prompt ?? history.ending
  if (open !== undefined && found[found.length - 1]?.prompt === open) found.pop()
  forget(history)
  history.turns = found.map(({ turn, prompt, uses }) => ({ turn, prompt, files: editsOf(uses).size }))
  return found
}

/**
 * The picker's entries (the turns that changed files), the live recording's number among them, and the number to
 * show: the pick, else the newest. A pick is found by its place from the newest entry, which a turn without changes
 * leaves (and one with changes drops the pick): the numbers shift as the oldest turns leave the 4,096-entry window or
 * a compaction. Its prompt confirms it, or finds the one with that prompt nearest that place. The live recording is
 * the transcript's turn before the ones that ended after it without changes when that turn has its prompt, else the
 * one after it (a continuation has no row).
 */
function resolve(listed: readonly Listed[], live: LastTurn | null, after: readonly (string | null)[], pick: PickedTurn | null) {
  // back over the turns that ended without changes: each is the row with its prompt, or has none (a continuation, a
  // message from another session); one unrecorded has its row. Those recorded leave the list, whatever their calls did
  let i = listed.length - 1
  const quiet = new Set<number>()
  for (const prompt of [...after].reverse()) {
    if (prompt !== null && listed[i]?.prompt !== prompt) continue
    if (prompt !== null) quiet.add(i)
    i--
  }
  const mine = listed[i]
  const number = live === null ? undefined : mine?.prompt === live.prompt ? mine.turn : (mine?.turn ?? 0) + 1
  const entries = [
    ...listed.filter((t, k) => t.turn !== number && t.files > 0 && !quiet.has(k)),
    ...(live === null ? [] : [{ turn: number!, prompt: live.prompt, files: live.files.length }]),
  ].sort((a, b) => a.turn - b.turn)
  const at = entries.length - (pick?.fromEnd ?? 0)
  const near = entries
    .map((t, i) => ({ t, far: Math.abs(i - at) }))
    .filter(({ t }) => t.prompt === pick?.prompt)
    .sort((a, b) => a.far - b.far)
  return { entries, number, want: (near[0]?.t ?? entries[entries.length - 1])?.turn }
}

/**
 * The turn the pane shows and the picker's entries; a turn is rebuilt from a fresh read of the transcript. With turn
 * history off (`isListed` false) the transcript is never read: the last turn alone, numbered from when the mod loaded.
 * `hidden` names the Claude Code files left out of what is read.
 */
async function shown(
  $: EngineInterface,
  history: History,
  isListed: boolean,
  hidden: Hidden,
): Promise<{ turn: Shown | null; entries: Listed[] }> {
  if (!isListed) return { turn: await read($, lastTurn), entries: [] }
  const id = await $.session.id()
  // drawn after a /clear or a resume ended it, before the next conversation is in place: nothing of it
  if (id === history.ended) return { turn: null, entries: [] }
  // a /clear or a resume goes on under another id, with another transcript
  if (history.id !== id) {
    history.id = id
    forget(history)
  }
  let found = history.turns === undefined ? await load($, history, hidden) : undefined
  const live = await read($, lastTurn)
  const after = await read($, later)
  const pick = await read($, picked)
  let view = resolve(history.turns ?? [], live, after, pick)
  if (view.want !== undefined && view.want !== view.number && history.rebuilt?.turn !== view.want) {
    if (found === undefined) {
      found = await load($, history, hidden)
      view = resolve(history.turns ?? [], live, after, pick)
    }
    const turn = found.find(t => t.turn === view.want && t.turn !== view.number)
    if (turn !== undefined) {
      const files = rebuildFiles(turn.uses, await $.session.cwd())
      history.rebuilt = { turn: turn.turn, prompt: turn.prompt, files, isRebuilt: true }
    }
  }
  const turn =
    view.want === undefined ? null
    : view.want === view.number ? { ...live!, turn: view.want }
    : history.rebuilt?.turn === view.want ? history.rebuilt
    : null
  return { turn, entries: view.entries }
}

/** A turn ended without changes, or unrecorded, and leaves the last one on show: its prompt, null when unrecorded. */
const passed = ($: EngineInterface, prompt: string | null) => update($, later, list => [...list, prompt])

/** The text cut to 60 code points, so no emoji is cut in half. */
function short(text: string): string {
  const points = [...text]
  return points.length > 60 ? `${points.slice(0, 59).join('')}…` : text
}

/** diffFile's note for the changed lines past its cap. */
const MORE = ' more changed lines not shown'

/** The file's notes, the drawing's own cut added to diffFile's count of changed lines not shown. */
function withHidden(notes: readonly string[], hidden: number): readonly string[] {
  if (hidden === 0) return notes
  const cut = notes.find(note => note.endsWith(MORE))
  return [...notes.filter(note => note !== cut), `${hidden + (cut === undefined ? 0 : parseInt(cut))}${MORE}`]
}

/** The pane closed (or behind another tab), drawn, or open but behind Claude Code's diff panel: shown, not drawn. */
async function sight($: EngineInterface, isDrawn: boolean): Promise<'closed' | 'drawn' | 'covered'> {
  if (!(await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)) return 'closed'
  return isDrawn ? 'drawn' : 'covered'
}

/** The path cut from the left to fit `room` cells. */
const fit = (path: string, room: number) => (path.length > room ? `…${path.slice(-(Math.max(room, 10) - 1))}` : path)

export const register: Register = (on, options) => {
  /** The turn-start snapshot in flight; module-local, so a reload drops it and the turn goes on without one. */
  let snapshotting: Promise<unknown> = Promise.resolve()
  /** The calls running now, by when each started: one still running at turn end counts as running on. Module-local too. */
  const running = new Set<ToolRun>()
  const history: History = {}
  /**
   * Whether the pane drew since it opened or its turn changed. A pane shown but not drawn is behind Claude Code's own
   * diff panel (/diff, the terminal's fullscreen layout), which takes the dock's place: `$.ui.panes()` still calls the
   * pane shown, an open draws nothing, and only /diff brings it back. Module-local: a reload draws a shown pane again.
   */
  let isDrawn = false
  /** showMemoryAndPlans takes memory and plans back out of what hideClaudeFiles hides. */
  const hidden: Hidden = options.hideClaudeFiles === false ? 'none' : options.showMemoryAndPlans === true ? 'temp' : 'all'

  // Also after a hot reload. With shellEdits off nothing runs, and a version control found before is dropped.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'turn-diff', description: "Shows or hides the last turn's file changes" })
    // a change of option reloads the mod: the /config row below may come or go
    $.ui.invalidate('config.describe')
    const found = options.shellEdits === false ? null : await detect($, e.cwd)
    await update($, vcs, () => found)
    return next(e)
  })

  // With hideClaudeFiles off nothing is hidden, so there is nothing to show again: the row leaves the menu. Its key is
  // `<plugin>.<field>`, the plugin named as installed or as loaded from a folder (`@inline`)
  on('config.describe', ($, e, next) =>
    next(
      options.hideClaudeFiles === false && /^last-turn-diff(?:@[^.]*)?\.showMemoryAndPlans$/.test(e.key) ? { ...e, isHidden: true } : e,
    ),
  )

  // A /clear or a resume goes on with another conversation, under another id, and raises no session.start.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      history.ended = e.sessionId
      await update($, lastTurn, () => null)
      await update($, later, () => [])
      await update($, picked, () => null)
      await update($, page, () => 0)
    }
    return next(e)
  })

  // A compaction leaves only its summary and the messages it kept: the turns before it are gone.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (e.agentId === undefined) forget(history)
    return compacted
  })

  on('command.run', { command: 'turn-diff' }, async $ => {
    const seen = await sight($, isDrawn)
    // close only what is on screen: an open pane left unplaced, behind another tab or behind the diff panel stays
    if (seen === 'drawn') {
      await $.ui.close({ id: PANE })
      return { text: 'Closed the last-turn diff.' }
    }
    await update($, picked, () => null)
    await update($, page, () => 0)
    if (seen === 'closed') isDrawn = false
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const why = !opened.isPlaced ? `no pane shown: ${opened.reason}` : seen === 'covered' ? COVERED : undefined
    const turn = (await shown($, history, options.turnHistory !== false, hidden)).turn
    return { text: describe(turn) + (why === undefined ? '' : ` (${why})`) }
  })

  // Only the main loop raises turn.start; a subagent's run and a local slash command do not.
  // ($.session.turns() counts a command's rows as turns, so the mod counts its own: the numbers with turnHistory off.)
  on('turn.start', async ($, e, next) => {
    // a turn runs under the session's id: it is live, even had a session.end named it (a resume that failed)
    history.ended = undefined
    const turn = await update($, turns, n => n + 1)
    const startedAt = await $.clock.now()
    await update($, recording, () => ({ turnId: e.turnId, turn, prompt: promptLine(e.text), startedAt, keys: [] }))
    const repo = await read($, vcs)
    // Not awaited: a Plastic status takes seconds, so it runs while the model starts, and each tool call waits for it.
    if (repo !== null) snapshotting = snapshotStart($, repo, e.turnId).catch(() => undefined)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await snapshotting
    if (e.tool === 'Bash' || e.tool === 'PowerShell') {
      // background commands included: they may still be running when the turn ends
      const isCmBusy = CM_MOVES.test(e.command)
      await update($, recording, rec =>
        rec === null ? rec : { ...rec, hasShellRun: true, ...(isCmBusy ? { isCmBusy } : {}) },
      )
    }
    const call = { from: await $.clock.now() }
    running.add(call)
    const ran = await next(e).finally(() => running.delete(call))
    // read-only: Read, Grep, a Bash `ls`, a subagent's launch (its own calls are timed); no PowerShell command yet
    if (ran.deny !== undefined || ran.isReadOnly === true) return ran
    // one moved to the background (asked, Ctrl+B, a timeout) counts as running to the turn's end
    const isBackground = (ran.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId !== undefined
    const to = isBackground ? undefined : await $.clock.now()
    await update($, recording, rec =>
      rec === null ? rec : { ...rec, runs: [...(rec.runs ?? []), { ...call, ...(to === undefined ? {} : { to }) }] },
    )
    return ran
  }).catch(($, e, next) => next(e)) // never blocks a tool, nor runs one twice: past next(e) it replays its result

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    await snapshotting
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
        ? { ...held, added: held.added + added, removed: held.removed + removed, isEdited: true }
        : {
            turnId: open.turnId,
            path,
            before: before === null ? '' : (before ?? null),
            isNew: before === null,
            added,
            removed,
            isEdited: true,
            ...(open.hasShellRun === true ? { isAfterShell: true } : {}),
          },
    )
    await update($, recording, rec =>
      rec?.turnId === open.turnId && !rec.keys.includes(id) ? { ...rec, keys: [...rec.keys, id] } : rec,
    )
    return ran
  })

  // A subagent's run completes with its agentId and leaves the main turn alone.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await snapshotting
    const open = await read($, recording)
    if (open === null) {
      // a turn started before the mod loaded: the transcript holds one more turn
      forget(history)
      await passed($, null)
      return next(e)
    }
    // until its end is recorded, a read of the transcript leaves this turn out as a running one
    history.ending = open.prompt
    await update($, recording, () => null)
    const cwd = await $.session.cwd()
    const notes = [...(open.notes ?? [])]
    const touched = new Map<string, PendingFile>()
    for (const id of open.keys) {
      const held = await read($, { ...PENDING, id })
      await update($, { ...PENDING, id }, () => null)
      if (held?.turnId === open.turnId) touched.set(id, held)
    }
    const repo = await read($, vcs)
    if (repo !== null && open.base !== undefined) {
      for (const [id, file] of await shellFiles($, repo, open, touched, notes)) touched.set(id, file)
    }
    const roots = touched.size === 0 ? [] : await claudeOwn($, cwd, hidden)
    // a call still running (a background agent's) counts as running on
    const runs = [...(open.runs ?? []), ...running]
    const files: FileDiff[] = []
    for (const held of touched.values()) {
      // a scratchpad file, a commit message Claude wrote down: not the turn's work
      if (isClaudeOwn(roots, cwd, held.path)) continue
      const now = await $.fs.stat(held.path).catch(() => undefined)
      // a file recorded by size and mtime is unchanged while both are
      if (held.stamp !== undefined && now?.size === held.stamp.size && now.mtimeMs === held.stamp.mtimeMs) continue
      // one only the status lists, written while none of the turn's calls ran: another session's, an editor's
      if (held.isEdited !== true && !(await isTurnWrite($, open.startedAt, runs, held.path, now?.mtimeMs))) continue
      const after = await snapshot($, held.path)
      const file = diffFile({ ...held, path: clean(relativePath(cwd, held.path)), after })
      if (file !== null) files.push(file)
    }
    // the transcript holds one more turn: read it again when next shown. `ending` goes before the write to `lastTurn`:
    // a draw between them reads this turn in the transcript, and the write draws again with it counted
    forget(history)
    history.ending = undefined
    // a note says shell changes may be missing: it counts only where a shell command ran
    if (files.length === 0 && (notes.length === 0 || open.hasShellRun !== true)) {
      // the last turn, its pick and page stay on show; the band goes
      await passed($, open.prompt)
      await update($, isBandHidden, () => true)
      return next(e)
    }
    // a shown pane draws the new turn; one behind the diff panel does not
    isDrawn = false
    await update($, later, () => [])
    await update($, lastTurn, () => ({ turn: open.turn, prompt: open.prompt, files, notes }))
    await update($, isBandHidden, () => false)
    await update($, page, () => 0)
    await update($, picked, () => null)
    // An unasked open waits undrawn below 144 columns; /turn-diff shows it then.
    if (options.autoOpen === true && files.length > 0) await $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    isDrawn = true
    const { Box, Button, Code, Select, Text } = $.ui.resolve(e)
    const { turn, entries } = await shown($, history, options.turnHistory !== false, hidden)
    if (turn === null) return <Text dimColor>{NO_TURN}</Text>
    const picker = entries.length > 1 && (
      <Select
        key="turn"
        label="Turn"
        options={entries.slice(-PICKS).map(t => ({
          value: String(t.turn),
          label: [`T${t.turn}`, count(t.files), ...(t.prompt === '' ? [] : [short(t.prompt)])].join(' · '),
        }))}
        value={String(turn.turn)}
        onSelect={async value => {
          const i = entries.findIndex(t => String(t.turn) === value)
          await update($, picked, () => (i < 0 ? null : { prompt: entries[i]!.prompt, fromEnd: entries.length - i }))
          await update($, page, () => 0)
        }}
      />
    )
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
          T{turn.turn} · {count(turn.files.length)} · <Text color="success">+{all.added}</Text>{' '}
          <Text color="error">−{all.removed}</Text>
        </Text>
        {turn.prompt !== '' && (
          <Text dimColor wrap="truncate-end">
            {turn.prompt}
          </Text>
        )}
        {turn.isRebuilt === true && (
          <Text dimColor>Rebuilt from the transcript: Edit, Write and NotebookEdit calls only; line endings not compared.</Text>
        )}
        {(turn.notes ?? []).map(note => (
          <Text color="warning">{note}</Text>
        ))}
      </Box>
    )
    if (turn.files.length === 0) {
      return (
        <Box flexDirection="column" width={width}>
          {picker}
          {header}
          <Text dimColor>This turn changed no files.</Text>
        </Box>
      )
    }
    // Desktop draws a `Code` diff as plain diff text that can't be selected, but numbered `Code` (startLine) as selectable
    // code with Desktop's own colors: with selectableDiffs each run of lines is one, removed and added runs framed and marked;
    // with svgDiffs each file's hunks are SVG images
    const runs = e.surface === 'desktop' && options.selectableDiffs === true ? turn.files.map(f => runHunks(f.hunks)) : undefined
    const Svg = e.surface === 'desktop' && runs === undefined && options.svgDiffs !== false ? $.ui.resolve(e).Svg : undefined
    // drawn by the turn and the pane's width, so turning a page draws nothing again; dropped with what was read of the
    // transcript, whose numbers it holds. ponytail: a turn is known by its number, prompt and per-file counts; a content
    // hash if two ever collide
    const key = [width, turn.turn, turn.prompt, ...turn.files.map(f => `${f.path} ${f.added} ${f.removed}`)].join('\n')
    if (Svg !== undefined && history.drawn?.key !== key) {
      history.drawn = { key, files: turn.files.map(file => drawHunks(file.path, file.hunks, width)) }
    }
    const svgs = Svg === undefined ? undefined : history.drawn!.files
    const pages = paginate(
      turn.files.map((file, i) =>
        runs !== undefined
          ? textSize(file.hunks) + RUN_COST * runs[i]!.hunks.reduce((n, hunk) => n + 1 + hunk.runs.length, 0)
          : svgs === undefined
            ? textSize(file.hunks)
            : svgs[i]!.hunks.reduce((sum, hunk) => sum + HUNK_COST + hunk.images.reduce((n, image) => n + image.length, 0), 0),
      ),
      svgs === undefined ? PAGE_BUDGET : SVG_PAGE_BUDGET,
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
        {picker}
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
          const drawing = svgs?.[i]
          const framed = runs?.[i]
          return (
            <Box key={`file-${i}`} flexDirection="column" marginTop={1}>
              {rule}
              <Box gap={2}>
                <Text bold>{file.path}</Text>
                {counts(file, file.badges)}
              </Box>
              {rule}
              {withHidden(file.notes, (drawing ?? framed)?.hidden ?? 0).map(note => (
                <Text dimColor>{note}</Text>
              ))}
              {framed !== undefined
                ? framed.hunks.map(hunk => (
                    // the gap keeps a red frame's edge off a green one's, which together read as one yellow line
                    <Box flexDirection="column" gap="xs">
                      <Text dimColor>{hunk.header}</Text>
                      {hunk.runs.map(run => {
                        // the marker is part of the code, so a copy takes it too: Desktop's gutter takes nothing of a mod's
                        const source = clean(run.lines.map(line => `${run.kind} ${line}`).join('\n'))
                        const code = <Code path={file.path} startLine={run.start} source={source} />
                        return run.kind === ' ' ? code : (
                          <Box borderStyle="single" borderColor={run.kind === '-' ? 'error' : 'success'}>
                            {code}
                          </Box>
                        )
                      })}
                    </Box>
                  ))
                : Svg !== undefined && drawing !== undefined
                ? drawing.hunks.flatMap((hunk, k) => [
                    // an image can't be selected: Copy puts the hunk's lines as they are now on the clipboard
                    <Box justifyContent="space-between" gap={2}>
                      <Text dimColor>{hunk.header}</Text>
                      <Button
                        key={`copy-${i}-${k}`}
                        plain
                        label="Copy"
                        onPress={async press => {
                          const copied = await $.ui.copy({ text: hunk.code, surface: press.surface })
                          $.ui.toast(copied.isCopied ? `Copied ${hunk.header}` : `Not copied: ${copied.reason}`)
                        }}
                      />
                    </Box>,
                    ...hunk.images.map(source => <Svg source={source} alt={`Diff of ${file.path}, ${hunk.header}`} />),
                  ])
                : blocks(file.hunks).map(source => <Code format="diff" path={file.path} source={clean(source)} />)}
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
          Last turn: {count(turn.files.length)} <Text color="success">+{all.added}</Text>{' '}
          <Text color="error">−{all.removed}</Text>
        </Text>
        <Button
          key="view"
          label="View"
          onPress={async () => {
            await update($, picked, () => null)
            await update($, page, () => 0)
            const seen = await sight($, isDrawn)
            if (seen === 'covered') await $.ui.toast(`The Last turn pane is ${COVERED}.`)
            if (seen !== 'closed') return
            isDrawn = false
            await $.ui.open({ id: PANE, title: TITLE })
          }}
        />
        <Button key="hide" label="x" role="dismiss" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })
}
