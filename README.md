# last-turn-diff

A Claude Code mod that adds a Codex-style "Last turn" diff. After each turn, one pane shows every file
changed during that turn (except Claude's own scratch, memory and plan files: see `hideClaudeFiles`), as
one net diff per file. It works in the Claude Desktop Code tab and in the terminal. Claude's `Edit`,
`Write` and `NotebookEdit` calls are seen under any version control, or none.
Inside a git repository or a Plastic SCM workspace, files changed by shell commands, scripts and builds
show too: the mod reads the version control's status around each turn.

- `/turn-diff` opens the pane, or closes it if it is open. It also replies with a one-line summary, which
  is all you get on mobile.
- The pane header reads `T3 · 3 files · +12 −4`, with the prompt's first line under it, a note when
  shell changes could not be read, and a line saying so when the turn was rebuilt from the transcript. Below that is one row per file (path, counts, and `new` / `deleted` /
  `CRLF→LF` / `binary` / `too large` badges); pressing a row jumps to that file. Each file's hunks follow:
  in the terminal as `diff` code blocks; in the Desktop Code tab as images with red and green lines, line
  numbers and syntax colors, each under its `@@` line and a Copy button (see `svgDiffs`). A large turn is
  split into pages with Prev/Next.
- A **Turn** picker at the top of the pane lists the turns that changed files, the newest 64 the transcript holds, each
  with its prompt and the number of files it edited. It shows the last turn with changes by default; pick an older one
  to see its changes, rebuilt from the transcript. A turn that changes nothing (a question, a background task's
  notice) leaves the pane as it was, and is not listed. The history survives `--resume` and `--continue`. `/turn-diff` and View go back to
  the last turn with changes. `turnHistory` turns it off.
- The band above the prompt reads `Last turn: 3 files +12 −4  [ View ]  [ x ]` after a turn with edits.
  View opens the pane; x hides the band until the next turn with edits. A turn without edits hides it too.

## How it works

`turn.start` opens a recording. It fires for the main loop only. On the first `Edit`, `Write` or
`NotebookEdit` of a file in the turn, the mod reads the file from disk before the tool runs: in 2.1.289
the tools' `originalFile` comes back with CRLF turned into LF, so it can't show line-ending changes.
Subagent edits count toward the open turn. Denied, errored and staged calls are dropped. The pending
before-contents live in `$.state`, so a hot reload mid-turn loses nothing.

The main loop's `turn.complete` closes the turn (a subagent's carries `agentId` and is ignored); interrupted
turns count too. The mod reads every touched file again and diffs before against now in `hooks/diff.ts`:
lines with a trailing `\r` stripped, the common prefix and suffix trimmed, an LCS over the middle, and
unified hunks with 3 lines of context. Only the finished last turn is recorded; older ones are rebuilt when picked.

### Turn picker

The turns come from `$.session.messages()`. The mod reads it when the pane is first drawn after a turn ends, a
reload, a resume, a `/clear` (it goes on under another session id) or a `/compact`, and again to rebuild a picked
turn. Each user row opens a turn unless it holds tool results or is one of these, which start no model turn: a local
slash command (`<command-name>` first) or its output, a `!` command or its output, an interruption, or a compaction
summary. A skill's command (`<command-message>` first) does open one and shows as `/name args`. Turns are numbered
by their place in the transcript, so slash and `!` commands don't count. Listed are the turns whose calls edited a
file, and the live recording. A turn that ends with no changes leaves the last one recorded on show, along with any
pick and page, and is not listed even if its edits cancel out. One whose shell changes could not be read and that ran
a shell command is shown instead, with its note. The mod keeps the prompts of the turns that ended without changes
since the live recording; each is the transcript's turn at its place with its prompt, or has no row (a continuation).
The live recording takes the number of the turn before them when that turn has its prompt, or the next one. A pick is kept as its prompt and its place counted from the newest listed turn, so it stays
on its turn when old turns drop out and the numbers shift; a new turn with changes goes back to the newest. The picker
lists the newest 64 turns.

The last turn with changes this session finished shows its live recording. Any other turn is rebuilt when shown
(after a resume, the newest one too), from its `Edit`, `Write` and `NotebookEdit` calls that ran. The first call's
`originalFile` (or `original_file`) is diffed against the text the calls leave, both with LF endings. When the
transcript has no copy of the file, the calls' own `structuredPatch`es show one after another.

### Shell edits

At session start (and after each reload) the mod asks `git rev-parse --show-toplevel` and
`cm gwp <cwd> --format={1}` where the session runs; when both answer, the root nearest the cwd wins. It
never looks for a `.git` folder: an empty one makes git fail.

