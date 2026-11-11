import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { FileDiff, Hunk, LastTurn, PendingFile, PickedTurn, Recording, ToolRun, Vcs } from '../types'
import {
  blocks,
  clean,
  countChanges,
  diffFile,
  fileKey,
  MAX_SIZE,
  paginate,
  relativePath,
  RUN_CAP,
  runHunks,
  textSize,
} from './diff'
import type { FileRuns, Snapshot } from './diff'
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
/**
 * How long a hook waits for the turn-start snapshot. The wait is the hook's own time, and past its 10 s budget the engine
 * runs on without it: a tool call unrecorded, a turn's end lost. Half leaves the rest for the hook's own work.
 */
const SNAPSHOT_WAIT = 5_000
/** A Bash or PowerShell command that moves a Plastic workspace, which makes its status misleading. */
const CM_MOVES = /\bcm(?:\.exe)?["']?\s+(?:update|upd|switch|stb|merge)\b/i

const turns = atom({ plugin: 'last-turn-diff', key: 'turns' } as const, 0)
const vcs = atom({ plugin: 'last-turn-diff', key: 'vcs' } as const, null)
const recording = atom({ plugin: 'last-turn-diff', key: 'recording' } as const, null)
const lastTurn = atom({ plugin: 'last-turn-diff', key: 'lastTurn' } as const, null)
/** The prompts of the turns that ended without changes after `lastTurn`; stored under its first name, `later`. */
const quietPrompts = atom({ plugin: 'last-turn-diff', key: 'later' } as const, [])
const isBandHidden = atom({ plugin: 'last-turn-diff', key: 'isBandHidden' } as const, false)
const page = atom({ plugin: 'last-turn-diff', key: 'page' } as const, 0)
const picked = atom({ plugin: 'last-turn-diff', key: 'picked' } as const, null)
const PENDING = { plugin: 'last-turn-diff', key: 'pending' } as const

/** The file's content on disk now. */
async function snapshot($: EngineInterface, path: string): Promise<Snapshot> {
  const exists = await $.fs.exists(path).catch(() => true)
  if (!exists) return null
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
  const gitRoot = git?.exitCode === 0 ? git.stdout.trim() : ''
  if (gitRoot !== '') found.push({ kind: 'git', root: gitRoot })
  const cmRoot = cm?.exitCode === 0 ? cm.stdout.trim() : ''
  if (cmRoot !== '') found.push({ kind: 'cm', root: cmRoot })
  return nearest(found)
}

/**
 * The root holding `cwd`, found again only when the session runs somewhere else than the last search: a Desktop spare
 * raises session.start in a neutral folder and its claim then moves it, as `/cd` and a worktree move do.
 */
async function repoAt($: EngineInterface, cwd: string): Promise<Vcs | null> {
  const found = await read($, vcs)
  if (found?.cwd === cwd) return found.repo
  const repo = await detect($, cwd)
  await update($, vcs, () => ({ cwd, repo }))
  return repo
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
    if (head === null) return null
    if (listed?.exitCode !== 0 || listed.isStdoutTruncated) return null
    // --verify --quiet HEAD exits 1, silent, before the first commit
    const rev = head.exitCode === 0 ? head.stdout.trim() : ''
    return { rev, entries: parseGitStatus(listed.stdout) }
  }
  if (prefix === undefined) return null
  const file = `${prefix}-status.xml`
  // makes the folder, and an earlier status can never pass for this one
  const isEmptied = await $.fs.write(file, '').then(() => true, () => false)
  if (!isEmptied) return null
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

/** A file's content at `rev`, as checkout writes it: null when the revision has no such file. */
async function baseText(
  $: EngineInterface,
  vcs: Vcs,
  rev: string,
  path: string,
  prefix: string | undefined,
): Promise<Snapshot> {
  if (vcs.kind === 'git') {
    if (rev === '') return null
    // --filters keeps the CRLF core.autocrlf writes; `git show` would not
    const ran = await run($, ['git', 'cat-file', '--filters', `${rev}:${path}`], vcs.root)
    if (ran === null) return undefined
    if (ran.exitCode !== 0) return null
    if (ran.isStdoutTruncated) return undefined
    return ran.stdout
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
  if (diff?.exitCode !== 0 || diff.isStdoutTruncated) return null
  return parseNameStatus(diff.stdout)
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
  const runtime = await $.env.get('XDG_RUNTIME_DIR')
  const temp = await $.env.get('TEMP')
  const tmp = await $.env.get('TMP')
  const tmpdir = await $.env.get('TMPDIR')
  const home = await $.env.get('HOME')
  const cache = home ? join(home, '.cache') : undefined
  const base = runtime || temp || tmp || tmpdir || cache
  if (!base) return undefined
  const id = await $.session.id()
  return join(base, `claude-last-turn-diff/${id.slice(0, 2)}`)
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
  const ownTmp = await $.env.get('CLAUDE_CODE_TMPDIR')
  const temp = await $.env.get('TEMP')
  const tmp = await $.env.get('TMP')
  const tmpdir = await $.env.get('TMPDIR')
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  const profile = await $.env.get('USERPROFILE')
  const tmps = ownTmp ? [ownTmp] : [temp, tmp, tmpdir, '/tmp']
  let configs: (string | null)[] = []
  if (hidden === 'all') {
    const homes = [home, profile].map(at => (at ? join(at, '.claude') : null))
    configs = config ? [config] : homes
  }
  // on Windows a folder spelled from / lands on the session's drive, never where Claude Code keeps anything
  const isWindows = /^(?:[a-z]:|\\\\)/i.test(cwd)
  const isPlace = (base: string | null | undefined): base is string => !!base && !(isWindows && /^[\\/]/.test(base))
  const places = [
    ...tmps.filter(isPlace).map(base => ({ base, names: ['claude'] })),
    ...configs.filter(isPlace).map(base => ({ base, names: ['projects', 'agent-memory', 'plans'] })),
  ]
  /** A place's folders as keys, under the base as spelled and where it lands. */
  const keysOf = async ({ base, names }: { base: string; names: string[] }) => {
    const real = await $.fs.stat(base, { resolve: true }).then(found => found.realPath, () => undefined)
    const bases = real === undefined ? [base] : [base, real]
    return bases.flatMap(at => names.map(name => fileKey(join(join(at, name), ''))))
  }
  const keys = await Promise.all(places.map(keysOf))
  return keys.flat()
}

/** A file of Claude Code's own: inside one of its folders, unless the session runs in that folder and the file is under its cwd. */
function isClaudeOwn(roots: readonly string[], cwd: string, path: string): boolean {
  const file = fileKey(path)
  const here = fileKey(join(cwd, ''))
  return roots.some(root => {
    const isInSessionCwd = here.startsWith(root) && file.startsWith(here)
    return file.startsWith(root) && !isInSessionCwd
  })
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
  const at = await writtenAt($, startedAt, path, mtimeMs)
  // its folder gone too: nothing tells
  if (at === undefined) return true
  return runs.some(run => {
    const to = run.to ?? Infinity
    return at >= run.from - MTIME_SLACK && at <= to + MTIME_SLACK
  })
}

/** When isTurnWrite takes the file as last written: its mtime when from the turn, else its folder's. */
async function writtenAt(
  $: EngineInterface,
  startedAt: number,
  path: string,
  mtimeMs: number | undefined,
): Promise<number | undefined> {
  if (mtimeMs !== undefined && mtimeMs >= startedAt - MTIME_SLACK) return mtimeMs
  const folder = path.replace(/[\\/][^\\/]*$/, '')
  return $.fs.stat(folder).then(found => found.mtimeMs, () => undefined)
}

/** Whether the turn-start snapshot is in, waited for SNAPSHOT_WAIT at most. */
async function settle($: EngineInterface, snapshotting: Promise<unknown>): Promise<boolean> {
  const stop = new AbortController()
  try {
    return await Promise.race([
      snapshotting.then(() => true),
      $.clock.sleep(SNAPSHOT_WAIT, { signal: stop.signal }).then(() => false, () => false),
    ])
  } finally {
    stop.abort()
  }
}

const addNote = ($: EngineInterface, turnId: string, note: string) =>
  update($, recording, rec => {
    if (rec?.turnId !== turnId) return rec
    return { ...rec, notes: [...(rec.notes ?? []), note] }
  })

/** A snapshot as `pending` holds it: '' and new for a file that did not exist, null for one it could not read. */
function beforeOf(text: Snapshot): Pick<PendingFile, 'before' | 'isNew'> {
  if (text === null) return { before: '', isNew: true }
  return { before: text ?? null, isNew: false }
}

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
  const isTooLarge = stat.size > Math.min(MAX_SIZE, room)
  let text: string | undefined
  if (!isBinary && !isTooLarge) text = await $.fs.read(path).catch(() => undefined)
  if (text !== undefined && !text.includes('\0')) return { before: text, isNew: false }
  // read, it holds a NUL: binary
  const stamp = { size: stat.size, mtimeMs: stat.mtimeMs }
  return { before: null, isNew: false, stamp, isBinary: isBinary || text !== undefined }
}

/** The turn-start status of the root holding `cwd`: each listed file into the turn's `pending`, as an Edit's first call puts one. */
async function snapshotStart($: EngineInterface, cwd: string, turnId: string) {
  const repo = await repoAt($, cwd)
  if (repo === null) return
  const found = await status($, repo, await scratch($))
  if (found === null) return addNote($, turnId, `${repo.kind} status failed at turn start: shell changes are not shown.`)
  const ids = found.entries.map(entry => fileKey(join(repo.root, entry.path)))
  const tracked: string[] = []
  let room = MAX_BYTES
  for (const [i, entry] of found.entries.slice(0, MAX_FILES).entries()) {
    // its turn ended without waiting for it (SNAPSHOT_WAIT): the next turn's files are that turn's
    const rec = await read($, recording)
    if (rec?.turnId !== turnId) return
    const path = join(repo.root, entry.path)
    const file = await dirtyFile($, path, entry.isBinary, room)
    if (file === undefined) continue
    room -= file.before?.length ?? 0
    const id = ids[i]!
    tracked.push(id)
    await update($, { ...PENDING, id }, was => {
      if (was?.turnId === turnId) return was
      return { turnId, path, added: 0, removed: 0, ...file }
    })
  }
  await update($, recording, rec => {
    if (rec?.turnId !== turnId) return rec
    const added = tracked.filter(id => !rec.keys.includes(id))
    return { ...rec, base: { repo, rev: found.rev, dirty: ids }, keys: [...rec.keys, ...added] }
  })
}

/**
 * Files the status lists now and did not at turn start (clean then), by `pending` id, with their base revision as
 * before. A file an Edit already holds is left to it, unless a shell command ran before that Edit.
 */
async function shellFiles(
  $: EngineInterface,
  rec: Recording,
  touched: ReadonlyMap<string, PendingFile>,
  notes: string[],
): Promise<[string, PendingFile][]> {
  const base = rec.base!
  const repo = base.repo
  if (repo.kind === 'cm' && rec.isCmBusy === true) {
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
    } else {
      entries = [...entries, ...committed]
    }
  }
  const dirty = new Set(base.dirty)
  const fresh = new Map<string, Entry>()
  for (const entry of entries) {
    const id = fileKey(join(repo.root, entry.path))
    const pending = touched.get(id)
    const isEditFirst = pending !== undefined && pending.isAfterShell !== true
    if (dirty.has(id) || isEditFirst || fresh.has(id)) continue
    fresh.set(id, entry)
  }
  const kept = [...fresh].slice(0, MAX_FILES)
  if (fresh.size > kept.length) notes.push(`${fresh.size - kept.length} more changed files are not shown.`)
  const files = await pool(kept, LANES, async ([id, entry], lane): Promise<[string, PendingFile] | null> => {
    const path = join(repo.root, entry.path)
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat !== undefined && stat.kind !== 'file') return null
    const isTooLarge = (stat?.size ?? 0) > MAX_SIZE
    let was: Snapshot
    if (entry.isNew) {
      was = null
    } else if (!entry.isBinary && !isTooLarge) {
      const prefix = dir === undefined ? undefined : `${dir}-${lane}`
      was = await baseText($, repo, base.rev, entry.oldPath ?? entry.path, prefix)
    }
    const before = { ...beforeOf(was), ...(entry.isBinary ? { isBinary: true } : {}) }
    const pending = touched.get(id)
    if (pending === undefined) return [id, { turnId: rec.turnId, path, added: 0, removed: 0, ...before }]
    return [id, { ...pending, ...before }]
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
  const messages = await $.session.messages().catch(() => [])
  const found = turnsOf(messages).map(t => ({
    ...t,
    uses: t.uses.filter(use => !isClaudeOwn(roots, cwd, pathOf(use) ?? '')),
  }))
  const rec = await read($, recording)
  const runningPrompt = rec?.prompt ?? history.ending
  const newest = found[found.length - 1]
  if (runningPrompt !== undefined && newest?.prompt === runningPrompt) found.pop()
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
  let number: number | undefined
  if (live === null) number = undefined
  else if (mine?.prompt === live.prompt) number = mine.turn
  else number = (mine?.turn ?? 0) + 1
  const entries = listed.filter((t, k) => t.turn !== number && t.files > 0 && !quiet.has(k))
  if (live !== null) entries.push({ turn: number!, prompt: live.prompt, files: live.files.length })
  entries.sort((a, b) => a.turn - b.turn)
  const at = entries.length - (pick?.fromEnd ?? 0)
  const near = entries
    .map((t, i) => ({ t, far: Math.abs(i - at) }))
    .filter(({ t }) => t.prompt === pick?.prompt)
    .sort((a, b) => a.far - b.far)
  const wanted = near[0]?.t ?? entries[entries.length - 1]
  return { entries, number, want: wanted?.turn }
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
  if (!isListed) {
    const turn = await read($, lastTurn)
    return { turn, entries: [] }
  }
  const id = await $.session.id()
  // drawn after a /clear or a resume ended it, before the next conversation is in place: nothing of it
  if (id === history.ended) return { turn: null, entries: [] }
  // a /clear or a resume goes on under another id, with another transcript
  if (history.id !== id) {
    history.id = id
    forget(history)
  }
  let found: TranscriptTurn[] | undefined
  if (history.turns === undefined) found = await load($, history, hidden)
  const live = await read($, lastTurn)
  const quiet = await read($, quietPrompts)
  const pick = await read($, picked)
  let view = resolve(history.turns ?? [], live, quiet, pick)
  // a turn of the transcript's other than the one rebuilt last
  const isRebuildDue = view.want !== undefined && view.want !== view.number && history.rebuilt?.turn !== view.want
  if (isRebuildDue) {
    if (found === undefined) {
      found = await load($, history, hidden)
      view = resolve(history.turns ?? [], live, quiet, pick)
    }
    const turn = found.find(t => t.turn === view.want && t.turn !== view.number)
    if (turn !== undefined) {
      const cwd = await $.session.cwd()
      const files = rebuildFiles(turn.uses, cwd)
      history.rebuilt = { turn: turn.turn, prompt: turn.prompt, files, isRebuilt: true }
    }
  }
  const { entries, number, want } = view
  if (want === undefined) return { turn: null, entries }
  if (want === number) return { turn: { ...live!, turn: want }, entries }
  if (history.rebuilt?.turn === want) return { turn: history.rebuilt, entries }
  return { turn: null, entries }
}

/** A turn ended without changes, or unrecorded, and leaves the last one on show: its prompt, null when unrecorded. */
const addQuietTurn = ($: EngineInterface, prompt: string | null) => update($, quietPrompts, list => [...list, prompt])

/** Shows the newest turn from its first page. */
async function resetView($: EngineInterface) {
  await update($, picked, () => null)
  await update($, page, () => 0)
}

/** The text cut to 60 code points, so no emoji is cut in half. */
function short(text: string): string {
  const points = [...text]
  if (points.length <= 60) return text
  return `${points.slice(0, 59).join('')}…`
}

/** The file's notes, then one count of the changed lines left out: past the diff's cap and past the drawing's. */
function notesOf(file: FileDiff, drawnHidden: number): readonly string[] {
  const hidden = (file.hidden ?? 0) + drawnHidden
  if (hidden === 0) return file.notes
  return [...file.notes, `${hidden} more changed lines not shown`]
}

/** A picker entry's label: its number, its file count and its prompt cut short. */
function pickLabel(t: Listed): string {
  const parts = [`T${t.turn}`, count(t.files)]
  if (t.prompt !== '') parts.push(short(t.prompt))
  return parts.join(' · ')
}

/** The pane closed (or behind another tab), drawn, or open but behind Claude Code's diff panel: shown, not drawn. */
async function paneState($: EngineInterface, isDrawn: boolean): Promise<'closed' | 'drawn' | 'covered'> {
  const panes = await $.ui.panes()
  const isShown = panes.some(pane => pane.id === PANE && pane.isShown)
  if (!isShown) return 'closed'
  return isDrawn ? 'drawn' : 'covered'
}

/** The path cut from the left to fit `room` cells, keeping 9 characters at least. */
function fit(path: string, room: number): string {
  if (path.length <= room) return path
  const kept = Math.max(room, 10) - 1
  return `…${path.slice(-kept)}`
}

/**
 * The files the turn touched, by `pending` id: those its Edits and its turn-start status hold, taken out of `pending`,
 * and those only shell commands changed. `notes` gets why shell changes may be missing.
 */
async function collectTouched($: EngineInterface, rec: Recording, notes: string[]): Promise<Map<string, PendingFile>> {
  const touched = new Map<string, PendingFile>()
  for (const id of rec.keys) {
    const pending = await read($, { ...PENDING, id })
    await update($, { ...PENDING, id }, () => null)
    if (pending?.turnId === rec.turnId) touched.set(id, pending)
  }
  // the root the turn-start status read, kept with it: a reload mid-turn clears `vcs`
  if (rec.base !== undefined) {
    const shell = await shellFiles($, rec, touched, notes)
    for (const [id, file] of shell) touched.set(id, file)
  }
  return touched
}

/**
 * The touched files' net changes. Left out: Claude Code's own files that `hidden` names, a file recorded by size and
 * mtime that kept both, and a file only the status lists that was written while none of `runs` ran.
 */
async function diffTouched(
  $: EngineInterface,
  rec: Recording,
  touched: ReadonlyMap<string, PendingFile>,
  runs: readonly ToolRun[],
  hidden: Hidden,
): Promise<FileDiff[]> {
  const cwd = await $.session.cwd()
  let roots: string[] = []
  if (touched.size > 0) roots = await claudeOwn($, cwd, hidden)
  const files: FileDiff[] = []
  for (const pending of touched.values()) {
    // a scratchpad file, a commit message Claude wrote down: not the turn's work
    if (isClaudeOwn(roots, cwd, pending.path)) continue
    const now = await $.fs.stat(pending.path).catch(() => undefined)
    // a file recorded by size and mtime is unchanged while both are
    const stamp = pending.stamp
    const isUnchanged = stamp !== undefined && now?.size === stamp.size && now.mtimeMs === stamp.mtimeMs
    if (isUnchanged) continue
    // one only the status lists, written while none of the turn's calls ran: another session's, an editor's
    if (pending.isEdited !== true) {
      const isWritten = await isTurnWrite($, rec.startedAt, runs, pending.path, now?.mtimeMs)
      if (!isWritten) continue
    }
    const after = await snapshot($, pending.path)
    const path = clean(relativePath(cwd, pending.path))
    const file = diffFile({ ...pending, path, after })
    if (file !== null) files.push(file)
  }
  return files
}

/** The elements the pane draws with, as `$.ui.resolve(e)` gives them on the terminal and desktop. */
type PaneUi = Pick<ElementTable<'desktop'>, 'Box' | 'Button' | 'Code' | 'Select' | 'Text'>
/** Desktop's element for an SVG image. */
type SvgElement = ElementTable<'desktop'>['Svg']

/** `+a −r`, colored, then the badges dim. */
function counts(Text: PaneUi['Text'], changes: { added: number; removed: number }, badges: readonly string[] = []) {
  return (
    <Text>
      <Text color="success">+{changes.added}</Text> <Text color="error">−{changes.removed}</Text>
      {badges.map(badge => (
        <Text dimColor>{`  ${badge}`}</Text>
      ))}
    </Text>
  )
}

/** The turn picker, when there is more than one turn; a pick shows that turn from its first page. */
function turnPicker({ Select }: PaneUi, $: EngineInterface, turn: Shown, entries: readonly Listed[]) {
  if (entries.length <= 1) return false
  return (
    <Select
      key="turn"
      label="Turn"
      options={entries.slice(-PICKS).map(t => ({ value: String(t.turn), label: pickLabel(t) }))}
      value={String(turn.turn)}
      onSelect={async value => {
        const i = entries.findIndex(t => String(t.turn) === value)
        let pick: PickedTurn | null = null
        if (i >= 0) pick = { prompt: entries[i]!.prompt, fromEnd: entries.length - i }
        await update($, picked, () => pick)
        await update($, page, () => 0)
      }}
    />
  )
}

/** The turn's number, file count and totals, then its prompt, whether it was rebuilt, and its notes. */
function turnHeader({ Box, Text }: PaneUi, turn: Shown) {
  return (
    <Box key="header" flexDirection="column">
      <Text bold>
        T{turn.turn} · {count(turn.files.length)} · {counts(Text, totals(turn.files))}
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
}

/** One row per file: its path cut to fit, which turns to the file's page, then its counts and badges. */
function fileRows({ Box, Button, Text }: PaneUi, files: readonly FileDiff[], width: number, show: (i: number) => unknown) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {files.map((file, i) => {
        const tail = [`+${file.added} −${file.removed}`, ...file.badges].join('  ').length
        return (
          <Box key={`line-${i}`} justifyContent="space-between" gap={2}>
            <Button key={`row-${i}`} plain label={fit(file.path, width - tail - 2)} onPress={() => show(i)} />
            {counts(Text, file, file.badges)}
          </Box>
        )
      })}
    </Box>
  )
}

