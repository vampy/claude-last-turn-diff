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
  /** Sentences shown above the hunks: line endings, end-of-file newline, truncation. */
  notes: string[]
  hunks: Hunk[]
}

export type LastTurn = {
  turn: number
  /** The prompt's first line. */
  prompt: string
  files: FileDiff[]
}

/** The main turn being recorded: its id and number, its prompt, and the files touched so far. */
export type Recording = {
  turnId: string
  turn: number
  prompt: string
  /** `pending` ids, one per file. */
  keys: string[]
}

/** A file's state before its first change in the turn. */
export type PendingFile = {
  turnId: string
  path: string
  /** The content before the turn; null when it was too large or unreadable. */
  before: string | null
  isNew: boolean
  /** Counted from the tools' structuredPatch, for files too large to diff. */
  added: number
  removed: number
}

declare module 'claude-code' {
  interface PluginState {
    'last-turn-diff': {
      /** Main-loop turns started since the mod loaded; slash commands start none. */
      turns: number
      recording: Recording | null
      pending: StateFamily<PendingFile | null>
      lastTurn: LastTurn | null
      isBandHidden: boolean
      page: number
    }
  }
}
