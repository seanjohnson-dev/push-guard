# End-to-end demo: push-guard 0.5.0 with and without Baseline

Real headless Claude Code sessions (`claude -p`, Claude Code 2.1.300) with push-guard loaded from this
folder (`--plugin-dir`). Each session was asked to run `git push` once, against a local bare remote, and
say what happened. Raw stream-json transcripts, debug logs and the scripts are kept outside the repo
(`/workspace/stage2/pg/`: `setup.sh`, `e2e.sh`, `show.py`, `<scenario>-<with|without>.{jsonl,debug.log,summary}`).

## The project

`/tmp/pg-e2e/shop`, an npm project with `"test": "vitest run"` (vitest 3, `node_modules` copied from a
working fixture), pushed to `/tmp/pg-e2e/remote.git`. On the remote (the base commit) already:

- `test/cart.test.js`: 2 passing tests (`adds up the items`, `adds 15% VAT`);
- `test/legacy.test.js > rounds cash to the nearest 5 cents`: **fails** (a real bug in `roundCash`);
- `test/flaky.test.js > payment gateway answers in time`: **flaky**, failing on the 1st, 3rd, ... run in
  a folder and passing on the 2nd, 4th, ... (a counter file, so the demo repeats).

Scenarios, each set up fresh (`setup.sh`):

- **(a)** one unpushed commit, `cart: discount()`, breaks nothing;
- **(b)** (a) plus `cart: VAT from a rate table`, which makes `adds 15% VAT` fail (11000, not 11500);
- **(c)** a separate all-green project (`/tmp/pg-e2e/green`, no legacy or flaky test) with one unpushed commit;
- **(g)** (a), but with the test script `vitest run && echo done`, which Baseline can only judge as a whole command.

"With Baseline": `/workspace/baseline/bin` on `PATH` (no `BASELINE_BIN`). "Without": that folder taken
off `PATH`, nothing else changed. Other installed plugins that act on `git push` were disabled for the
child sessions (`--settings '{"enabledPlugins":{"review-layers@review-layers":false}}'`).

```
claude -p "Push this branch to its remote: run exactly \`git push\` with the Bash tool, once. Do not change
any files, do not retry, and do not run the tests yourself. Then tell me in a few lines what happened and
why, including what push-guard said." --plugin-dir /workspace/push-guard-baseline \
  --settings '{"enabledPlugins":{"review-layers@review-layers":false}}' --allowedTools Bash \
  --output-format stream-json --verbose --debug-file <log>
```

## Results

| | Without Baseline (0.4.0 behaviour) | With Baseline |
|---|---|---|
| (a) pre-existing + flaky red, nothing new | **blocked** (2 failing) | **pushed**, toast lists 1 pre-existing + 1 flaky; Claude told why |
| (b) (a) + a newly broken test | **blocked** (3 failing, all listed alike) | **blocked**, only the NEW test listed with evidence, the other 2 counted |
| (c) all green | pushed | pushed (Baseline ran, exit 0, nothing said) |
| (g) script Baseline can't read per test | — | **blocked** as before, plus `did not use Baseline: ... (runner: "generic")` |

"Pushed" means the bare remote's `main` moved to the session's `HEAD` (checked with `git rev-parse` after
each session); "blocked" means it did not move.

Time push-guard's hook took (debug log, `tool.call settled in`): (a) 8.5 s with Baseline vs 1.5 s
without; (b) 8.5 s vs 1.3 s; (c) 1.7 s vs 1.5 s; (g) 4.6 s (Baseline 3.6 s, then npm test 1.0 s).

## (a) With Baseline: pushed, with what is still red

Remote `76a4782` -> `cae1cea`. The `git push` result Claude saw:

```
To /tmp/pg-e2e/remote.git
   76a4782..cae1cea  main -> main
```

The toast (from the debug log; a `-p` session draws none):

```
push-guard: pushed with 2 tests still red, none from this push: 1 pre-existing (already failing on 76a4782), 1 flaky
"test/legacy.test.js > rounds cash to the nearest 5 cents": pre-existing
"test/flaky.test.js > payment gateway answers in time": flaky
```

Claude's answer (it got push-guard's note through the result's `context`, which is not printed in the
transcript itself):

