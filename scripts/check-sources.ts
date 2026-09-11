/**
 * What a host turns out to have, and everything it is running, from every
 * source it has. Not part of the suite; it needs a real host.
 *
 *   MUQUN_ALIAS=you@host bun run scripts/check-sources.ts
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

  const reader = yield* Effect.forkScoped(
    Stream.fromQueue(registry.changes).pipe(
      Stream.runForEach((change) =>
        Effect.sync(() => {
          if (change.type === 'error') console.log('error:', change.message.slice(0, 200));
          if (change.type !== 'hosts') return;
          for (const host of change.hosts) {
            console.log(
              `${host.alias} | ${host.state} | caps ${JSON.stringify(host.capabilities)} | ` +
                `${host.panes.length} panes${host.error ? ` | ${host.error}` : ''}`
            );
            for (const pane of host.panes.slice(0, 24)) {
              console.log(
                `   ${pane.source.padEnd(6)} ${pane.status.padEnd(8)} ` +
                  `${(pane.agent ?? '-').padEnd(8)} ${pane.title.slice(0, 46)}`
              );
            }
          }
        })
      )
    )
  );

  yield* registry.setHosts([{ alias: ALIAS }]);
  yield* Effect.sleep('8 seconds');
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
