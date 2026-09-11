/**
 * A live check of the simulator channel: the forward, the socket, the device
 * list, and frames from one device.
 *
 * Not part of the suite; it needs a real farm.
 *   MUQUN_SIMFARM_URL=... MUQUN_SIMFARM_SSH=... bun run scripts/check-simfarm.ts
 */

import { BunServices } from '@effect/platform-bun';
import { Effect, Stream } from 'effect';
import { SimfarmLayer } from '../backend/adapters/simfarm-source';
import { SshRunnerLayer } from '../backend/adapters/ssh-runner';
import { Simulators } from '../backend/application/ports';

const config = {
  url: process.env.MUQUN_SIMFARM_URL ?? '',
  sshHost: process.env.MUQUN_SIMFARM_SSH ?? '',
  localPort: Number.parseInt(process.env.MUQUN_SIMFARM_PORT ?? '8801', 10),
};

const program = Effect.gen(function* () {
  const simulators = yield* Simulators;

  console.log('opening the forward…');
  yield* simulators.open(config);

  const status = yield* simulators.status(config);
  console.log('status:', status);

  const session = yield* simulators.watch(config, process.env.MUQUN_DEVICE ?? null);

  let frames = 0;
  yield* Effect.forkScoped(
    session.updates.pipe(
      Stream.runForEach((update) =>
        Effect.sync(() => {
          if (update.kind === 'devices') {
            console.log(`devices: ${update.devices.length}`);
            for (const device of update.devices) {
              console.log(
                `  ${device.booted ? 'booted' : '      '} ${device.kind.padEnd(8)} ` +
                  `${device.showable ? 'jpeg' : 'h264'}  ${device.name.slice(0, 46)}`
              );
            }
            return;
          }
          frames += 1;
          if (frames <= 2 || frames % 20 === 0) {
            console.log(`frame ${frames}: ${update.path}`);
          }
        })
      )
    )
  );

  yield* Effect.sleep('8 seconds');
  console.log(`total frames: ${frames}`);
}).pipe(Effect.scoped, Effect.provide(SimfarmLayer), Effect.provide(SshRunnerLayer), Effect.provide(BunServices.layer));

if (config.url === '') {
  console.error('set MUQUN_SIMFARM_URL');
  process.exit(2);
}

Effect.runPromise(program as Effect.Effect<void, unknown, never>).then(
  () => console.log('done'),
  (error) => console.error('FAIL', String(error).slice(0, 600))
);
