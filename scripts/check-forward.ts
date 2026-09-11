/**
 * Does a port forward actually bind? Not part of the suite.
 *
 *   MUQUN_ALIAS=you@host bun run scripts/check-forward.ts
 */

import { BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import { spawnSync } from 'node:child_process';
import { SshRunnerLayer } from '../backend/adapters/ssh-runner';
import { CommandRunner } from '../backend/application/ports';

const ALIAS = process.env.MUQUN_ALIAS ?? '';
const LOCAL = Number.parseInt(process.env.MUQUN_PORT ?? '8807', 10);

function listening(port: number): boolean {
  const out = spawnSync('ss', ['-ltn'], { encoding: 'utf8' }).stdout ?? '';
  return out.includes(`:${port} `);
}

const program = Effect.gen(function* () {
  const runner = yield* CommandRunner;

  console.log('asking for the forward…');
  yield* runner.forward(ALIAS, {
    localPort: LOCAL,
    remoteHost: process.env.MUQUN_REMOTE_HOST ?? '127.0.0.1',
    remotePort: Number.parseInt(process.env.MUQUN_REMOTE_PORT ?? '8801', 10),
  });

  console.log('ssh processes now:');
  console.log(
    (spawnSync('pgrep', ['-af', 'ssh'], { encoding: 'utf8' }).stdout ?? '')
      .split('\n')
      .filter((line) => line.includes('-L'))
      .map((line) => `  ${line.slice(0, 120)}`)
      .join('\n') || '  (none with -L)'
  );

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (listening(LOCAL)) {
      console.log(`listening on ${LOCAL} after ${attempt * 500}ms`);
      const answer = yield* Effect.tryPromise({
        try: () => fetch(`http://127.0.0.1:${LOCAL}/healthz`).then((r) => r.text()),
        catch: (cause) => cause,
      }).pipe(Effect.catchCause(() => Effect.succeed('(no answer)')));
      console.log('healthz:', answer.slice(0, 120));
      return;
    }
    yield* Effect.sleep(500);
  }
  console.log(`nothing listening on ${LOCAL}`);
}).pipe(Effect.scoped, Effect.provide(SshRunnerLayer), Effect.provide(BunServices.layer));

if (ALIAS === '') {
  console.error('set MUQUN_ALIAS');
  process.exit(2);
}

Effect.runPromise(program as Effect.Effect<void, unknown, never>).then(
  () => console.log('done'),
  (error) => console.error('FAIL', String(error).slice(0, 600))
);
