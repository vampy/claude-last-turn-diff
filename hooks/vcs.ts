import type { Vcs } from '../types'

/** One file a status or a commit range lists. */
export type Entry = {
  /** Relative to the root, forward slashes. */
  path: string
  /** Not in the base revision: untracked, added or private. */
  isNew: boolean
  /** Plastic's RevisionType says it is not text. */
  isBinary: boolean
  /** Where a moved item was, to fetch its base content from. */
  oldPath?: string
}

export type Status = {
  /** git's HEAD ('' before the first commit) or Plastic's loaded changeset. */
  rev: string
  entries: Entry[]
}

export const join = (root: string, path: string) => `${root.replace(/[\\/]$/, '')}/${path}`

/** The root nearest the cwd when both answer: both hold the cwd, so the longer; git first, so it wins a tie. */
export const nearest = (found: readonly Vcs[]): Vcs | null =>
  [...found].sort((a, b) => b.root.length - a.root.length)[0] ?? null

/** One entry per path: git's `D ` and `??` for one file, Plastic's `MV` and `CH`. */
export function merge(entries: readonly Entry[]): Entry[] {
  const byPath = new Map<string, Entry>()
  for (const entry of entries) {
    const was = byPath.get(entry.path)
    if (was === undefined) {
      byPath.set(entry.path, entry)
      continue
    }
    const oldPath = was.oldPath ?? entry.oldPath
    byPath.set(entry.path, {
      path: entry.path,
      isNew: was.isNew && entry.isNew,
      isBinary: was.isBinary || entry.isBinary,
      ...(oldPath === undefined ? {} : { oldPath }),
    })
  }
  return [...byPath.values()]
}

/** `git status --porcelain=v1 -z --no-renames`: `XY path` entries, NUL-separated. */
export const parseGitStatus = (stdout: string): Entry[] =>
  merge(
    stdout
      .split('\0')
      .filter(line => line.length > 3)
      .map(line => ({ path: line.slice(3), isNew: line.startsWith('??') || line.startsWith('A'), isBinary: false })),
  )

/** `git diff --name-status -z --no-renames`: status and path, NUL-separated, pair after pair. */
export function parseNameStatus(stdout: string): Entry[] {
  const parts = stdout.split('\0')
  const entries: Entry[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    entries.push({ path: parts[i + 1]!, isNew: parts[i] === 'A', isBinary: false })
  }
  return entries
}

const XML_NAMES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** An XML entity's character, from its name between `&` and `;`: `#x41`, `#65` or a named one. */
function entity(name: string): string {
  if (!name.startsWith('#')) return XML_NAMES[name.toLowerCase()]!
  const isHex = name[1] === 'x' || name[1] === 'X'
  // Number reads `0x41` as hex
  const digits = isHex ? `0${name.slice(1)}` : name.slice(1)
  return String.fromCodePoint(Number(digits))
}

const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, name: string) => entity(name))

/** Plastic's `cm status --xml` output: the loaded changeset and each change, folders left out. */
export function parseCmStatus(xml: string): Status | null {
  const rev = /<WorkspaceStatus>[\s\S]*?<Changeset>(\d+)<\/Changeset>/.exec(xml)?.[1]
  if (rev === undefined) return null
  const entries = [...xml.matchAll(/<Change>([\s\S]*?)<\/Change>/g)].flatMap(([, change]) => {
    const field = (name: string) => {
      const found = new RegExp(`<${name}>([^<]*)</${name}>`).exec(change!)
      return decode(found?.[1] ?? '')
    }
    const kind = field('RevisionType')
    if (kind === 'enDirectory') return []
    const type = field('Type')
    const oldPath = field('OldPath').replace(/\\/g, '/')
    return [
      {
        path: field('Path').replace(/\\/g, '/'),
        isNew: type === 'AD' || type === 'PR',
        isBinary: kind !== '' && kind !== 'enTextFile',
        ...(oldPath === '' ? {} : { oldPath }),
      },
    ]
  })
  return { rev, entries: merge(entries) }
}

/** `fn` over `items`, at most `width` at once; `fn` also gets its lane (0 ≤ lane < width), for its scratch file. */
export async function pool<T, R>(items: readonly T[], width: number, fn: (item: T, lane: number) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let at = 0
  const lane = async (n: number) => {
    while (at < items.length) {
      const i = at
      at++
      out[i] = await fn(items[i]!, n)
    }
  }
  const lanes = Array.from({ length: Math.min(width, items.length) }, (_, n) => lane(n))
  await Promise.all(lanes)
  return out
}
