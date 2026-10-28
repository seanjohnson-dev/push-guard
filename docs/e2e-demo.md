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
