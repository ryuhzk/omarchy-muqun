/**
 * A host with two tools on it is asked both questions at once.
 *
 * herdr and tmux are two round trips over the same connection, and a round
 * trip to a machine on another continent is a few hundred milliseconds. Asked
 * one after the other, the list appears twice as late as it needs to; asked
 * together, it appears when the slower one answers.
 */

import { describe, expect, test } from 'bun:test';
import { Effect, Layer, Queue } from 'effect';
import { TestClock } from 'effect/testing';
import { HostRegistry } from '../backend/application/host-registry';
import {
  Clipboard,
  CommandRunner,
  Simulators,
  TerminalFactory,
  TerminalSources,
  type TerminalSourceApi,
} from '../backend/application/ports';
import type { Pane } from '../backend/domain/pane';

function shellPane(id: string, source: Pane['source']): Pane {
  return {
    id,
    source,
    title: id,
    cwd: '',
    focused: false,
    status: 'unknown',
    groupId: 'g',
    groupLabel: 'g',
  };
}

/** A source that takes a second to answer anything, and counts its answers. */
function slowSource(kind: Pane['source'], answered: { probes: number; lists: number }): TerminalSourceApi {
  const unused = Effect.die(new Error('not part of this test'));
  return {
    kind,
    available: () =>
      Effect.sleep('1 second').pipe(
        Effect.andThen(Effect.sync(() => {
          answered.probes += 1;
          return true;
        }))
      ),
    panes: () =>
      Effect.sleep('1 second').pipe(
        Effect.andThen(Effect.sync(() => {
          answered.lists += 1;
          return [shellPane(`${kind}-1`, kind)];
        }))
      ),
    read: () => unused,
    sendText: () => unused,
    sendKeys: () => unused,
    waitForAgents: () => Effect.never,
    attach: () => unused,
    splitPane: () => unused,
    closePane: () => unused,
  };
}

function registryWith(sources: ReadonlyArray<TerminalSourceApi>) {
  const unused = Effect.die(new Error('not part of this test'));
  const fakes = Layer.mergeAll(
    Layer.succeed(TerminalSources, { all: sources }),
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

const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

describe('host refresh', () => {
  test('both tools are probed at once, and both listed at once', async () => {
    const herdr = { probes: 0, lists: 0 };
    const tmux = { probes: 0, lists: 0 };

    await Effect.gen(function* () {
      const registry = yield* HostRegistry;
      yield* registry.setHosts([{ alias: 'mac' }]);
      yield* settle;

      // One second is long enough for both probes together and only one apart.
      yield* TestClock.adjust('1 second');
      yield* settle;
      expect(herdr.probes).toBe(1);
      expect(tmux.probes).toBe(1);

      // And the same for the listing that follows.
      yield* TestClock.adjust('1 second');
      yield* settle;
      expect(herdr.lists).toBe(1);
      expect(tmux.lists).toBe(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(registryWith([slowSource('herdr', herdr), slowSource('tmux', tmux)])),
      Effect.runPromise
    );
  });

  test('panes are listed in the order the sources are offered', async () => {
    const herdr = { probes: 0, lists: 0 };
    const tmux = { probes: 0, lists: 0 };
    const seen: Array<ReadonlyArray<string>> = [];

    await Effect.gen(function* () {
      const registry = yield* HostRegistry;
      yield* registry.setHosts([{ alias: 'mac' }]);
      yield* settle;
      yield* TestClock.adjust('2 seconds');
      yield* settle;
      // Drain what the panel would have been told.
      const told = yield* Queue.clear(registry.changes);
      for (const next of told) {
        if (next.type === 'hosts') seen.push(next.hosts[0]?.panes.map((pane) => pane.id) ?? []);
      }
      expect(seen[seen.length - 1]).toEqual(['herdr-1', 'tmux-1']);
    }).pipe(
      Effect.scoped,
      Effect.provide(registryWith([slowSource('herdr', herdr), slowSource('tmux', tmux)])),
      Effect.runPromise
    );
  });
});