/** Prev and Next around the page number, `at` of `last`, both counted from 0. */
function pager({ Box, Button, Text }: PaneUi, $: EngineInterface, at: number, last: number) {
  return (
    <Box gap={1} marginTop={1}>
      {at > 0 && <Button key="prev" label="Prev" onPress={() => update($, page, p => Math.max(0, Math.min(p, last) - 1))} />}
      <Text dimColor>
        Page {at + 1} of {last + 1}
      </Text>
      {at < last && <Button key="next" label="Next" onPress={() => update($, page, p => Math.min(p + 1, last))} />}
    </Box>
  )
}

/** A file's share of a page: its diff text plus a cost per run and header, or its images plus a cost per hunk. */
function pageSize(file: FileDiff, framed: FileRuns | undefined, drawing: Drawing | undefined): number {
  if (framed !== undefined) {
    const parts = framed.hunks.reduce((n, hunk) => n + 1 + hunk.runs.length, 0)
    return textSize(file.hunks) + RUN_COST * parts
  }
  if (drawing === undefined) return textSize(file.hunks)
  let size = 0
  for (const hunk of drawing.hunks) {
    size += HUNK_COST
    for (const image of hunk.images) size += image.length
  }
  return size
}

/**
 * A file's hunks as numbered, selectable `Code`, one per run of lines, removed and added runs framed. The marker is
 * part of the code, so a copy takes it too: Desktop's gutter takes nothing of a mod's.
 */
