/**
 * A live check of the terminal transport: a pty on the far side, our parser on
 * this one, and a keystroke going the other way.
 *
 * It opens a fresh interactive shell of its own rather than touching anything
 * already running, and types one harmless command. Not part of the suite: it
 * needs a real host.
 */

import { BunServices } from '@effect/platform-bun';
import { Effect, Stream } from 'effect';
import { SshRunnerLayer } from './backend/adapters/ssh-runner';
import { makeTerminal } from './backend/adapters/vt-parser';
import { CommandRunner } from './backend/application/ports';

const ALIAS = process.env.MUQUN_ALIAS ?? '';
const ROWS = 24;
const COLUMNS = 100;

function show(terminal: ReturnType<typeof makeTerminal>, label: string, tail: number): void {
  const visible = terminal.screen
    .toText()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-tail);
  console.log(`--- ${label} (cursor ${terminal.screen.cursor.row},${terminal.screen.cursor.column}) ---`);
  for (const line of visible) console.log(`| ${line}`);
}

const program = Effect.gen(function* () {
  const runner = yield* CommandRunner;
  const terminal = makeTerminal(ROWS, COLUMNS);

  const session = yield* runner.session(
    ALIAS,
    ['sh', '-c', `stty rows ${ROWS} cols ${COLUMNS} 2>/dev/null; exec sh -i`],
    { pty: true }
  );

  let bytes = 0;
  yield* Effect.forkScoped(
    session.output.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          bytes += chunk.length;
          terminal.write(chunk);
        })
      ),
      Effect.catchCause(() => Effect.void)
    )
  );

  yield* Effect.sleep('2 seconds');
  console.log(`prompt: ${bytes} bytes`);
  show(terminal, 'after attach', 3);

  // Typed one character at a time, which is what a keyboard does and what the
  // panel will do. If the far side is echoing, the letters appear before the
  // return does anything.
  for (const character of 'ls') {
    yield* session.write(character);
    yield* Effect.sleep('120 millis');
  }
  yield* Effect.sleep('400 millis');
  show(terminal, 'after typing "ls", before return', 3);

  yield* session.write('\r');
  yield* Effect.sleep('2 seconds');
  show(terminal, 'after return', 8);

  console.log(`total: ${bytes} bytes`);
}).pipe(Effect.scoped, Effect.provide(SshRunnerLayer), Effect.provide(BunServices.layer));

if (ALIAS === '') {
  console.error('set MUQUN_ALIAS');
  process.exit(2);
}

Effect.runPromise(program as Effect.Effect<void, unknown, never>).then(
  () => console.log('detached'),
  (error) => console.error('FAIL', String(error).slice(0, 600))
);