> The push worked: `main` went from `76a4782` to `cae1cea` on `/tmp/pg-e2e/remote.git`. [...]
> push-guard let it through, but it reported two tests still failing. It says neither failure comes from this push. [...]
> - **`test/legacy.test.js > rounds cash to the nearest 5 cents`**: this was already broken before your change. It failed on the base commit in all 7 runs and on your commit in all 5.
> - **`test/flaky.test.js > payment gateway answers in time`**: this one is flaky. On your commit it failed once and passed once, with the same code. [...]

## (a) Without Baseline: blocked

```
push-guard: npm test failed (exit 1), so the push was blocked.

Failed tests:
 ❯ test/flaky.test.js (1 test | 1 failed) 17ms
 ❯ test/legacy.test.js (1 test | 1 failed) 19ms
 Test Files  2 failed | 1 passed (3)
      Tests  2 failed | 2 passed (4)
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  test/flaky.test.js > payment gateway answers in time
 FAIL  test/legacy.test.js > rounds cash to the nearest 5 cents
```

## (b) With Baseline: blocked, only the NEW failure listed

Remote stayed at `e1870ef`. The deny Claude got:

```
push-guard: npm test fails, and 1 failure is new with this push (not failing on e1870ef, the commit it builds on), so it was blocked. Baseline ran each failing test on both commits.

New failures:
- "test/cart.test.js > adds 15% VAT": passed 8/8 runs on e1870ef, fails 5/5 runs on HEAD: "AssertionError: expected 11000 to be 11500 // Object.is equality"

Also still failing, not because of this push: 1 pre-existing (already failing on e1870ef), 1 flaky. Those do not block the push.

Fix these, then push again. They come from this push: do not call them pre-existing or flaky.
```

> The push was blocked. Nothing reached the remote. [...] It stopped the push because one test failure is new:
> `test/cart.test.js > adds 15% VAT` passed 8/8 runs on `e1870ef` and failed 5/5 runs on HEAD [...]
> push-guard also reported one other failing test that already failed on `e1870ef`, and one flaky test. It said neither of those blocks the push.

## (b) Without Baseline: blocked, every failure alike

```
push-guard: npm test failed (exit 1), so the push was blocked.

Failed tests:
 ❯ test/legacy.test.js (1 test | 1 failed) 7ms
 ❯ test/cart.test.js (2 tests | 1 failed) 7ms
 ❯ test/flaky.test.js (1 test | 1 failed) 8ms
 Test Files  3 failed (3)
      Tests  3 failed | 1 passed (4)
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  test/cart.test.js > adds 15% VAT
 FAIL  test/flaky.test.js > payment gateway answers in time
 FAIL  test/legacy.test.js > rounds cash to the nearest 5 cents
```

## (c) All green: unchanged

With Baseline (`5332a0b..e722efc`) and without (`c57ff62..203e404`) the push went through with only git's
own output. With Baseline the debug log shows `baseline version` (51 ms), `baseline check` exit 0 in
1.4 s, then the test-changes check's three `git` calls; no toast.

## (g) Baseline can't read the tests per test: original behaviour plus a note

Baseline resolved `npm test` to a generic whole-command runner and exited 0 (the command failed the same
way on the base commit). push-guard does not take a whole-command answer, so it ran `npm test` and blocked:

```
push-guard: npm test failed (exit 1), so the push was blocked.

Failed tests:
 [... the same two failures as in (a) without Baseline ...]

(push-guard did not use Baseline: Baseline can't tell this project's tests apart (runner: "generic").)
```

## Projects without a test script

Same setup (Claude Code 2.1.300, push-guard from this folder, `review-layers` disabled, a local bare remote
per project). The prompt said "do not run any checks yourself" instead of "the tests". The scripts lived
in `/tmp/pg-checks/kit/` (`setup.sh`, `e2e.sh`, `show.py`, outside the repo and throwaway).

Each project is a small npm project with **no `test` script**:

```json
"scripts": { "typecheck": "tsc --noEmit", "lint": "eslint -f stylish src" }
```

`tsc` and `eslint` are tiny node stand-ins in `node_modules/.bin/`. The `tsc` stand-in prints
`src/a.ts(2,27): error TS2322: Type '"BADnew"' is not assignable to type 'number'.` for each line of
`src/*.ts` holding `BAD<word>` and exits 1. The `eslint` stand-in prints stylish output for `LINT<word>`.
They are installed under those names so that Baseline recognises the scripts as `tsc` and eslint and
reads them error by error. A plain `node check.js` script would be a whole command to Baseline, so
push-guard would fall back to running it.

