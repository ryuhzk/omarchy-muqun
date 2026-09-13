/**
 * A pane id is a pane id, or it is not used.
 *
 * Every herdr command takes the pane as a bare argument, and a "pane id"
 * beginning with a dash would be read as an option: `--takeover` where a
 * target was expected. Ids come from the machine's own snapshot and come back
 * from the panel, so an ordinary run never sees a bad one; but a snapshot is
 * something another machine wrote, and the boundary is where its shape is
 * checked. herdr's public ids are `w1:p5` or `w1:pA`, and nothing else is
 * passed on.
 */

import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { makeHerdrSource, panesFromSnapshot, watchScript } from '../backend/adapters/herdr-source';
import { CommandResult, CommandRunner } from '../backend/application/ports';

function recordingRunner() {
  const asked: Array<ReadonlyArray<string>> = [];
  const unused = Effect.die(new Error('not part of this test'));
  const layer = Layer.succeed(CommandRunner, {
    run: (_alias, argv) =>
      Effect.sync(() => {
        asked.push(argv);
        return new CommandResult({ stdout: '{"result":{}}', stderr: '', code: 0 });
      }),
    session: (_alias, argv) =>
      Effect.sync(() => {
        asked.push(argv);
        throw new Error('a session was opened');
      }),
    forward: () => unused,
    upload: () => unused,
  });
  return { asked, layer };
}

const BAD_IDS = ['--takeover', '-x', 'w1:p5 --takeover', '', 'w1', '$(id)'];

describe('herdr pane ids', () => {
  test('a command is refused, and nothing runs, for an id that is not one', async () => {
    for (const bad of BAD_IDS) {
      const runner = recordingRunner();
      const attempts = await Effect.gen(function* () {
        const source = yield* makeHerdrSource;
        const tries = [
          source.read('mac', bad, 10),
          source.sendText('mac', bad, 'hello'),
          source.sendKeys('mac', bad, ['Enter']),
          source.closePane('mac', bad),
          source.splitPane('mac', bad, 'right'),
          Effect.scoped(source.attach('mac', bad, { rows: 24, columns: 80 })),
        ];
        const outcomes: Array<boolean> = [];
        for (const attempt of tries) {
          const failed = yield* attempt.pipe(
            Effect.as(false),
            Effect.catch(() => Effect.succeed(true))
          );
          outcomes.push(failed);
        }
        return outcomes;
      }).pipe(Effect.provide(runner.layer), Effect.runPromise);

      expect(attempts.every(Boolean)).toBe(true);
      expect(runner.asked).toEqual([]);
    }
  });

  test('a good id goes through as it is', async () => {
    const runner = recordingRunner();
    await Effect.gen(function* () {
      const source = yield* makeHerdrSource;
      yield* source.closePane('mac', 'w12:p34');
    }).pipe(Effect.provide(runner.layer), Effect.runPromise);
    expect(runner.asked[0]).toEqual(['herdr', 'pane', 'close', 'w12:p34']);
  });

  test('the pane to be beside is held to the same shape', async () => {
    const runner = recordingRunner();
    const failed = await Effect.gen(function* () {
      const source = yield* makeHerdrSource;
      if (source.newAgent === undefined) throw new Error('no newAgent');
      return yield* source
        .newAgent('mac', { kind: 'codex', where: 'split', besidePane: '--takeover' })
        .pipe(Effect.as(false), Effect.catch(() => Effect.succeed(true)));
    }).pipe(Effect.provide(runner.layer), Effect.runPromise);
    expect(failed).toBe(true);
    expect(runner.asked).toEqual([]);
  });

  test('a snapshot with a malformed id does not put that pane in the list', () => {
    const panes = panesFromSnapshot({
      panes: [
        { pane_id: 'w1:p5', tab_id: 'w1:t1', agent: 'codex' },
        { pane_id: '--takeover', tab_id: 'w1:t1', agent: 'claude' },
      ],
      tabs: [],
    });
    expect(panes.map((pane) => pane.id)).toEqual(['w1:p5']);
  });

  test('the watch skips an id that is not one rather than passing it to the shell', () => {
    const script = watchScript([
      { id: 'w1:p5', status: 'working' },
      { id: '--takeover', status: 'working' },
    ]);
    expect(script).toContain("'w1:p5'");
    expect(script).not.toContain('--takeover');
  });
});
