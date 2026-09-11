/**
 * Open a terminal on a host, run one harmless thing in it, and close it again.
 * Not part of the suite; it needs a real host, and it makes a window there.
 *
 *   MUQUN_ALIAS=you@host bun run scripts/check-new-terminal.ts
 */

import { BunServices } from '@effect/platform-bun';
import { Effect, Fiber, Layer, Stream } from 'effect';
import { makeHerdrSource } from '../backend/adapters/herdr-source';
import { SimfarmLayer } from '../backend/adapters/simfarm-source';
import { SshRunnerLayer } from '../backend/adapters/ssh-runner';
import { makeTmuxSource } from '../backend/adapters/tmux-source';
import { VtTerminalFactoryLayer } from '../backend/adapters/vt-parser';
import { HostRegistry } from '../backend/application/host-registry';
import { TerminalSources } from '../backend/application/ports';

const ALIAS = process.env.MUQUN_ALIAS ?? '';

const SourcesLayer = Layer.effect(
  TerminalSources,
  Effect.gen(function* () {
    const herdr = yield* makeHerdrSource;
    const tmux = yield* makeTmuxSource;
    return { all: [herdr, tmux] };
  })
).pipe(Layer.provide(SshRunnerLayer));

const program = Effect.gen(function* () {
  const registry = yield* HostRegistry;

  let screens = 0;
  let attachedPane = '';
  const reader = yield* Effect.forkScoped(
    Stream.fromQueue(registry.changes).pipe(
      Stream.runForEach((change) =>
        Effect.sync(() => {
          if (change.type === 'error') console.log('error:', change.message.slice(0, 200));
          if (change.type !== 'screen') return;
          screens += 1;
          attachedPane = change.paneId;

          const text = change.rows
            .map((row) => row.runs.map((run) => run.text).join('').trimEnd())
            .filter((line) => line !== '');
          console.log(`screen ${screens} on ${change.paneId}:`);
          for (const line of text.slice(-3)) console.log('  |', line.slice(0, 90));
        })
      )
    )
  );

  yield* registry.setHosts([{ alias: ALIAS }]);
  yield* Effect.sleep('5 seconds');

  console.log('opening a terminal…');
  yield* registry.newTerminal(ALIAS, { rows: 24, columns: 100 });
  yield* Effect.sleep('4 seconds');

  console.log('typing…');
  yield* registry.typeText('echo muqun-can-run-anything\r');
  yield* Effect.sleep('3 seconds');

  console.log('sleeping, then interrupting…');
  yield* registry.typeText('sleep 30\r');
  yield* Effect.sleep('2 seconds');
  yield* registry.pressKeys(['C-c']);
  yield* Effect.sleep('3 seconds');

  console.log('closing it…');
  yield* registry.closePane;
  yield* Effect.sleep('2 seconds');

  console.log('screens', screens, 'last pane', attachedPane);
  yield* Fiber.interrupt(reader);
}).pipe(
  Effect.scoped,
  Effect.provide(HostRegistry.layer),
  Effect.provide(SourcesLayer),
  Effect.provide(SimfarmLayer),
  Effect.provide(VtTerminalFactoryLayer),
  Effect.provide(SshRunnerLayer),
  Effect.provide(BunServices.layer)
);

if (ALIAS === '') {
  console.error('set MUQUN_ALIAS');
  process.exit(2);
}

Effect.runPromise(program as Effect.Effect<void, unknown, never>).then(
  () => console.log('done'),
  (error) => console.error('FAIL', String(error).slice(0, 900))
);