| | Base commit (on the remote) | Pushed commit | Result |
|---|---|---|---|
| (i) with Baseline | `src/a.ts` clean | adds `'BADnew'` | **blocked**: 1 new type error, with the error |
| (i) without Baseline | same | same | **blocked**: `npm run typecheck failed (exit 1)` and its output |
| (ii) with Baseline | `'BADold'` already there | keeps it, adds a clean line | **pushed**, toast + note: 1 pre-existing |
| (iii) with Baseline | clean | clean change | **pushed**, nothing said |
| (iv) with Baseline | `"scripts": {}` | adds `'BADnew'` | **pushed loudly**: "nothing was checked" |

Pushed or blocked was checked on the bare remote's `main` after each session. Hook time from the debug
log: (i) 0.5 to 0.7 s (two Baseline runs, or two `npm run`s), (ii) 1.0 s, (iii) 0.6 s, (iv) 0.1 s.

### (i) With Baseline: blocked, only the new error

The first run used a deny that listed the checks that ran but not how each came out. Claude then
guessed that lint "probably never ran", although it had passed. The deny now names each check's result.
The rerun (remote stayed at `13f8fc3`) gave:

```
push-guard: npm run typecheck failed, so the push was blocked. This project has no `test` script, so push-guard ran its checks instead: npm run typecheck failed, npm run lint passed.

npm run typecheck: 1 error is new with this push (not reported on 13f8fc3, the commit it builds on; Baseline ran the check on both commits):
- "src/a.ts: TS2322 Type '\"BADnew\"' is not assignable to type 'number'."

Fix these, then push again. The new errors come from this push: do not call them pre-existing.
```

> I ran `git push` once and push-guard blocked it, so nothing was pushed. [...] `npm run lint` passed
> and `npm run typecheck` failed with one error [...] It also ran the same check on `13f8fc3` (the base
> commit) and that commit didn't have this error. So the error is new in this push.

### (i) Without Baseline: blocked, with the output

```
push-guard: npm run typecheck failed, so the push was blocked. This project has no `test` script, so push-guard ran its checks instead (npm run typecheck, npm run lint).

npm run typecheck failed (exit 1):
> newerr-nb@1.0.0 typecheck
> tsc --noEmit
src/a.ts(2,27): error TS2322: Type '"BADnew"' is not assignable to type 'number'.
Found 1 error.

Fix these, then push again.
```

(That is the wording before the fix above. It now reads `... instead: npm run typecheck failed, npm run lint passed.`)

### (ii) With Baseline: the type error was already there, so the push went ahead

Remote `5687c2f` -> `871b413`. The toast:

```
push-guard: pushed with 1 check error still reported, none from this push: 1 pre-existing (already reported on 5687c2f)
"src/a.ts: TS2322 Type '\"BADold\"' is not assignable to type 'number'.": pre-existing
```

> The push worked [...] push-guard let it through. It compared this push with the commit it builds on
> (`5687c2f`) and found one check error, which it says was already there before your change [...]
> So the push is in, but `src/a.ts` still has that type error to fix.

### (iii) With Baseline: clean

Remote `cd6998b` -> `8df517f`. Two `baseline check` runs (typecheck, lint), both exit 0, accepted as clean
checks without running the scripts again. No toast, as for green tests.

### (iv) No scripts at all: pushed, but not quietly

Remote `c3e0430` -> `289b12c` (the pushed commit holds a type error nobody checked). The toast was
`push-guard: nothing was checked: this project has no test, typecheck or lint script`, and Claude passed
on the note:

> Push-guard let the push go ahead without checking anything. It said `package.json` has no `test`
> script and none of the scripts it falls back to: `typecheck`, `type-check`, `tsc`, `lint`, `check` or
> `format:check`. So no tests, type check or lint ran on this commit.

## Never hanging, and the whole project's tests (28 Oct 2026)