At turn start it reads the status: `git status --porcelain=v1 -z --untracked-files=all --no-renames`, or
`cm status --controlledchanged --changed --localdeleted --private --xml=<file>`. It records HEAD or the
loaded changeset, and each listed file's content, as an `Edit` would (binary files and those past the caps
by size and mtime alone). This runs alongside the model's first request rather than before it, and every
tool call waits for it, so no tool runs before the snapshot. At turn end it reads the status again. A file
listed now but not at turn start was clean then, so its before is the base revision:
`git cat-file --filters <HEAD>:<path>`, which keeps the CRLF `core.autocrlf` writes, or
`cm cat rev:<path>#cs:<changeset> --raw --file=<file>`, eight at a time. A file dirty at turn start diffs
against its turn-start content and drops out if the turn didn't change it.

- git: a commit during the turn still shows its files, from `git diff --name-status <old> <new>`. A HEAD
  that moved any other way (a reset, a checkout) gets a note instead.
- Plastic: `cm` output goes to files under `%TEMP%\claude-last-turn-diff`, since through a pipe `cm` turns
  non-ASCII into `?`. Only `gwp`, `status` and `cat` run, never `cm diff`, which can open the GUI. When the
  loaded changeset moves, or a `Bash` or `PowerShell` command in the turn (background ones included) runs
  `cm update`, `switch` or `merge`, the turn-end status is skipped with a note: mid-switch it can list a
  huge, misleading change set, and a status must not run beside an update.
- A failed status (not logged in, a server error) means no shell files for that turn and a note, never
  "no changes".

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

## Options

- `autoOpen` (on by default): open the pane by itself when a turn ends with file changes. Like any pane
  opened unasked, it is shown only in a terminal at least 144 columns wide (110 once you have opened it
  yourself); below that it waits, and `/turn-diff` shows it.
- `shellEdits` (on by default): also show files changed by shell commands, scripts and builds, read from
  git or Plastic SCM status around each turn. Off, the mod runs no process at all and sees only `Edit`,
  `Write` and `NotebookEdit` calls. Turn it off if a status is slow in your repository or workspace: in a
  large Plastic workspace each `cm status` takes a few seconds (2.3 s on a big Unreal project), and each
  base revision fetched from a cloud repository about a second.
- `turnHistory` (on by default): list the conversation's turns in the pane, so an earlier one can be picked and its
  changes rebuilt from the transcript. Off, the mod never reads the transcript: the pane shows only the last turn with
  changes the mod recorded, numbered from when it loaded (slash commands don't count), and after a restart or `--resume` nothing
  until a turn ends. Turn it off if reading the transcript after each turn is slow in a long session.
- `hideClaudeFiles` (on by default): leave out Claude Code's own files, live and in rebuilt turns:
  - its temporary folder, such as the scratchpad where it writes notes and commit messages: `claude` under
    `CLAUDE_CODE_TMPDIR`, or else under each of `TEMP`, `TMP` and `TMPDIR` the environment names, and `/tmp`;
  - its memory and plans: `projects`, `agent-memory` and `plans` in its config folder, `CLAUDE_CONFIG_DIR` or else
    `.claude` in the home folder (`HOME` or `USERPROFILE`). The rest of that folder (settings, `CLAUDE.md`, skills)
    still shows, and so does memory or a plan a setting moved elsewhere.

  Each folder is matched under its parent as spelled and where that lands (a symlink or junction's target; macOS's
  `/private/var`). On Windows a parent spelled from `/` (such as `/tmp`) is skipped: it would land on the session's
  drive. A turn that changed only such files counts as changing nothing. A session run inside one of those folders
  still sees the files under its own cwd.
- `svgDiffs` (on by default): in the Desktop Code tab, draw each file's hunks as SVG images. Desktop (app
  2.26454) draws a `Code` element's `format: 'diff'` as plain `diff` text, with no line numbers, line
  backgrounds or language colors, so the mod draws them itself. An image's text can't be selected, so each
  hunk has a Copy button that puts its lines as they are now (unchanged and added, no markers) on the
  clipboard. Off, Desktop shows the plain `diff` code blocks the terminal gets. Turn it off if the images
  ever draw wrong.

To turn any of them off in a terminal, use `/config`. The Desktop Code tab has no `/config`: add this to
`~/.claude/settings.json` and start a new session. Project settings are not read for plugin options. The
key `last-turn-diff@inline` works too; it is the one `claude plugin configure` writes.

