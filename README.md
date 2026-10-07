# last-turn-diff

A Claude Code mod that adds a Codex-style "Last turn" diff. After each turn, one pane shows every file
Claude changed in that turn, as one net diff per file. It works in the Claude Desktop Code tab and in the
terminal. It needs no version control and never calls one: the diffs come from Claude's own tool calls and
file reads, so it works the same under any version control, or none.

- `/turn-diff` opens the pane, or closes it if it is open. It also replies with a one-line summary, which
  is all you get on mobile.
- The pane header reads `T3 · 3 files · +12 −4`, with the prompt's first line under it. Below that is one row
  per file (path, counts, and `new` / `deleted` / `CRLF→LF` / `too large` badges); pressing a row jumps to
  that file. Each file's hunks follow in `diff` code blocks. A large turn is split into pages with
  Prev/Next.
- The band above the prompt reads `Last turn: 3 files +12 −4  [ View ]  [ x ]` after a turn with edits.
  View opens the pane; x hides the band until the next turn.

## How it works

`turn.start` opens a recording. It fires for the main loop only. On the first `Edit`, `Write` or
`NotebookEdit` of a file in the turn, the mod reads the file from disk before the tool runs: in 2.1.289
the tools' `originalFile` comes back with CRLF turned into LF, so it can't show line-ending changes.
Subagent edits count toward the open turn. Denied, errored and staged calls are dropped. The pending
before-contents live in `$.state`, so a hot reload mid-turn loses nothing.

The main loop's `turn.complete` closes the turn (a subagent's carries `agentId` and is ignored); interrupted
turns count too. The mod reads every touched file again and diffs before against now in `hooks/diff.ts`:
lines with a trailing `\r` stripped, the common prefix and suffix trimmed, an LCS over the middle, and
unified hunks with 3 lines of context. Only the finished last turn is kept.

## Load it

Terminal, for one session:

```bash
claude --plugin-dir /path/to/claude-last-turn-diff-mod
```

Desktop Code tab (and every terminal session): add these to the `env` block of `~/.claude/settings.json`,
then start a new session. The second line reloads the mod when its files change. On Windows, double the
backslashes in the path (`C:\\path\\to\\claude-last-turn-diff-mod`).

```json
"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-last-turn-diff-mod",
"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
```

## Develop

From the mod's folder:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

`tsc -p .` type-checks once the engine has loaded the mod and written `.claude-plugin/types/` (ignored by
git; the engine rewrites it on every load).

## Known limits

- Only `Edit`, `Write` and `NotebookEdit` calls are seen. Changes made by shell commands or scripts are
  not.
- Only the last turn is kept, in memory, and turns are numbered from when the mod loaded (slash commands
  don't count). Neither survives a restart or `--resume`: numbering starts again at T1.
- A background subagent that edits after the main turn ended is not recorded, or lands in the next turn.
- The before-content is read when the tool call starts, before any permission prompt. If you change the
  file yourself while the prompt is up, your change shows in the diff too.
- Files are read as UTF-8 text: UTF-16 files diff as noise.
- Files over 2 MiB show as "too large to diff", with counts from the tools' `structuredPatch` where it has
  any.
- Past 2M LCS cells, a file's changed middle shows as one delete block and one insert block. Each file
  shows at most about 60,000 characters of diff, and the rest is counted in a note.
- Desktop (app 2.26454) draws no mod UI for a session shown in the second half of a split view: no
  pane, no band, though `/turn-diff` still answers. Show the session on its own to see them.
- Desktop: code isn't selectable, long lines wrap, and nothing scrolls inside a pane on its own. Each code
  block holds at most 10,000 characters, and each page about 90,000, to stay well under the ~256 KB draw
  that reportedly freezes a pane. A turn touching several hundred files could still go past that.
- Jumping to a file scrolls the pane only where the surface supports it. The page switches either way.
