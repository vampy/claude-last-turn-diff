import type { SessionMessage, ToolUseSummary } from 'claude-code'

import type { FileDiff, Hunk } from '../types'
import { capHunks, clean, cut, diffFile, fileKey, relativePath } from './diff'

/** One turn of the transcript: numbered from the oldest one it holds, its prompt line and its tool calls in order. */
export type TranscriptTurn = { turn: number; prompt: string; uses: ToolUseSummary[] }

/**
 * User rows that start no turn, as no model turn starts with them: a local command (`<command-name>` first; a skill's
 * starts with `<command-message>` and does start one) and its output, a `!` command and its output, an interruption,
 * a compaction's summary.
 */
const NO_TURN =
  /^(?:<command-name>|<local-command-|<bash-(?:input|stdout|stderr)>|\[Request interrupted by user|This session is being continued from a previous conversation)/

/** The prompt's first line as the pane shows it: a background task's summary for its notification, `/name args` for a skill. */
export function promptLine(text: string): string {
  const skill = /^\s*<command-message>[\s\S]*?<command-name>([^<]*)<\/command-name>(?:\s*<command-args>([^<]*)<\/command-args>)?/.exec(text)
  const line = text.trimStart().startsWith('<task-notification>')
    ? /<summary>([^<]*)<\/summary>/.exec(text)?.[1]?.trim() || 'Background task finished'
    : skill !== null ? `${skill[1]} ${skill[2] ?? ''}`
    : text
  // cut by code points, so no emoji is cut in half
  return clean([...(line.split('\n').find(one => one.trim() !== '') ?? '').trim()].slice(0, 200).join(''))
}

/**
 * The transcript's turns: each user row with neither tool results nor a NO_TURN start opens one, and every assistant
 * row's tool calls up to the next go to it. Calls before the first prompt (a turn the 4,096-entry window cut) are dropped.
 */
export function turnsOf(messages: readonly SessionMessage[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const message of messages) {
    if (message.role === 'assistant') turns[turns.length - 1]?.uses.push(...message.toolUses)
    else if ((message.toolResults ?? []).length === 0 && !NO_TURN.test(message.text.trimStart())) {
      turns.push({ turn: turns.length + 1, prompt: promptLine(message.text), uses: [] })
    }
  }
  return turns
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)
const lf = (text: string) => text.replace(/\r\n/g, '\n')

/** The file an Edit, Write or NotebookEdit call names; undefined for any other tool. */
const pathOf = (use: ToolUseSummary) =>
  use.tool === 'NotebookEdit' ? str(use.input.notebook_path)
  : use.tool === 'Edit' || use.tool === 'Write' ? str(use.input.file_path)
  : undefined

/** The turn's Edit, Write and NotebookEdit calls that ran (not denied, errored or staged), by file as first touched. */
export function editsOf(uses: readonly ToolUseSummary[]): Map<string, ToolUseSummary[]> {
  const files = new Map<string, ToolUseSummary[]>()
  for (const use of uses) {
    const path = pathOf(use)
    const isStaged = (use.result as { staged?: unknown } | undefined)?.staged === true
    if (path === undefined || use.isError === true || use.text === undefined || isStaged) continue
    files.set(fileKey(path), [...(files.get(fileKey(path)) ?? []), use])
  }
  return files
}

/** A tool's structuredPatch as hunks: malformed ones and `\ No newline` rows dropped, `\r` stripped, long lines cut. */
function patchOf(value: unknown): Hunk[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((hunk: Partial<Hunk> | null) => {
    const { oldStart, oldLines, newStart, newLines, lines } = hunk ?? {}
    if (typeof oldStart !== 'number' || typeof oldLines !== 'number' || typeof newStart !== 'number') return []
    if (typeof newLines !== 'number' || !Array.isArray(lines)) return []
    const rows = lines.filter((line): line is string => typeof line === 'string' && /^[ +-]/.test(line))
    return [{ oldStart, oldLines, newStart, newLines, lines: rows.map(line => cut(line.replace(/\r$/, ''))) }]
  })
}

/**
 * One file's net change over the turn from its calls: the first call's before (Edit's and Write's originalFile, gone from
 * a resumed transcript past ~10 KB and blank in a headless one) against the text the calls leave, all with LF endings.
 * Without both, the calls' own patches, one after another.
 */
function rebuildFile(path: string, calls: readonly ToolUseSummary[]): FileDiff | null {
  let before: string | undefined
  let text: string | undefined
  let isNew = false
  const patches: Hunk[] = []
  calls.forEach((use, i) => {
    const result = (use.result ?? {}) as Record<string, unknown>
    const patch = patchOf(result.structuredPatch)
    // as the user left it in the permission dialog
    const old = str(result.oldString) ?? str(use.input.old_string) ?? ''
    // a file Write creates, or an Edit from an empty old_string makes (it takes no file but an absent or empty one)
    const isMade = use.tool === 'Write' ? result.type === 'create' : use.tool === 'Edit' && old === ''
    let was = isMade ? '' : use.tool === 'NotebookEdit' ? str(result.original_file) : str(result.originalFile)
    // a stripped record (headless, or older than the ones Claude Code keeps whole) blanks originalFile: '' is not a
    // file the call found text in (old lines in its patch, an old_string)
    if (was === '' && (patch.some(h => h.oldLines > 0) || (use.tool === 'Edit' && old !== ''))) was = undefined
    if (use.tool === 'Write') {
      // a stripped record keeps '' for the content too: the call's input still holds it
      const content = str(result.content) || str(use.input.content)
      text = content === undefined ? undefined : lf(content)
    } else if (use.tool === 'Edit') {
      const now = str(result.newString) ?? str(use.input.new_string) ?? ''
      const isAll = result.replaceAll === true || use.input.replace_all === true
      // its own before wins over the text so far: a shell command may have changed the file in between
      const base = was === undefined ? text : lf(was)
      // as the tool applies it: deleting text that ends a line takes the line's newline with it
      const cut = now === '' && !old.endsWith('\n') && base?.includes(`${old}\n`) === true ? `${old}\n` : old
      text = base?.includes(cut) ? (isAll ? base.split(cut).join(now) : base.replace(cut, () => now)) : undefined
    } else {
      const updated = str(result.updated_file)
      text = updated === undefined ? undefined : lf(updated)
    }
    if (i === 0) {
      before = was === undefined ? undefined : lf(was)
      isNew = isMade
    }
    patches.push(...patch)
  })
  const added = patches.reduce((sum, h) => sum + h.lines.filter(line => line.startsWith('+')).length, 0)
  const removed = patches.reduce((sum, h) => sum + h.lines.filter(line => line.startsWith('-')).length, 0)
  if (before !== undefined && text !== undefined) return diffFile({ path, before, after: text, isNew, added, removed })
  const notes =
    patches.length === 0 ? ['no diff in the transcript']
    : calls.length > 1 ? ['shown call by call: the transcript keeps no copy of this file']
    : []
  return { path, added, removed, badges: isNew ? ['new'] : [], notes, hunks: capHunks(patches, notes) }
}

/** The files a transcript turn's Edit, Write and NotebookEdit calls changed, paths relative to `cwd`. */
export function rebuildFiles(uses: readonly ToolUseSummary[], cwd: string): FileDiff[] {
  return [...editsOf(uses).values()].flatMap(calls => rebuildFile(clean(relativePath(cwd, pathOf(calls[0]!)!)), calls) ?? [])
}
