# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A Claude Code mod (a plugin with a hooks module) that shows every file the last turn changed, one net diff per file,
in a pane, with a summary band above the prompt. `README.md` is the user-facing spec, down to every cap and edge case;
`docs/how-it-works.md` explains recording, the turn picker and shell edits. A behaviour change updates both.

## Commands

```bash
claude plugin validate .   # manifest, hooks, and the engine calls and env vars the module uses
claude plugin test .       # every tests/*.test.ts(x), each in its own child; no per-file or per-test filter
```

- Type-check with `tsc -p .`: `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which the engine writes
  (gitignored) each time it loads the mod, so load it once first.
- Run the working copy live with `claude --plugin-dir .`, or hot-reloading in every session through
  `CLAUDE_CODE_PLUGIN_DIRS` and `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` (README, Develop).
- Release: bump `version` in `.claude-plugin/plugin.json`, commit, push, then `claude plugin tag --push`.

## Architecture

`hooks/hooks.json` loads one module, `hooks/register.tsx`: every hook, all state and the UI. The pure logic beside it
is tested without the engine: `diff.ts` (line diff, hunks, caps, pagination, path keys), `history.ts` (transcript into
turns, rebuilding a turn's files from `Edit`/`Write`/`NotebookEdit` results), `vcs.ts` (git and `cm` output parsers),
`svg.ts` (Desktop's SVG hunks and their small lexer). The engine API, `$` and the test kit `claude-code/testing`, is
typed in the generated `.claude-plugin/types/claude-code/index.d.ts`: read it for what the engine offers.

A turn through `register.tsx`:

1. `session.start` (also after a hot reload) registers `/turn-diff` and clears the found root: a Desktop spare raises
   it in a neutral folder before its claim moves it.
2. `turn.start` (main loop only) opens `recording` and starts the turn-start status snapshot without awaiting it; the
   snapshot first finds the git or Plastic root of the cwd, again only when the cwd moved since.
3. `tool.call`: other calls wait for the snapshot (`SNAPSHOT_WAIT` at most) and are timed into `runs`; `Edit`,
   `Write` and `NotebookEdit` read their file's before-content from disk into `pending` (the tools' `originalFile`
   turns CRLF into LF).
4. `turn.complete` (main loop: `agentId` undefined) re-reads the touched files, adds the shell files from the
   turn-end status, drops Claude's own files and other writers', diffs, and writes `lastTurn`.
5. `ui.render` for `Pane` and `AbovePrompt` draws the pane and the band; `shown()` and `resolve()` place the live turn
   among the transcript's turns and rebuild a picked one.

What must survive a hot reload mid-turn lives in `$.state` atoms, typed by the `PluginState` slice in
`types/index.d.ts` (a new key goes there too). The module-local `snapshotting`, `running`, `history` and `isDrawn` are
meant to be dropped by a reload.

## Engine constraints

- A hook has a 10 s budget, and awaiting a plain promise counts against it; past it the engine runs the call without
  the hook and refuses the hook's later `next()`. Hence `SNAPSHOT_WAIT` of 5 s.
- `$.env.get` takes a string literal: the engine lists the variables a module reads, and a computed name fails the
  whole module load. A new variable also goes in README's "What it can reach".
- The mod only observes, which README's "What it can reach" promises: it never denies, changes or reruns a call, runs
  only read-only `git` and `cm` commands, and sends nothing over the network.
- A `Select` takes at most 64 options (`PICKS`); Desktop refuses a draw past 2,000 elements or 262,144 characters,
  hence the page budgets in `register.tsx` and the caps in `diff.ts` and `svg.ts`.
- A repository is found by asking git, never by looking for `.git`. `cm` writes its output to files in a per-user
  folder (a pipe turns non-ASCII into `?`), never a shared `/tmp`; `cm diff` never runs, as it can open the GUI.

## Tests

`tests/register.test.ts` drives the whole mod through the kit's engine on the terminal and desktop surfaces, with the
world answered by the test's own `on` hooks; `tests/transcript.ts` builds transcript rows, and `tests/parse.ts` checks
`Code` diff sources and reads SVG rows back. Kit quirks:

- A plugin's `console.log` prints nothing: throw an `Error` to surface a value.
- The test's world hooks share the 10 s budget: make something slow with many short waits, and pass `timeoutMs`.
- Assert a live recording with `turnHistory: false`; otherwise a transcript rebuild can hide the bug.
- The kit hides `~/.claude/**` from `$.fs` and, on Windows, resolves POSIX paths against the drive: test such paths
  through a rebuilt turn.

When the types don't say how the engine behaves, probe it with a throwaway mod under `claude -p --plugin-dir <probe>`.

## Code style

One step per line, so a line can be read without unpacking it:

- Await into a named `const`, then use it: `const held = await read($, { ...PENDING, id })`, and on the next line
  `const isHeld = held?.turnId === open.turnId`. A test's assertion may await inline: `expect((await pane($)).header)`.
- Branch with `if`/`else` and early returns. A ternary is a two-way pick between short expressions on one line, with
  no ternary or `await` inside; three or more cases are an `if` chain, or a small function of early returns.
- Name a condition that mixes `&&` and `||`, then test the name:
  `const isEditFirst = held !== undefined && held.isAfterShell !== true`.
- `++`, `--` and assignments are statements of their own, outside indexes, arguments and conditions.

## Conventions

Commit subjects are one imperative sentence naming the user-visible change, such as "Keep Claude's edits when the
turn-start status is slow". Comments, notes and docs are plain sentences that say exactly what happens.
