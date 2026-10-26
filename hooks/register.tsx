import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { TestResult } from '../types'

// One shell word: unquoted characters, \-escapes, 'single-quoted' and "double-quoted" parts, run together
const WORD = String.raw`(?:[^\s;&|()<>'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+`
const PART = /'[^']*'|"(?:[^"\\]|\\.)*"|(?:[^'"\\]|\\.)+/g
// `git push` as a command: at the start or after ; & | ( or a newline, with options allowed before
// `push` (`git -C dir push`); the words inside a string or a heredoc do not count. Group 1 holds the
// `cd dir &&` (or `cd dir;`) commands just before it, group 2 the options between `git` and `push`
const GIT_PUSH = new RegExp(
  String.raw`(?:^|[;&|(\n])\s*((?:cd\s+${WORD}\s*(?:&&|;|\n)\s*)*)git((?:\s+-\S+(?:\s+(?!-)${WORD})?)*)\s+push\b`,
)
const CD = new RegExp(String.raw`cd\s+(${WORD})`, 'g')
const OPTION = new RegExp(WORD, 'g')
// Lines test runners print for a failing test (node:test, jest, tap, mocha, this repo's runner)
const FAILED_LINE = /✖|✗|✕|\bnot ok\b|\bFAIL\b|\bfailing\b|\bfailed\b/i
// A runner's summary count, e.g. "2 failing" or "3 failed"
const FAILED_COUNT = /(\d+) (?:failing|failed)\b/i
// One line per failing test, without summary lines
const FAILED_TEST = /✖|✗|✕|\bnot ok\b/

// The `test` script `npm init` writes, which only prints an error
const NO_TEST_SPECIFIED = /no test specified/

const last = atom({ plugin: 'push-guard', key: 'last' } as const, null)

// Whether package.json has a `test` script that runs tests
async function hasTests(read: () => Promise<string>): Promise<boolean> {
  try {
    const test = JSON.parse(await read())?.scripts?.test
    return typeof test === 'string' && test.trim() !== '' && !NO_TEST_SPECIFIED.test(test)
  } catch {
    return false // no package.json, or one npm could not read either
  }
}

// A path is absolute from / (or a Windows drive); cd and git -C replace the folder with it
const isAbsolute = (path: string) => /^(?:[\\/]|[A-Za-z]:[\\/])/.test(path)
const join = (from: string, to: string) => `${from.replace(/[\\/]+$/, '')}/${to}`

// A word as the shell passes it on, or undefined when only the shell can say: a variable, a command's
// output, a wildcard, or `~` (the mod API does not give the home folder)
function unquote(word: string): string | undefined {
  if (word.startsWith('~')) return undefined
  let text = ''
  for (const [part] of word.matchAll(PART)) {
    if (part.startsWith("'")) text += part.slice(1, -1)
    else if (/[$`]/.test(part)) return undefined
    else if (part.startsWith('"')) text += part.slice(1, -1).replace(/\\([$`"\\])/g, '$1')
    else if (/[*?[{]/.test(part)) return undefined
    else text += part.replace(/\\(.)/g, '$1')
  }
  return text
}

// The folder `git push` in the command runs in, from the `cd dir &&` just before it and its `-C dir`
// options, each taken from the one before as git and the shell do. Undefined means the session's
// folder, also when the folder cannot be told from the command; a relative path is from the session's folder
function pushFolder(command: string): string | undefined {
  const match = GIT_PUSH.exec(command)
  if (!match) return undefined
  const dirs = [...match[1].matchAll(CD)].map(([, dir]) => dir)
  if (dirs.some(dir => dir.startsWith('-'))) return undefined // `cd -` and cd's own options
  const options = match[2].match(OPTION) ?? []
  for (let i = 0; i < options.length - 1; i++) if (options[i] === '-C') dirs.push(options[++i])

  let folder: string | undefined
  for (const word of dirs) {
    const dir = unquote(word)
    if (dir === undefined) return undefined
    if (isAbsolute(dir)) folder = dir
    else if (dir !== '' && dir !== '.') folder = folder === undefined ? dir : join(folder, dir)
  }
  return folder
}

function countFailing(output: string[]): number {
  for (const line of output) {
    const match = FAILED_COUNT.exec(line)
    if (match) return Number(match[1])
  }
  return output.filter(line => FAILED_TEST.test(line)).length || -1
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!GIT_PUSH.test(e.command)) return next(e)
    // `git -C dir push` and `cd dir && git push` push the project in dir, so its tests are the ones to run
    const folder = pushFolder(e.command)
    const dir = folder === undefined || isAbsolute(folder) ? folder : join(await $.session.cwd(), folder)
    // A project with no npm tests has nothing to check, so the push goes ahead
    if (!(await hasTests(() => $.fs.read(dir === undefined ? 'package.json' : join(dir, 'package.json'))))) return next(e)

    $.ui.status('push-guard: running npm test…')
    const init = dir === undefined ? { timeoutMs: 600_000 } : { cwd: dir, timeoutMs: 600_000 }
    const { exitCode, stdout, stderr } = await $.process.run(['npm', 'test'], init)
    $.ui.status(undefined)

    const output = `${stdout}\n${stderr}`.split('\n').map(line => line.trimEnd())
    const result: TestResult = { failing: exitCode === 0 ? 0 : countFailing(output) }
    await update($, last, () => result)

    if (exitCode === 0) return next(e)

    const failed = output.filter(line => FAILED_LINE.test(line))
    const shown = (failed.length ? failed : output.filter(Boolean).slice(-15)).join('\n')

    return { deny: `push-guard: npm test failed (exit ${exitCode}), so the push was blocked.\n\nFailed tests:\n${shown}` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: could not run npm test, so the push was blocked.` },
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const result = await read($, last)
    if (e.props.hasSurvey || result === null) return next(e)

    const { Text } = $.ui.resolve(e)

    if (result.failing === 0) return <Text color="success">push-guard: all tests passing</Text>

    const count = result.failing === -1 ? 'tests failing' : `${result.failing} ${result.failing === 1 ? 'test' : 'tests'} failing`
    return <Text color="error">push-guard: {count}</Text>
  })
}
