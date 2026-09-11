/**
 * Attach to one pane and report what comes back. Read-only: it types nothing.
 *
 * Not part of the suite; it needs a real host.
 *   MUQUN_ALIAS=... MUQUN_PANE=... bun run scripts/check-pane.ts
 */

import { BunServices } from '@effect/platform-bun';
import { Effect, Stream } from 'effect';
import { HerdrSourceLayer } from '../backend/adapters/herdr-source';
import { SshRunnerLayer } from '../backend/adapters/ssh-runner';
import { makeTerminal } from '../backend/adapters/vt-parser';
import { TerminalSource } from '../backend/application/ports';

const ALIAS = process.env.MUQUN_ALIAS ?? '';
const PANE = process.env.MUQUN_PANE ?? '';

const program = Effect.gen(function* () {
  const source = yield* TerminalSource;
  const terminal = makeTerminal(20, 90);
  const pane = yield* source.attach(ALIAS, PANE, { rows: 20, columns: 90 }, { takeover: true });

  let bytes = 0;
  yield* Effect.forkScoped(
    pane.output.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          bytes += chunk.length;
          terminal.write(chunk);
        })
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => console.error('stream ended:', String(cause).slice(0, 240)))
      )
    )
  );

  yield* Effect.sleep('4 seconds');
  const visible = terminal.screen
    .toText()
    .split('\n')
    .filter((line) => line.trim() !== '');
  console.log(`${bytes} bytes, ${visible.length} non-empty rows, cursor`, terminal.screen.cursor);
  for (const line of visible.slice(0, 8)) console.log('|', line.slice(0, 88));
}).pipe(
  Effect.scoped,
  Effect.provide(HerdrSourceLayer),
  Effect.provide(SshRunnerLayer),
  Effect.provide(BunServices.layer)
);

if (ALIAS === '' || PANE === '') {
  console.error('set MUQUN_ALIAS and MUQUN_PANE');
  process.exit(2);
}

Effect.runPromise(program as Effect.Effect<void, unknown, never>).then(
  () => console.log('detached'),
  (error) => console.error('FAIL', String(error).slice(0, 500))
);
