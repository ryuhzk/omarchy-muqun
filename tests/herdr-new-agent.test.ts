/**
 * Starting an agent on a herdr host, from nothing.
 *
 * herdr will only hand this plugin a pane that has an agent in it, so a new
 * terminal on a herdr host is a new agent: a place is made for it first --
 * beside the pane being looked at, in a new tab, or in a new workspace -- and
 * the agent is started there. What matters is which commands go over the
 * wire, in which order, and that what herdr answers is read rather than
 * guessed.
 */

import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { makeHerdrSource } from '../backend/adapters/herdr-source';
import { CommandResult, CommandRunner } from '../backend/application/ports';

/** A runner that answers from a script and remembers what it was asked. */
function scriptedRunner(answers: (argv: ReadonlyArray<string>) => string) {
  const asked: Array<ReadonlyArray<string>> = [];
  const unused = Effect.die(new Error('not part of this test'));
  const layer = Layer.succeed(CommandRunner, {
    run: (_alias, argv) =>
      Effect.sync(() => {
        asked.push(argv);
        const answer = answers(argv);
        if (answer.startsWith('!')) {
          return new CommandResult({ stdout: '', stderr: answer.slice(1), code: 1 });
        }
        return new CommandResult({ stdout: answer, stderr: '', code: 0 });
      }),
    session: () => unused,
    forward: () => unused,
    upload: () => unused,
  });
  return { asked, layer };
}

const created = {
  workspace: JSON.stringify({
    id: 'cli:workspace:create',
    result: { root_pane: { pane_id: 'w2:p1' }, tab: { tab_id: 'w2:t1' }, workspace: { workspace_id: 'w2' } },
  }),
  tab: JSON.stringify({
    id: 'cli:tab:create',
    result: { root_pane: { pane_id: 'w1:p9' }, tab: { tab_id: 'w1:t4' } },
  }),
  split: JSON.stringify({ id: 'cli:pane:split', result: { pane: { pane_id: 'w1:p8' } } }),
  started: JSON.stringify({ id: 'cli:agent:start', result: { type: 'agent_started' } }),
};

function answering(argv: ReadonlyArray<string>): string {
  const [, group, verb] = argv;
  if (group === 'workspace' && verb === 'create') return created.workspace;
  if (group === 'tab' && verb === 'create') return created.tab;
  if (group === 'pane' && verb === 'split') return created.split;
  if (group === 'agent' && verb === 'start') return created.started;
  return '!unexpected command';
}

async function start(
  runner: ReturnType<typeof scriptedRunner>,
  request: { kind: string; where: 'split' | 'tab' | 'workspace'; besidePane?: string }
) {
  return Effect.gen(function* () {
    const source = yield* makeHerdrSource;
    if (source.newAgent === undefined) throw new Error('herdr offers no newAgent');
    return yield* source.newAgent('mac', request);
  }).pipe(Effect.provide(runner.layer), Effect.runPromise);
}

describe('herdr new agent', () => {
  test('a new workspace is made without taking focus, and the agent starts in its root pane', async () => {
    const runner = scriptedRunner(answering);
    const paneId = await start(runner, { kind: 'codex', where: 'workspace' });
    expect(paneId).toBe('w2:p1');
    expect(runner.asked[0]).toEqual(['herdr', 'workspace', 'create', '--no-focus']);
    const started = runner.asked[1] ?? [];
    expect(started.slice(0, 3)).toEqual(['herdr', 'agent', 'start']);
    expect(started).toContain('--kind');
    expect(started[started.indexOf('--kind') + 1]).toBe('codex');
    expect(started[started.indexOf('--pane') + 1]).toBe('w2:p1');
  });

  test('a new tab goes into the workspace of the pane being looked at', async () => {
    const runner = scriptedRunner(answering);
    const paneId = await start(runner, { kind: 'claude', where: 'tab', besidePane: 'w1:p5' });
    expect(paneId).toBe('w1:p9');
    expect(runner.asked[0]).toEqual(['herdr', 'tab', 'create', '--workspace', 'w1', '--no-focus']);
  });

  test('a tab with nothing to sit beside goes wherever herdr puts it', async () => {
    const runner = scriptedRunner(answering);
    await start(runner, { kind: 'claude', where: 'tab' });
    expect(runner.asked[0]).toEqual(['herdr', 'tab', 'create', '--no-focus']);
  });

  test('beside means a split to the right of that pane', async () => {
    const runner = scriptedRunner(answering);
    const paneId = await start(runner, { kind: 'gemini', where: 'split', besidePane: 'w1:p5' });
    expect(paneId).toBe('w1:p8');
    expect(runner.asked[0]).toEqual([
      'herdr', 'pane', 'split', 'w1:p5', '--direction', 'right', '--no-focus',
    ]);
  });

  test('beside with nothing selected falls back to a new tab', async () => {
    const runner = scriptedRunner(answering);
    const paneId = await start(runner, { kind: 'gemini', where: 'split' });
    expect(paneId).toBe('w1:p9');
    expect(runner.asked[0]?.slice(0, 3)).toEqual(['herdr', 'tab', 'create']);
  });

  test('the agent gets a name herdr will accept, and a different one each time', async () => {
    const runner = scriptedRunner(answering);
    await start(runner, { kind: 'codex', where: 'workspace' });
    await start(runner, { kind: 'codex', where: 'workspace' });
    const first = runner.asked[1]?.[3] ?? '';
    const second = runner.asked[3]?.[3] ?? '';
    expect(first).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(second).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(first).not.toBe(second);
  });

  test('a kind that is not a plain word is refused before anything is made', async () => {
    const runner = scriptedRunner(answering);
    await expect(start(runner, { kind: '--evil', where: 'workspace' })).rejects.toThrow();
    expect(runner.asked.length).toBe(0);
  });

  test('an agent that is blocked while starting still counts as started', async () => {
    const runner = scriptedRunner((argv) =>
      argv[1] === 'agent' && argv[2] === 'start'
        ? '!{"error":{"code":"agent_not_ready","message":"waiting on approval"}}'
        : answering(argv)
    );
    const paneId = await start(runner, { kind: 'claude', where: 'workspace' });
    expect(paneId).toBe('w2:p1');
  });

  test('a place that could not be made is an error that names the command', async () => {
    const runner = scriptedRunner((argv) =>
      argv[1] === 'workspace' ? '!{"error":{"code":"nope","message":"no room"}}' : answering(argv)
    );
    await expect(start(runner, { kind: 'claude', where: 'workspace' })).rejects.toThrow(/no room/);
  });
});