function framedHunks({ Box, Code, Text }: PaneUi, file: FileDiff, framed: FileRuns): JSX.Element[] {
  return framed.hunks.map(hunk => (
    // the gap keeps a red frame's edge off a green one's, which together read as one yellow line;
    // Desktop counts a number in half lines: 0.4 of a 10 px half line is 4 px, half its smallest step (xs)
    <Box flexDirection="column" gap={0.4}>
      <Text dimColor>{hunk.header}</Text>
      {hunk.runs.map(run => {
        const source = clean(run.lines.map(line => `${run.kind} ${line}`).join('\n'))
        const code = <Code path={file.path} startLine={run.start} source={source} />
        if (run.kind === ' ') return code
        // Desktop pads a frame unless told not to: the frame hugs the code
        return (
          <Box borderStyle="single" borderColor={run.kind === '-' ? 'error' : 'success'} paddingX={0} paddingY={0}>
            {code}
          </Box>
        )
      })}
    </Box>
  ))
}

/**
 * A file's hunks as SVG images under their `@@` lines. An image can't be selected: Copy puts the hunk's lines as they
 * are now on the clipboard.
 */
function svgHunks(
  { Box, Button, Text }: PaneUi,
  Svg: SvgElement,
  $: EngineInterface,
  file: FileDiff,
  i: number,
  drawing: Drawing,
): JSX.Element[] {
  return drawing.hunks.flatMap((hunk, k) => [
    <Box justifyContent="space-between" gap={2}>
      <Text dimColor>{hunk.header}</Text>
      <Button
        key={`copy-${i}-${k}`}
        plain
        label="Copy"
        onPress={async press => {
          const copied = await $.ui.copy({ text: hunk.code, surface: press.surface })
          const message = copied.isCopied ? `Copied ${hunk.header}` : `Not copied: ${copied.reason}`
          $.ui.toast(message)
        }}
      />
    </Box>,
    ...hunk.images.map(source => <Svg source={source} alt={`Diff of ${file.path}, ${hunk.header}`} />),
  ])
}

