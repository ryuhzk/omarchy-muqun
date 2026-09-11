/**
 * Drive the registry's simulator watch directly, with nothing swallowed.
 *
 * The sidecar reports a failure as one quiet line; this runs the same use case
 * with the cause printed, which is what you want when the quiet line is the
 * thing you are trying to explain. Not part of the suite.
 */

import { BunServices } from '@effect/platform-bun';
import { Effect, Fiber, Queue, Stream } from 'effect';
import { HerdrSourceLayer } from '../backend/adapters/herdr-source';
import { SimfarmLayer } from '../backend/adapters/simfarm-source';
import { SshRunnerLayer } from '../backend/adapters/ssh-runner';
import { VtTerminalFactoryLayer } from '../backend/adapters/vt-parser';
import { HostRegistry } from '../backend/application/host-registry';

const config = {
  url: process.env.MUQUN_SIMFARM_URL ?? '',
  sshHost: process.env.MUQUN_SIMFARM_SSH ?? '',
  localPort: Number.parseInt(process.env.MUQUN_SIMFARM_PORT ?? '8801', 10),
};

const program = Effect.gen(function* () {
  const registry = yield* HostRegistry;

  const seen = new Map<string, number>();
  const reader = yield* Effect.forkScoped(
    Stream.fromQueue(registry.changes).pipe(
      Stream.runForEach((change) =>
        Effect.sync(() => {
          seen.set(change.type, (seen.get(change.type) ?? 0) + 1);
          if (seen.get(change.type) === 1) console.log('first', change.type);
        })
      )
    )
  );

  console.log('watching…');
  yield* registry.watchSimulators(config, process.env.MUQUN_DEVICE ?? null);

  yield* Effect.sleep('10 seconds');
  console.log('counts:', Object.fromEntries(seen));
  yield* Fiber.interrupt(reader);
}).pipe(
  Effect.scoped,
  Effect.provide(HostRegistry.layer),
  Effect.provide(HerdrSourceLayer),
  Effect.provide(SimfarmLayer),
  Effect.provide(VtTerminalFactoryLayer),
  Effect.provide(SshRunnerLayer),
  Effect.provide(BunServices.layer)
);

Effect.runPromise(program as Effect.Effect<void, unknown, never>).then(
  () => console.log('done'),
  (error) => console.error('FAIL', String(error).slice(0, 900))
);
