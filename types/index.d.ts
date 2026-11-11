/** One unified-diff hunk: positions are 1-based, `lines` carry their ' ', '-' or '+' prefix. */
export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** One file of a finished turn: before the turn against after it. */
export type FileDiff = {
  /** Relative to the session's cwd when inside it, forward slashes. */
  path: string
  added: number
  removed: number
  /** Short marks for the file's row: `new`, `deleted`, `CRLF→LF`, `too large`. */
  badges: string[]
  /** Sentences shown above the hunks: line endings, end-of-file newline. */
  notes: string[]
  hunks: Hunk[]
  /** Changed lines past the per-file cap, left out of `hunks`; absent when none are. */
  hidden?: number
}

/** The last main turn to finish that changed files, or ran a shell command and left a note, recorded live. */
export type LastTurn = {
  /** Its number among the main turns since the mod loaded, shown with turnHistory off; on, the transcript numbers it. */
  turn: number
  /** The prompt's first line. */
  prompt: string
  files: FileDiff[]
  /** Why shell changes are missing or partial; absent before shell-edit tracking. */
  notes?: string[]
}

/** A turn picked in the pane: its prompt, and its place from the newest picker entry (1), which a turn without changes leaves. */
export type PickedTurn = { prompt: string; fromEnd: number }

/** The version control the session's cwd is in, found at session start. */
export type Vcs = {
  kind: 'git' | 'cm'
  /** The repository or workspace root, absolute, as the tool prints it. */
  root: string
}

/** The version control's status at turn start. */
export type Baseline = {
  /** The repository or workspace the status read; the turn-end status reads it again. */
  repo: Vcs
  /** git's HEAD ('' before the first commit) or Plastic's loaded changeset. */
  rev: string
  /** `pending` ids of every file the status listed, tracked or past the caps. */
  dirty: string[]
}

/** When a call of the turn ran that may have written files, in ms since the epoch; `to` absent for one in the background. */
export type ToolRun = { from: number; to?: number }

/** The main turn being recorded: its id and number, its prompt, and the files touched so far. */
export type Recording = {
  turnId: string
  turn: number
  prompt: string
  /** When the turn started, in ms since the epoch; absent in a turn recorded before calls were timed. */
  startedAt?: number
  /** `pending` ids, one per file. */
  keys: string[]
  /** The turn-start status; absent with no version control, or while or when the snapshot failed. */
  base?: Baseline
  /** Set once a Bash or PowerShell command runs in the turn. */
  hasShellRun?: boolean
  /** The turn's calls that ran and were not read-only (a subagent's launch is: its own calls count), once one has. */
  runs?: ToolRun[]
  /** Set when a Bash or PowerShell command in the turn ran `cm update`, `switch` or `merge`. */
  isCmBusy?: boolean
  notes?: string[]
}

/** A file's state before its first change in the turn. */
export type PendingFile = {
  turnId: string
  path: string
  /** The content before the turn; null when it was too large, binary or unreadable. */
  before: string | null
  isNew: boolean
  /** Counted from the tools' structuredPatch, for files too large to diff. */
  added: number
  removed: number
  /** Size and mtime at turn start, for a dirty file recorded without its content. */
  stamp?: { size: number; mtimeMs: number }
  isBinary?: boolean
  /** First edited after a shell command ran, so its before may already hold the shell's change. */
  isAfterShell?: boolean
  /** Changed by an Edit, Write or NotebookEdit call of the turn; else only the status lists it. */
  isEdited?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'last-turn-diff': {
      /** Main-loop turns started since the mod loaded; slash commands start none. */
      turns: number
      /** The root holding `cwd`, null with none; the whole null until a turn starts with shellEdits on. */
      vcs: { cwd: string; repo: Vcs | null } | null
      recording: Recording | null
      pending: StateFamily<PendingFile | null>
      lastTurn: LastTurn | null
      /**
       * The prompts of the main turns that ended after `lastTurn` (or this conversation's start) without changes, oldest
       * first; null for one unrecorded. They place `lastTurn` in the transcript, and those without changes leave the
       * picker. ponytail: one per turn, never trimmed; a count if a session ever runs thousands of turns without changes
       */
      later: (string | null)[]
      /** The turn picked in the pane; null for the newest. */
      picked: PickedTurn | null
      isBandHidden: boolean
      page: number
    }
  }
}