```json
"pluginConfigs": {
  "last-turn-diff": {
    "options": { "autoOpen": false, "shellEdits": false, "turnHistory": false, "hideClaudeFiles": false, "svgDiffs": false }
  }
}
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

- Shell changes are seen only inside the git repository or Plastic workspace the session started in, and
  not in files it ignores (`.gitignore`, Plastic's `ignore.conf`). Outside both, only `Edit`, `Write` and
  `NotebookEdit` calls are seen.
- Anything that changes a file during a turn counts as the turn's, your own editor included.
- Snapshot caps: content is recorded for files dirty at turn start up to 16 MiB in all; past that (or past
  2 MiB, or binary) a file is recorded by size and mtime and shows without hunks if those change. Past
  1,000 dirty files the rest are left out. At turn end at most 1,000 newly listed files are shown, with a
  note for the rest.
- A hot reload while the turn-start status is still running loses shell changes for that turn.
- A Plastic turn that runs `cm update`, `switch` or `merge`, or moves the loaded changeset (a check-in),
  shows only Claude's own edits and the files dirty at turn start, with a note. One started in the
  background in an earlier turn and still running at the next turn's start is not detected: that turn's
  read-only `cm status` runs beside it.
- Plastic moves made by a shell `mv` (not `cm mv`) show as a deleted file and a new one: the mod leaves
  out `--localmoved`, a slow similarity search.
- Gluon (partial) Plastic workspaces are neither handled nor tested.
- A status slower than about 10 s at turn start can outlast the first tool call's hook budget; that tool
  then runs before the snapshot ends.
- Only the last turn is recorded live. Older turns are rebuilt from the transcript when picked, and show only
  `Edit`, `Write` and `NotebookEdit` calls of the main conversation: no shell changes, no subagent edits, and no
  line-ending changes (the tools hand back `originalFile` with LF). A turn that changed a file and changed it back
  shows nothing, unless the transcript kept no copy of the file: then both calls' patches show.
- The picker reads only the newest 4,096 transcript entries, and a compaction drops the turns before it. Turns
  number from the oldest one left, so in a long session the numbers shift as old turns drop out. It lists only the
  newest 64 turns, the most a `Select` takes. A `/clear` or a resume inside a session starts a new list and clears
  the last turn.
- An older turn's file count is the number of files its calls edited, so it can differ from the files its rebuilt
  diff shows, for example when a turn edits a file back to how it was. A turn that changed files only through shell
  commands or subagents is listed while it is the last turn with changes, and drops out of the list after the next one.
- Claude Code doesn't keep every `Edit`'s and `Write`'s `originalFile`. A headless (`-p`) run strips them all; a
  resumed transcript keeps them only for files under about 10 KB; and, as 2.1.292's code reads, a session strips the
  bulk of all but about its newest 200 messages. Without it, a rebuilt file shows each call's own patch in turn, with
  its own line numbers, so older turns usually show that way.
- A turn with no prompt row in the transcript (a continuation, a message from another session) is recorded live
  as the turn after the one before it. Once rebuilt, its calls count toward the turn before it. A prompt with no text
  (an image alone) can't be told from a continuation: a continuation without changes right after such prompts can
  take one's place and give the turn shown the wrong number.
- A background subagent that edits after the main turn ended is not recorded, or lands in the next turn.
- The before-content is read when the tool call starts, before any permission prompt. If you change the
  file yourself while the prompt is up, your change shows in the diff too.
- Files are read as UTF-8 text. A file holding a NUL byte shows as `binary`, with no hunks: UTF-16 files
  do too.
- Files over 2 MiB show as "too large to diff", with counts from the tools' `structuredPatch` where it has
  any.
- Past 2M LCS cells, a file's changed middle shows as one delete block and one insert block. Each file
  shows at most about 60,000 characters of diff, and the rest is counted in a note.
- Desktop (app 2.26454) draws no mod UI for a session shown in the second half of a split view: no
  pane, no band, though `/turn-diff` still answers. Show the session on its own to see them.
- Desktop: code isn't selectable, long lines wrap, and nothing scrolls inside a pane on its own. Desktop
  refuses a draw past 2,000 elements or 262,144 characters. Each code block holds at most 10,000
  characters and each page about 90,000; with `svgDiffs` each file draws at most about 150,000 characters
  of SVG (roughly 800 to 2,000 lines, the rest counted in a note) and each page about 160,000. A turn
  touching several hundred files could still go past the limit.
- Desktop images (`svgDiffs`): the colors come from a small lexer in `hooks/svg.ts` (comments, strings,
  numbers, one shared keyword list), not from Desktop's highlighter or theme, so they are approximate.
  Multi-line strings aren't tracked. Wide characters (CJK, emoji) can push a row past its wrap width. The
  image is laid out for the pane's width when drawn, and scales down if the pane gets narrower. Selectable
  text would need interactive `Svg`s, each a sandboxed frame, but Desktop rebuilds the pane on every
  redraw, a scroll included, and every frame flashes white as it reloads. A Copy takes the whole hunk,
  including lines past the drawing's cap; a line cut at 2,000 characters for display is copied cut.
- Jumping to a file scrolls the pane only where the surface supports it. The page switches either way.

## Roadmap

- **Distribution**: a public repo with `.claude-plugin/marketplace.json` so it installs with
  `/plugin install`, and `claude plugin tag` for releases.
- **A user-facing README**: restructure this file like the READMEs of the
  [claude-code-playground mods](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods),
  [claude-flightdeck](https://github.com/scasella/claude-flightdeck) and
  [claude-statuspane](https://github.com/xuanji86/claude-statuspane). Install and usage instructions
  first, then screenshots and a GIF or video of a real turn in the terminal and in Desktop, then what it
  does, with the develop section last.