Same setup as above (`claude -p`, Claude Code 2.1.300, `--model opus --effort high`, push-guard from this
folder, other `git push` plugins off), **with `CI` unset**, as in a normal session. Small throwaway npm
projects in `/tmp/pgl/<name>` (Node 24, `node:test`), each with a local bare remote and one unpushed
commit; the scripts (`setup.sh`, `e2e.sh`, `show.py`), transcripts and debug logs stay in `/tmp/pgl`.
The prompt is the one above, with `git push`.

| | Project | Options | Result | Hook time |
|---|---|---|---|---|
| (i) | `hang`: `test` = a script that watches forever unless `CI=true` (like Create React App); `test:api` = a script that never ends | `timeoutMinutes: 1`, Baseline on `PATH` | **blocked**: `npm test` passed (it got `CI=true`), `test:api` did not finish | 45.7 s |
| (i') | same | `timeoutMinutes: 1`, `baseline: off` | **blocked** the same way, by Claude Code's own run timeout | 60.2 s |
| (ii) | `apionly`: `test` (web) green, `test:api` broken by the push (an HTML-escaping helper writes `&#34;`), plus a `test:e2e` | Baseline on `PATH` | **blocked**, only the NEW api test listed | 2.8 s |
| (iii) | `nested`: root `test` green, `api/package.json` with its own `test` | Baseline on `PATH` | **pushed**, with a loud "NOT run" note | 1.0 s |
| (iv) | `green`: `test` and `test:api` both green | Baseline on `PATH` | **pushed**, nothing said | 1.1 s |

Before this change, (i) would have waited 10 minutes for Baseline and then 10 more for `npm test` (the
watch script never exits), and (ii) would have pushed, because `npm test` doesn't run the api tests.

**(i)** what Claude got (the deny):

```
push-guard: npm run test:api did not finish, so the push was blocked. push-guard ran: npm test passed, npm run test:api did not finish.

npm run test:api (run by Baseline) did not finish within 1 minute (watch mode? a hung test?), so the push was blocked. Run it yourself to see why, or raise the `timeoutMinutes` option.

Fix these, then push again.
```

Baseline ran `npm test` (a whole command it can't read per test) and said it passed on `HEAD`; push-guard
took that as a pass and did not run it again. Baseline got `--timeout 45`, stopped `test:api` itself, and
exited 2 with "the test command timed out on head"; push-guard blocked without a second wait. In (i')
(no Baseline) the same deny came from Claude Code stopping `npm run test:api` at 60 s; the line reads
`npm run test:api did not finish within 1 minute (watch mode? a hung test?). Run it yourself ...`. That
deny is the multi-script form from before a wording fix; the current code says "so the push was blocked"
once, in the first line (unit tests check it).

**(ii)** the deny:

```
push-guard: npm run test:api failed, so the push was blocked. push-guard ran: npm test passed, npm run test:api failed.

npm run test:api: 1 failure is new with this push (not failing on ab68d90, the commit it builds on; Baseline ran each failing test on both commits):
- "escapes quotes": passed 10/10 runs on ab68d90, fails 5/5 runs on HEAD: "Expected values to be strictly equal:"

Fix these, then push again. The new failures come from this push: do not call them pre-existing.
```

`test:e2e` was not run (its name says end-to-end).

**(iii)** the push went ahead; the toast (debug log) and the note Claude got and repeated:

```
push-guard ran npm test; these test scripts were NOT run: api (api/package.json: test)
```

Claude's answer: "push-guard only ran the root `npm test`. It did not run the separate test script in the
`api` package (`api/package.json`), so the `api` code in this push hasn't been tested."

**(iv)** pushed; Claude: "push-guard said nothing." (Baseline ran both scripts, exit 0.)

### A real Create React App project (not a live session)

A private Create React App + serverless project: `test` = `react-scripts test` (watch mode without
`CI=true`, web suite only), `test:api` = the api jest suite, `test:all` = both plus two safety scripts.
Earlier, a push that broke only an api helper went through silently, and without `CI` the push waited
about 20 minutes. push-guard now picks `npm run test:all` there. Run as push-guard runs it, in a scratch
clone with `CI` unset in the shell (`CI=true` added, stdin closed), on the api-only break: it finished in
22 s with exit 1 (web 2,333 tests green; api `1 failed, 679 passed`), so the push would be blocked. The
sixth live session meant for this project was lost to a bug in my run script: it started in a folder with
no repository, so there is no live transcript for it.
