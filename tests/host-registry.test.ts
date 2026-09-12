/**
 * The host supervisor, against fake sources and a clock that only moves when
 * told to.
 *
 * The thing under test is how often a host is asked what it has. The badge is
 * supposed to be driven by a watch that blocks until something changes; a
 * watch that comes back at once must not turn the supervisor into a loop that
 * hammers the machine on the far side.
 */

import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { HostRegistry } from '../backend/application/host-registry';
import {
  Clipboard,
  CommandRunner,
  Simulators,
  TerminalFactory,
  TerminalSources,
  type AgentWatch,
  type TerminalSourceApi,
} from '../backend/application/ports';
import type { Pane } from '../backend/domain/pane';

function agentPane(id: string, status: Pane['status']): Pane {
  return {
    id,
    source: 'herdr',
    title: id,
    cwd: '',
    focused: false,
    status,
    agent: 'codex',
    groupId: 'w1:t1',
    groupLabel: 'tab 1',
  };
}

interface Recorded {
  panes: number;
  waits: Array<ReadonlyArray<AgentWatch>>;
}

/** A source that answers from memory and records what it was asked. */
function fakeSource(
  recorded: Recorded,
  panes: () => ReadonlyArray<Pane>,
  wait: (turn: number) => Effect.Effect<string>
): TerminalSourceApi {
  const unused = Effect.die(new Error('not part of this test'));
  return {
    kind: 'herdr',
    available: () => Effect.succeed(true),
    panes: () =>
      Effect.sync(() => {
        recorded.panes += 1;
        return panes();
      }),
    read: () => unused,
    sendText: () => unused,
    sendKeys: () => unused,
    waitForAgents: (_alias, agents) =>
      Effect.suspend(() => {
        recorded.waits.push(agents);
        return wait(recorded.waits.length);
      }),
    attach: () => unused,
    splitPane: () => unused,
    closePane: () => unused,
  };
}

function registryWith(source: TerminalSourceApi) {
  const unused = Effect.die(new Error('not part of this test'));
  const fakes = Layer.mergeAll(
    Layer.succeed(TerminalSources, { all: [source] }),
    Layer.succeed(Clipboard, { read: () => Effect.succeed({ kind: 'empty' as const }) }),
    Layer.succeed(CommandRunner, {
      run: () => unused,
      session: () => unused,
      forward: () => unused,
      upload: () => unused,
    }),
    Layer.succeed(Simulators, {
      open: () => Effect.void,
      status: () => Effect.succeed(null),
      watch: () => unused,
    }),
    Layer.succeed(TerminalFactory, {
      create: () => {
        throw new Error('not part of this test');
      },
    })
  );
  return HostRegistry.layer.pipe(Layer.provideMerge(fakes), Layer.provideMerge(TestClock.layer()));
}

/** Let forked fibers get to their next sleep before the clock is moved. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

describe('host registry', () => {
  test('a watch that comes back at once does not become a loop', async () => {
    const recorded: Recorded = { panes: 0, waits: [] };
    // The watch answers instantly fifty times, then holds. Fifty is more than
    // any bound the registry should allow in ten seconds and few enough that a
    // registry with no bound at all still lets the test finish.
    const source = fakeSource(
      recorded,
      () => [agentPane('w1:p5', 'done')],
      (turn) => (turn > 50 ? Effect.never : Effect.succeed('w1:p5'))
    );

    await Effect.gen(function* () {
      const registry = yield* HostRegistry;
      yield* registry.setHosts([{ alias: 'mac' }]);
      yield* settle;
      yield* TestClock.adjust('10 seconds');
      yield* settle;
      expect(recorded.waits.length).toBeLessThan(10);
      expect(recorded.panes).toBeLessThan(12);
    }).pipe(Effect.scoped, Effect.provide(registryWith(source)), Effect.runPromise);
  });

  test('the watch is armed with each agent and the state it is in', async () => {
    const recorded: Recorded = { panes: 0, waits: [] };
    const source = fakeSource(
      recorded,
      () => [agentPane('w1:p5', 'done'), agentPane('w1:pA', 'working')],
      () => Effect.never
    );

    await Effect.gen(function* () {
      const registry = yield* HostRegistry;
      yield* registry.setHosts([{ alias: 'mac' }]);
      yield* settle;
      expect(recorded.waits.length).toBe(1);
      expect([...(recorded.waits[0] ?? [])]).toEqual([
        { id: 'w1:p5', status: 'done' },
        { id: 'w1:pA', status: 'working' },
      ]);
    }).pipe(Effect.scoped, Effect.provide(registryWith(source)), Effect.runPromise);
  });

  test('a watch that fires after a while re-reads the host and re-arms', async () => {
    const recorded: Recorded = { panes: 0, waits: [] };
    let status: Pane['status'] = 'working';
    const source = fakeSource(
      recorded,
      () => [agentPane('w1:p5', status)],
      (turn) =>
        turn === 1
          ? Effect.sleep('30 seconds').pipe(Effect.as('w1:p5'))
          : Effect.never
    );

    await Effect.gen(function* () {
      const registry = yield* HostRegistry;
      yield* registry.setHosts([{ alias: 'mac' }]);
      yield* settle;
      expect(recorded.panes).toBe(1);
      status = 'blocked';
      yield* TestClock.adjust('31 seconds');
      yield* settle;
      expect(recorded.panes).toBe(2);
      expect(recorded.waits.length).toBe(2);
      expect(recorded.waits[1]?.[0]?.status).toBe('blocked');
    }).pipe(Effect.scoped, Effect.provide(registryWith(source)), Effect.runPromise);
  });

  test('the idle timer re-reads a host whose watch never fires', async () => {
    const recorded: Recorded = { panes: 0, waits: [] };
    const source = fakeSource(
      recorded,
      () => [agentPane('w1:p5', 'working')],
      () => Effect.never
    );

    await Effect.gen(function* () {
      const registry = yield* HostRegistry;
      yield* registry.setHosts([{ alias: 'mac' }]);
      yield* settle;
      yield* TestClock.adjust('61 seconds');
      yield* settle;
      expect(recorded.panes).toBe(2);
      // Same agents in the same states: the watch is left up, not remade.
      expect(recorded.waits.length).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(registryWith(source)), Effect.runPromise);
  });
});
