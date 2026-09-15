/**
 * Attaching when the list and the machine disagree for a moment.
 *
 * The list is a snapshot; the pane is real. A pane that was made a moment ago
 * may not be in the snapshot yet, and a pane that is being looked at does not
 * stop existing because one refresh did not mention it. Attaching routes by
 * the tool that owns the pane, and that is known without the list in both
 * cases: the tool that just made it, or the tool that opened it last time.
 */

import { describe, expect, test } from 'bun:test';
import { Effect, Layer, Queue, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { HostRegistry } from '../backend/application/host-registry';
import {
  Clipboard,
  CommandRunner,
  RepoInspector,
  Simulators,
  TerminalFactory,
  TerminalSources,
  type Terminal,
  type TerminalSourceApi,
} from '../backend/application/ports';
import type { Pane } from '../backend/domain/pane';

function pane(id: string, source: Pane['source'], agent?: string): Pane {
  return {
    id,
    source,
    title: id,
    cwd: '',
    focused: false,
    status: agent ? 'working' : 'unknown',
    ...(agent ? { agent } : {}),
    groupId: 'g',
    groupLabel: 'g',
  };
}

/** A terminal that remembers nothing and draws nothing. */
function blankTerminal(): Terminal {
  return {
    write() {},
    rows: () => [],
    cursor: () => ({ row: 0, column: 0, visible: true }),
    resize() {},
    reset() {},
    scrollBy() {},
    scrollToBottom() {},
    atBottom: true,
    historyLength: 0,
    mouseTracking: false,
    mouseSgr: false,
    bracketedPaste: false,
    size: { rows: 24, columns: 80 },
  };
}

interface Recorded {
  attached: Array<string>;
  listings: number;
}

function fakeSource(
  kind: Pane['source'],
  recorded: Recorded,
  panes: () => Effect.Effect<ReadonlyArray<Pane>, Error>,
  extras: Partial<TerminalSourceApi> = {}
): TerminalSourceApi {
  const unused = Effect.die(new Error('not part of this test'));
  return {
    kind,
    available: () => Effect.succeed(true),
    panes: () =>
      Effect.suspend(() => {
        recorded.listings += 1;
        return panes();
      }).pipe(Effect.mapError((error) => error as never)),
    read: () => unused,
    sendText: () => Effect.void,
    sendKeys: () => unused,
    waitForAgents: () => Effect.never,
    attach: (_alias, paneId) =>
      Effect.sync(() => {
        recorded.attached.push(`${kind}:${paneId}`);
        return { output: Stream.never, write: () => Effect.void, complaint: () => '' };
      }),
    splitPane: () => unused,
    closePane: () => unused,
    ...extras,
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
    Layer.succeed(RepoInspector, { inspect: () => Effect.succeed(null) }),
    Layer.succeed(Simulators, {
      open: () => Effect.void,
      status: () => Effect.succeed(null),
      watch: () => unused,
    }),
    Layer.succeed(TerminalFactory, { create: () => blankTerminal() })
  );
  return HostRegistry.layer.pipe(Layer.provideMerge(fakes), Layer.provideMerge(TestClock.layer()));
}

const settle = Effect.gen(function* () {
  for (let i = 0; i < 30; i++) yield* Effect.yieldNow;
});

const size = { rows: 24, columns: 80 };

describe('attaching against a stale list', () => {
  test('an agent just started is attached even before the snapshot lists it', async () => {
    const recorded: Recorded = { attached: [], listings: 0 };
    // The snapshot keeps not mentioning the new pane, as herdr's does for a
    // moment after `agent start` returns.
    const herdr = fakeSource('herdr', recorded, () => Effect.succeed([pane('w1:p1', 'herdr', 'codex')]), {
      newAgent: () => Effect.succeed('w1:p9'),
    });

    await Effect.gen(function* () {
      const registry = yield* HostRegistry;
      yield* registry.setHosts([{ alias: 'mac' }]);
      yield* settle;
      yield* registry.newAgent('mac', { kind: 'codex', where: 'tab' }, size);
      yield* settle;
      const told = yield* Queue.clear(registry.changes);
      const errors = told.filter((change) => change.type === 'error');
      expect(errors).toEqual([]);
      expect(recorded.attached).toEqual(['herdr:w1:p9']);
    }).pipe(Effect.scoped, Effect.provide(registryWith([herdr])), Effect.runPromise);
  });

  test('a terminal just opened is attached the same way', async () => {
    const recorded: Recorded = { attached: [], listings: 0 };
    const tmux = fakeSource('tmux', recorded, () => Effect.succeed([]), {
      newPane: () => Effect.succeed('%7'),
    });

    await Effect.gen(function* () {
      const registry = yield* HostRegistry;
      yield* registry.setHosts([{ alias: 'mac' }]);
      yield* settle;
      yield* registry.newTerminal('mac', size);
      yield* settle;
      expect(recorded.attached).toEqual(['tmux:%7']);
    }).pipe(Effect.scoped, Effect.provide(registryWith([tmux])), Effect.runPromise);
  });

  test('a resize reopens the pane being looked at even if the list lost it', async () => {
    const recorded: Recorded = { attached: [], listings: 0 };
    let listed: ReadonlyArray<Pane> = [pane('w1:p1', 'herdr', 'codex')];
    const herdr = fakeSource('herdr', recorded, () => Effect.succeed(listed));

    await Effect.gen(function* () {
      const registry = yield* HostRegistry;
      yield* registry.setHosts([{ alias: 'mac' }]);
      yield* settle;
      yield* registry.attach('mac', 'w1:p1', size);
      yield* settle;
      expect(recorded.attached).toEqual(['herdr:w1:p1']);

      // The next refresh does not mention the pane.
      listed = [];
      yield* registry.refreshOne('mac');
      yield* settle;
      yield* Queue.clear(registry.changes);

      yield* registry.resize({ rows: 30, columns: 100 });
      yield* settle;
      const told = yield* Queue.clear(registry.changes);
      expect(told.filter((change) => change.type === 'error')).toEqual([]);
      expect(recorded.attached).toEqual(['herdr:w1:p1', 'herdr:w1:p1']);
    }).pipe(Effect.scoped, Effect.provide(registryWith([herdr])), Effect.runPromise);
  });

  test('a source that fails one refresh keeps the panes it listed last time', async () => {
    const recorded: Recorded = { attached: [], listings: 0 };
    let herdrAnswers = true;
    const herdr = fakeSource('herdr', recorded, () =>
      herdrAnswers
        ? Effect.succeed([pane('w1:p1', 'herdr', 'codex')])
        : Effect.fail(new Error('herdr did not answer'))
    );
    const tmux = fakeSource('tmux', recorded, () => Effect.succeed([pane('%1', 'tmux')]));

    await Effect.gen(function* () {
      const registry = yield* HostRegistry;
      yield* registry.setHosts([{ alias: 'mac' }]);
      yield* settle;
      herdrAnswers = false;
      yield* Queue.clear(registry.changes);
      yield* registry.refreshOne('mac');
      yield* settle;
      const told = yield* Queue.clear(registry.changes);
      const hosts = told.filter((change) => change.type === 'hosts');
      const last = hosts[hosts.length - 1];
      if (last === undefined || last.type !== 'hosts') throw new Error('no hosts event');
      const ids = last.hosts[0]?.panes.map((entry) => entry.id) ?? [];
      expect(ids).toEqual(['w1:p1', '%1']);
      // And it says that something did not answer, without emptying the list.
      expect(last.hosts[0]?.error).toMatch(/did not answer/);
    }).pipe(Effect.scoped, Effect.provide(registryWith([herdr, tmux])), Effect.runPromise);
  });
});
