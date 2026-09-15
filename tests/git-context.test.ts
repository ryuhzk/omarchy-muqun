/**
 * What goes over the wire to learn where a pane's work lives.
 *
 * One command, on the machine the pane is on, with the directory handed in as
 * an argument rather than pasted into the script. What comes back is read by
 * the domain; what this checks is that the right question is asked and that
 * "not a repository" and "could not ask" both come back as nothing.
 */

import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { CONTEXT_SCRIPT, GitContextLayer } from '../backend/adapters/git-context';
import { CommandResult, CommandRunner, RepoInspector } from '../backend/application/ports';

function runnerAnswering(code: number, stdout: string) {
  const asked: Array<ReadonlyArray<string>> = [];
  const unused = Effect.die(new Error('not part of this test'));
  const layer = Layer.succeed(CommandRunner, {
    run: (_alias, argv) =>
      Effect.sync(() => {
        asked.push(argv);
        return new CommandResult({ stdout, stderr: '', code });
      }),
    session: () => unused,
    forward: () => unused,
    upload: () => unused,
  });
  return { asked, layer };
}

async function inspect(runner: ReturnType<typeof runnerAnswering>, cwd: string) {
  return Effect.gen(function* () {
    const inspector = yield* RepoInspector;
    return yield* inspector.inspect('mac', cwd);
  }).pipe(
    Effect.provide(GitContextLayer.pipe(Layer.provide(runner.layer))),
    Effect.runPromise
  );
}

describe('git context', () => {
  test('the directory is an argument to the script, not part of it', async () => {
    const runner = runnerAnswering(0, 'root\t/r\nremote\tgit@github.com:a/b.git\nbranch\tmain\n');
    const context = await inspect(runner, "/Users/me/it's here");
    expect(runner.asked[0]).toEqual(['sh', '-c', CONTEXT_SCRIPT, 'sh', "/Users/me/it's here"]);
    expect(context?.remote).toEqual({ owner: 'a', name: 'b' });
  });

  test('the script reads, and never writes', () => {
    expect(CONTEXT_SCRIPT).toContain('git rev-parse --show-toplevel');
    expect(CONTEXT_SCRIPT).toContain('git remote get-url origin');
    expect(CONTEXT_SCRIPT).toContain('gh pr view');
    expect(CONTEXT_SCRIPT).not.toMatch(/git (commit|push|checkout|reset|add)\b/);
    expect(CONTEXT_SCRIPT).not.toMatch(/gh (pr|issue) (create|close|merge|comment)/);
  });

  test('not a repository is nothing', async () => {
    const runner = runnerAnswering(3, '');
    expect(await inspect(runner, '/tmp')).toBeNull();
  });

  test('a directory that could not be asked is nothing', async () => {
    const runner = runnerAnswering(1, '');
    expect(await inspect(runner, '/gone')).toBeNull();
  });

  test('an empty directory is not asked at all', async () => {
    const runner = runnerAnswering(0, '');
    expect(await inspect(runner, '')).toBeNull();
    expect(runner.asked).toEqual([]);
  });
});
