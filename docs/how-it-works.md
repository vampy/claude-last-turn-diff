# How it works

How [last-turn-diff](../README.md) records a turn, rebuilds earlier ones from the transcript, and reads shell
edits from git and Plastic SCM status.

`turn.start` opens a recording. It fires for the main loop only. On the first `Edit`, `Write` or
`NotebookEdit` of a file in the turn, the mod reads the file from disk before the tool runs: in 2.1.289
the tools' `originalFile` comes back with CRLF turned into LF, so it can't show line-ending changes.
Subagent edits count toward the open turn. Denied, errored and staged calls are dropped. The pending
before-contents live in `$.state`, so a hot reload mid-turn loses nothing.

The main loop's `turn.complete` closes the turn (a subagent's carries `agentId` and is ignored); interrupted
turns count too. The mod reads every touched file again and diffs before against now in `hooks/diff.ts`:
lines with a trailing `\r` stripped, the common prefix and suffix trimmed, an LCS over the middle (a Myers diff
when the middle passes 2M LCS cells: edits far apart in a large file), and unified hunks with 3 lines of context.
Only the finished last turn is recorded; older ones are rebuilt when picked.

## Turn picker

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
The live recording takes the number of the turn before them when that turn has its prompt, or the next one. A pick
is kept as its prompt and its place counted from the newest listed turn, so it stays on its turn when old turns drop
out and the numbers shift; a new turn with changes goes back to the newest. The picker lists the newest 64 turns.

The last turn with changes this session finished shows its live recording. Any other turn is rebuilt when shown
(after a resume, the newest one too), from its `Edit`, `Write` and `NotebookEdit` calls that ran. The first call's
`originalFile` (or `original_file`) is diffed against the text the calls leave, both with LF endings. When the
transcript has no copy of the file, the calls' own `structuredPatch`es show one after another.

## Shell edits

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
- Plastic: `cm` output goes to files under `claude-last-turn-diff` in a per-user folder, since through a pipe `cm`
  turns non-ASCII into `?`: `XDG_RUNTIME_DIR`, else `TEMP`, `TMP` or `TMPDIR`, else `~/.cache`. Never a shared
  `/tmp`, where another user could plant a symlink for the mod to empty or read the files; with no such folder
  known, Plastic shell changes are not shown, with a note. Only `gwp`, `status` and `cat` run, never `cm diff`, which can open the GUI. When the
  loaded changeset moves, or a `Bash` or `PowerShell` command in the turn (background ones included) runs
  `cm update`, `switch` or `merge`, the turn-end status is skipped with a note: mid-switch it can list a
  huge, misleading change set, and a status must not run beside an update.
- A failed status (not logged in, a server error) means no shell files for that turn and a note, never
  "no changes".

A file the status lists but no `Edit`, `Write` or `NotebookEdit` call of the turn changed counts as the turn's only
when one of its tool calls was running as the file was last written, by its mtime, give or take 2 s. A call the engine
reports read-only doesn't count (`Read`, `Grep`, a Bash `ls`, a subagent's launch, whose own calls do; no PowerShell
command yet), nor one a hook denies. A call still running at turn end, or moved to the background, counts as running
to the turn's end. A deleted file, or one that kept a date from before the turn (a copy, a move), goes by its folder's
mtime, which changes as an entry comes or goes. So what another session in the same repository or workspace writes,
or an editor, between the turn's calls stays out.