/** A file's hunks as `diff` Code sources. */
function codeBlocks({ Code }: PaneUi, file: FileDiff): JSX.Element[] {
  return blocks(file.hunks).map(source => <Code format="diff" path={file.path} source={clean(source)} />)
}

/** One file on its page: its path and counts between two rules, its notes, then its hunks. */
function fileSection(
  { Box, Text }: PaneUi,
  file: FileDiff,
  i: number,
  width: number,
  notes: readonly string[],
  hunks: JSX.Element[],
) {
  const rule = (
    <Text dimColor wrap="truncate">
      {'─'.repeat(width)}
    </Text>
  )
  return (
    <Box key={`file-${i}`} flexDirection="column" marginTop={1}>
      {rule}
      <Box gap={2}>
        <Text bold>{file.path}</Text>
        {counts(Text, file, file.badges)}
      </Box>
      {rule}
      {notes.map(note => (
        <Text dimColor>{note}</Text>
      ))}
      {hunks}
    </Box>
  )
}

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
  let hidden: Hidden = 'all'
  if (options.hideClaudeFiles === false) hidden = 'none'
  else if (options.showMemoryAndPlans === true) hidden = 'temp'

  // Also after a hot reload. With shellEdits off nothing runs, and a version control found before is dropped.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'turn-diff', description: "Shows or hides the last turn's file changes" })
    // a change of option reloads the mod: the /config row below may come or go
    $.ui.invalidate('config.describe')
    // The root is found at the next turn's start, where the session runs by then: a Desktop spare raises session.start in
    // a neutral folder before its claim moves it. Cleared, so a reload looks again
    await update($, vcs, () => null)
    return next(e)
  })

  // With hideClaudeFiles off nothing is hidden, so there is nothing to show again: the row leaves the menu. Its key is
  // `<plugin>.<field>`, the plugin named as installed or as loaded from a folder (`@inline`)
  on('config.describe', ($, e, next) => {
    const isMemoryRow = /^last-turn-diff(?:@[^.]*)?\.showMemoryAndPlans$/.test(e.key)
    if (options.hideClaudeFiles === false && isMemoryRow) return next({ ...e, isHidden: true })
    return next(e)
  })

  // A /clear or a resume goes on with another conversation, under another id, and raises no session.start.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      history.ended = e.sessionId
      await update($, lastTurn, () => null)
      await update($, quietPrompts, () => [])
      await resetView($)
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
    const state = await paneState($, isDrawn)
    // close only what is on screen: an open pane left unplaced, behind another tab or behind the diff panel stays
    if (state === 'drawn') {
      await $.ui.close({ id: PANE })
      return { text: 'Closed the last-turn diff.' }
    }
    await resetView($)
    if (state === 'closed') isDrawn = false
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    let why = ''
    if (!opened.isPlaced) why = ` (no pane shown: ${opened.reason})`
    else if (state === 'covered') why = ` (${COVERED})`
    const { turn } = await shown($, history, options.turnHistory !== false, hidden)
    return { text: describe(turn) + why }
  })

  // Only the main loop raises turn.start; a subagent's run and a local slash command do not.
  // ($.session.turns() counts a command's rows as turns, so the mod counts its own: the numbers with turnHistory off.)
  on('turn.start', async ($, e, next) => {
    // a turn runs under the session's id: it is live, even had a session.end named it (a resume that failed)
    history.ended = undefined
    const turn = await update($, turns, n => n + 1)
    const startedAt = await $.clock.now()
    await update($, recording, () => ({ turnId: e.turnId, turn, prompt: promptLine(e.text), startedAt, keys: [] }))
    const cwd = await $.session.cwd()
    // Not awaited: a Plastic status takes seconds, so it runs while the model starts, and each tool call but Claude's
    // edits waits for it, SNAPSHOT_WAIT at most. Finding the root runs there too, never inside a hook's 10 s budget.
    if (options.shellEdits !== false) snapshotting = snapshotStart($, cwd, e.turnId).catch(() => undefined)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // Claude's own edits read their file before they run, so need no snapshot; the rest wait for it, a while
    const isEdit = e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit'
    if (!isEdit) await settle($, snapshotting)
    if (e.tool === 'Bash' || e.tool === 'PowerShell') {
      // background commands included: they may still be running when the turn ends
      const isCmBusy = CM_MOVES.test(e.command)
      await update($, recording, rec => {
        if (rec === null) return rec
        return { ...rec, hasShellRun: true, ...(isCmBusy ? { isCmBusy } : {}) }
      })
    }
    const from = await $.clock.now()
    const call = { from }
    running.add(call)
    const ran = await next(e).finally(() => running.delete(call))
    // read-only: Read, Grep, a Bash `ls`, a subagent's launch (its own calls are timed); no PowerShell command yet
    if (ran.deny !== undefined || ran.isReadOnly === true) return ran
    // one moved to the background (asked, Ctrl+B, a timeout) counts as running to the turn's end
    const result = ran.result as { backgroundTaskId?: string } | undefined
    const isBackground = result?.backgroundTaskId !== undefined
    const done: ToolRun = { ...call }
    if (!isBackground) done.to = await $.clock.now()
    await update($, recording, rec => {
      if (rec === null) return rec
      return { ...rec, runs: [...(rec.runs ?? []), done] }
    })
    return ran
  }).catch(($, e, next) => next(e)) // never blocks a tool, nor runs one twice: past next(e) it replays its result

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const rec = await read($, recording)
    if (rec === null) return next(e)
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    const id = fileKey(path)
    // The tools' originalFile comes back with CRLF turned into LF, so the before is read from disk, unless the turn
    // holds the file already. A turn-start snapshot still running may read the file after this call changed it: the
    // before read here wins over that
    const earlier = await read($, { ...PENDING, id })
    const isHeld = earlier?.turnId === rec.turnId
    let before: Snapshot
    if (!isHeld) before = await snapshot($, path)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const result = ran.result as { staged?: boolean; structuredPatch?: readonly Hunk[] } | undefined
    if (result?.staged === true) return ran
    const patch = result?.structuredPatch ?? []
    const { added, removed } = countChanges(patch.flatMap(h => h.lines))
    await update($, { ...PENDING, id }, pending => {
      if (pending?.turnId === rec.turnId) {
        // an earlier Edit counted it, or the turn-start status listed it before this call: its before stays
        const isCounted = pending.isEdited === true || isHeld
        if (isCounted) {
          return { ...pending, added: pending.added + added, removed: pending.removed + removed, isEdited: true }
        }
      }
      return {
        turnId: rec.turnId,
        path,
        ...beforeOf(before),
        added,
        removed,
        isEdited: true,
        ...(rec.hasShellRun === true ? { isAfterShell: true } : {}),
      }
    })
    await update($, recording, current => {
      if (current?.turnId !== rec.turnId || current.keys.includes(id)) return current
      return { ...current, keys: [...current.keys, id] }
    })
    return ran
  })

  // A subagent's run completes with its agentId and leaves the main turn alone.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const isSnapshotIn = await settle($, snapshotting)
    const rec = await read($, recording)
    if (rec === null) {
      // a turn started before the mod loaded: the transcript holds one more turn
      forget(history)
      await addQuietTurn($, null)
      return next(e)
    }
    // until its end is recorded, a read of the transcript leaves this turn out as a running one
    history.ending = rec.prompt
    await update($, recording, () => null)
    const notes = [...(rec.notes ?? [])]
    // ponytail: the snapshot stops at its next file, leaving those it got to in `pending` until a later turn replaces them
    if (!isSnapshotIn && rec.base === undefined) {
      notes.push('The turn-start status was still running at turn end: shell changes are not shown.')
    }
    const touched = await collectTouched($, rec, notes)
    // a call still running (a background agent's) counts as running on
    const runs = [...(rec.runs ?? []), ...running]
    const files = await diffTouched($, rec, touched, runs, hidden)
    // the transcript holds one more turn: read it again when next shown. `ending` goes before the write to `lastTurn`:
    // a draw between them reads this turn in the transcript, and the write draws again with it counted
    forget(history)
    history.ending = undefined
    // a note says shell changes may be missing: it counts only where a shell command ran
    const hasShellNote = notes.length > 0 && rec.hasShellRun === true
    if (files.length === 0 && !hasShellNote) {
      // the last turn, its pick and page stay on show; the band goes
      await addQuietTurn($, rec.prompt)
      await update($, isBandHidden, () => true)
      return next(e)
    }
    // a shown pane draws the new turn; one behind the diff panel does not
    isDrawn = false
    await update($, quietPrompts, () => [])
    await update($, lastTurn, () => ({ turn: rec.turn, prompt: rec.prompt, files, notes }))
    await update($, isBandHidden, () => false)
    await resetView($)
    // An unasked open waits undrawn below 144 columns; /turn-diff shows it then.
    if (options.autoOpen === true && files.length > 0) await $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    isDrawn = true
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const { turn, entries } = await shown($, history, options.turnHistory !== false, hidden)
    if (turn === null) return <Text dimColor>{NO_TURN}</Text>
    const width = e.props.bodyColumns
    const picker = turnPicker(ui, $, turn, entries)
    const header = turnHeader(ui, turn)
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
    const isDesktop = e.surface === 'desktop'
    const isSelectable = isDesktop && options.selectableDiffs === true
    const runs = isSelectable ? turn.files.map(f => runHunks(f.hunks)) : undefined
    const isSvg = isDesktop && runs === undefined && options.svgDiffs !== false
    // resolved once e.surface is known to be desktop: the terminal has no Svg
    const Svg = isSvg ? $.ui.resolve(e).Svg : undefined
    // drawn by the turn and the pane's width, so turning a page draws nothing again; dropped with what was read of the
    // transcript, whose numbers it holds. ponytail: a turn is known by its number, prompt and per-file counts; a content
    // hash if two ever collide
    const fileCounts = turn.files.map(f => `${f.path} ${f.added} ${f.removed}`)
    const key = [width, turn.turn, turn.prompt, ...fileCounts].join('\n')
    if (Svg !== undefined && history.drawn?.key !== key) {
      history.drawn = { key, files: turn.files.map(file => drawHunks(file.path, file.hunks, width)) }
    }
    const svgs = Svg === undefined ? undefined : history.drawn!.files
    const sizes = turn.files.map((file, i) => pageSize(file, runs?.[i], svgs?.[i]))
    const budget = svgs === undefined ? PAGE_BUDGET : SVG_PAGE_BUDGET
    const pages = paginate(sizes, budget)
    const last = pages.length - 1
    const wanted = await read($, page)
    const at = Math.min(wanted, last)
    const show = async (i: number) => {
      await update($, page, () => pages.findIndex(files => files.includes(i)))
      // best effort: the page has switched whether or not the surface scrolls
      await $.ui.scroll({ in: PANE, to: { key: `file-${i}` }, block: 'start' }).catch(() => undefined)
    }
    return (
      <Box flexDirection="column" width={width}>
        {picker}
        {header}
        {fileRows(ui, turn.files, width, show)}
        {last > 0 && pager(ui, $, at, last)}
        {(pages[at] ?? []).map(i => {
          const file = turn.files[i]!
          const framed = runs?.[i]
          const drawing = svgs?.[i]
          const notes = notesOf(file, (drawing ?? framed)?.hidden ?? 0)
          let hunks: JSX.Element[]
          if (framed !== undefined) hunks = framedHunks(ui, file, framed)
          else if (Svg !== undefined && drawing !== undefined) hunks = svgHunks(ui, Svg, $, file, i, drawing)
          else hunks = codeBlocks(ui, file)
          return fileSection(ui, file, i, width, notes, hunks)
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'mobile' || e.props.hasSurvey || e.props.isWorking) return next(e)
    const turn = await read($, lastTurn)
    if (turn === null || turn.files.length === 0) return next(e)
    const isHidden = await read($, isBandHidden)
    if (isHidden) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box gap={1}>
        <Text>
          Last turn: {count(turn.files.length)} {counts(Text, totals(turn.files))}
        </Text>
        <Button
          key="view"
          label="View"
          onPress={async () => {
            await resetView($)
            const state = await paneState($, isDrawn)
            if (state === 'covered') await $.ui.toast(`The Last turn pane is ${COVERED}.`)
            if (state !== 'closed') return
            isDrawn = false
            await $.ui.open({ id: PANE, title: TITLE })
          }}
        />
        <Button key="hide" label="x" role="dismiss" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })
}
