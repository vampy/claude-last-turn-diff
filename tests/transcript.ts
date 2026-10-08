import type { SessionMessage, ToolUseSummary } from 'claude-code'

import { diffLines, splitLines, toHunks } from '../hooks/diff'

/** A prompt's row. */
export const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

/** The model's closing text. */
export const reply = (text = 'Done.'): SessionMessage => ({ role: 'assistant', text, toolUses: [] })

/** A local slash command's row, as the transcript keeps one: `<command-name>` first. */
export const command = (name: string, args = '') =>
  prompt(`<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`)

/** A skill's slash command row: `<command-message>` first. */
export const skill = (name: string, args?: string) =>
  prompt(
    `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>${args === undefined ? '' : `\n<command-args>${args}</command-args>`}`,
  )

let ids = 0

/** One tool call: the assistant row carrying it and the user row answering it. */
export function call(tool: string, input: Record<string, unknown>, outcome: Partial<ToolUseSummary> = {}): SessionMessage[] {
  const use: ToolUseSummary = { tool_use_id: `toolu_${++ids}`, tool, input, text: `${tool} ran`, ...outcome }
  const result = use.result === undefined ? {} : { result: use.result }
  return [
    { role: 'assistant', text: '', toolUses: [use] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: use.tool_use_id, text: use.text ?? '', isError: use.isError === true, ...result }] },
  ]
}

const lf = (text: string) => text.replace(/\r\n/g, '\n')

/** The structuredPatch the tools report, over LF line endings. */
export const patch = (before: string, after: string) => toHunks(diffLines(splitLines(lf(before)), splitLines(lf(after))))

/**
 * An Edit of `text`; `original` is what the transcript keeps as its originalFile: by default the text with LF endings,
 * as the tool returns it live; null in a resumed transcript past ~10 KB; '' in a headless one.
 */
export function edit(path: string, text: string, old: string, now: string, original: string | null = lf(text)) {
  return call(
    'Edit',
    { file_path: path, old_string: old, new_string: now, replace_all: false },
    {
      result: {
        filePath: path,
        oldString: old,
        newString: now,
        originalFile: original,
        structuredPatch: patch(text, text.replace(old, () => now)),
        userModified: false,
        replaceAll: false,
      },
    },
  )
}

/** A Write of `content`; `was` is the text it replaced, null for a new file; `original` what the transcript keeps of it. */
export function write(path: string, content: string, was: string | null, original: string | null = was) {
  return call(
    'Write',
    { file_path: path, content },
    {
      result: {
        type: was === null ? 'create' : 'update',
        filePath: path,
        content,
        structuredPatch: was === null ? [] : patch(was, content),
        originalFile: original,
      },
    },
  )
}
