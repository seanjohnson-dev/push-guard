import { expect, test } from 'claude-code/testing'

const FAILING = { exitCode: 1, stdout: '  ✔ adds up the items\n  ✖ adds 15% VAT: expected 11500, got 11000\n\n1 failing\n', stderr: '' }
const PASSING = { exitCode: 0, stdout: '  ✔ adds up the items\n\nall passing\n', stderr: '' }
const WITH_TESTS = JSON.stringify({ scripts: { test: 'node --test' } })

test('a failing test blocks the push and names the test', async ($, on) => {
  on('fs.read', () => ({ value: WITH_TESTS }))
  on('process.run', () => ({ value: FAILING }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  const ran = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })

  expect(ran.deny).toContain('adds 15% VAT')
  expect(ran.deny).not.toContain('adds up the items')
})

test('passing tests let the push through', async ($, on) => {
  on('fs.read', () => ({ value: WITH_TESTS }))
  on('process.run', () => ({ value: PASSING }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { text: 'pushed' } }))

  const ran = await $.tool.call({ tool: 'Bash', command: 'git -C . push' })

  expect(ran.deny).toBeUndefined()
})

test('other commands, and the words in a string, do not run the tests', async ($, on) => {
  let runs = 0
  on('process.run', () => { runs++; return { value: FAILING } })
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await $.tool.call({ tool: 'Bash', command: "echo \"command: 'git push'\"" })

  expect(runs).toBe(0)
})

for (const [name, packageJson] of [
  ['no package.json', () => { throw new Error("ENOENT: no such file or directory, open 'package.json'") }],
  ['no test script', () => ({ value: JSON.stringify({ name: 'site' }) })],
  ['the test script npm init writes', () => ({ value: JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })],
] as const) {
  test(`${name} lets the push through without running npm test`, async ($, on) => {
    let runs = 0
    on('fs.read', packageJson)
    on('process.run', () => { runs++; return { value: FAILING } })
    on('tool.call', () => ({ result: { text: 'pushed' } }))

    const ran = await $.tool.call({ tool: 'Bash', command: 'git push' })

    expect(ran.deny).toBeUndefined()
    expect(runs).toBe(0)
  })
}

const BAND = { plugin: 'push-guard', component: 'AbovePrompt', props: { hasSurvey: false } } as const

for (const [name, run, want] of [
  ['the band counts failing tests', FAILING, 'push-guard: 1 test failing'],
  ['the band says all tests pass', PASSING, 'push-guard: all tests passing'],
] as const) {
  test(name, async ($, on) => {
    on('fs.read', () => ({ value: WITH_TESTS }))
    on('process.run', () => ({ value: run }))
    on('ui.status', () => ({ value: undefined }))
    on('tool.call', () => ({ result: {} }))
    await $.tool.call({ tool: 'Bash', command: 'git push' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect((await ui.find({ type: 'Text', text: /push-guard/ }))?.text).toBe(want)
      await ui.unmount()
    }
  })
}
