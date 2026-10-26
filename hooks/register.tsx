import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { TestResult } from '../types'

// `git push` as a command: at the start or after ; & | ( or a newline, with options allowed before
// `push` (`git -C dir push`); the words inside a string or a heredoc do not count
const GIT_PUSH = /(?:^|[;&|(\n])\s*git(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+push\b/
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
    // A project with no npm tests has nothing to check, so the push goes ahead
    if (!(await hasTests(() => $.fs.read('package.json')))) return next(e)

    $.ui.status('push-guard: running npm test…')
    const { exitCode, stdout, stderr } = await $.process.run(['npm', 'test'], { timeoutMs: 600_000 })
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
