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

const SESSION = '/work/shop'

for (const [command, folder] of [
  ['git -C sub push', `${SESSION}/sub`],
  ['git -C /abs/path push origin main', '/abs/path'],
  ['git -C "dir with space" push', `${SESSION}/dir with space`],
  ["git -C 'dir with space' push", `${SESSION}/dir with space`],
  ['git -C sub -C inner push', `${SESSION}/sub/inner`],
  ['git -C sub -C /abs/path push', '/abs/path'],
  ['cd sub && git push', `${SESSION}/sub`],
  ['cd sub; git push', `${SESSION}/sub`],
  ['npm run build; cd "dir with space" && git -C inner push', `${SESSION}/dir with space/inner`],
] as const) {
  test(`${command} reads package.json and runs npm test in ${folder}`, async ($, on) => {
    const reads: string[] = []
    const cwds: unknown[] = []
    on('session.cwd', () => ({ value: SESSION }))
    on('fs.read', (_, e) => { reads.push(e.path); return { value: WITH_TESTS } })
    on('process.run', (_, e) => { cwds.push(e.init?.cwd); return { value: PASSING } })
    on('ui.status', () => ({ value: undefined }))
    on('tool.call', () => ({ result: { text: 'pushed' } }))

    const ran = await $.tool.call({ tool: 'Bash', command })

    expect(ran.deny).toBeUndefined()
    expect(reads).toEqual([`${folder}/package.json`])
    expect(cwds).toEqual([folder])
  })
}

for (const command of ['git push', 'git -C . push', 'cd $PROJECT && git push', 'git -C ~/shop push']) {
  test(`${command} reads package.json and runs npm test in the session's folder`, async ($, on) => {
    const reads: string[] = []
    const cwds: unknown[] = []
    on('fs.read', (_, e) => { reads.push(e.path); return { value: WITH_TESTS } })
    on('process.run', (_, e) => { cwds.push(e.init?.cwd); return { value: PASSING } })
    on('ui.status', () => ({ value: undefined }))
    on('tool.call', () => ({ result: { text: 'pushed' } }))

    await $.tool.call({ tool: 'Bash', command })

    expect(reads.length).toBe(1)
    expect(reads[0].endsWith('/package.json')).toBe(true)
    expect(reads[0]).not.toContain(SESSION)
    expect(cwds).toEqual([undefined])
  })
}

const BAND ={ plugin: 'push-guard', component: 'AbovePrompt', props: { hasSurvey: false } } as const

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
