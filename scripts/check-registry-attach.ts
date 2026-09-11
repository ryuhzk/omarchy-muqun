/**
 * Drive the registry's attach directly, with nothing swallowed. Not part of the
 * suite; it needs a real host.
 *
 *   MUQUN_ALIAS=you@host MUQUN_PANE=w1:p5 bun run scripts/check-registry-attach.ts
 */

import { BunServices } from '@effect/platform-bun';
import { Effect, Fiber, Stream } from 'effect';
import { HerdrSourceLayer } from '../backend/adapters/herdr-source';
import { SimfarmLayer } from '../backend/adapters/simfarm-source';
import { SshRunnerLayer } from '../backend/adapters/ssh-runner';
import { VtTerminalFactoryLayer } from '../backend/adapters/vt-parser';
import { HostRegistry } from '../backend/application/host-registry';

const ALIAS = process.env.MUQUN_ALIAS ?? '';
const PANE = process.env.MUQUN_PANE ?? '';

const program = Effect.gen(function* () {
  const registry = yield* HostRegistry;

  const seen = new Map<string, number>();
  const reader = yield* Effect.forkScoped(
    Stream.fromQueue(registry.changes).pipe(
      Stream.runForEach((change) =>
        Effect.sync(() => {
          seen.set(change.type, (seen.get(change.type) ?? 0) + 1);
          if (change.type === 'error') console.log('error:', change.message.slice(0, 200));
          if (change.type === 'screen' && seen.get('screen') === 1) {
            const text = change.rows
              .map((row) => row.runs.map((run) => run.text).join(''))
              .filter((line) => line.trim() !== '');
            console.log(`first screen: ${text.length} rows, cursor`, change.cursor);
            for (const line of text.slice(0, 3)) console.log('  |', line.slice(0, 80));
          }
        })
      )
    )
  );

  console.log('setting hosts…');
  yield* registry.setHosts([{ alias: ALIAS }]);
  yield* Effect.sleep('3 seconds');

  console.log('attaching…');
  yield* registry.attach(ALIAS, PANE, { rows: 24, columns: 80 });
  yield* Effect.sleep('6 seconds');

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

if (ALIAS === '' || PANE === '') {
  console.error('set MUQUN_ALIAS and MUQUN_PANE');
  process.exit(2);
}

Effect.runPromise(program as Effect.Effect<void, unknown, never>).then(
  () => console.log('done'),
  (error) => console.error('FAIL', String(error).slice(0, 900))
);
