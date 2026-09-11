/**
 * The Wayland clipboard, through `wl-clipboard`.
 *
 * Asked what it is holding before it is asked for it, because a screenshot and
 * a line of text are the same gesture to the person pasting and two different
 * things to the pane receiving. A picture becomes a file on the machine the
 * pane is running on and the pane is handed its path; text is just typed.
 *
 * `wl-paste` is run with an argument vector and never through a shell. What
 * comes back is bytes from the clipboard, which is to say bytes from whatever
 * the last program to copy something felt like putting there.
 */

import { Effect, Layer, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { Clipboard, type ClipboardContent } from '../application/ports';

/**
 * The picture formats worth taking, in the order they are preferred.
 *
 * PNG first because it is lossless and every agent reads it. The extension is
 * this build's, not the clipboard's: a mime type is a short fixed string from a
 * known list, and a filename built from a fixed list cannot be anything else.
 */
const IMAGE_TYPES: ReadonlyArray<{
  readonly mime: string;
  readonly extension: string;
  /** The bytes a file of this format begins with. */
  readonly magic: ReadonlyArray<number>;
}> = [
  { mime: 'image/png', extension: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', extension: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/webp', extension: 'webp', magic: [0x52, 0x49, 0x46, 0x46] },
  { mime: 'image/gif', extension: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
];

/**
 * Whether the bytes are the format the clipboard said they were.
 *
 * The clipboard's type is a claim by whichever program last copied something,
 * and this is the only thing that leaves this machine for another one. A file
 * named `.png` whose contents are something else entirely is not a paste
 * anybody meant, so it is not sent.
 */
function matches(bytes: Uint8Array, magic: ReadonlyArray<number>): boolean {
  if (bytes.byteLength < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/**
 * The most of the clipboard that is read.
 *
 * A screenshot of a large display is a few megabytes. Past this it is not a
 * thing anyone meant to paste into a terminal, and it still has to cross a
 * network to a machine somewhere else.
 */
const LIMIT_BYTES = 16 * 1024 * 1024;

/** How long to wait for the clipboard to answer at all. */
const TIMEOUT_MS = 4_000;

export const ClipboardLayer = Layer.effect(
  Clipboard,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    /** Run `wl-paste` and collect what it wrote, or nothing. */
    const paste = Effect.fnUntraced(function* (argv: ReadonlyArray<string>) {
      const handle = yield* spawner.spawn(ChildProcess.make('wl-paste', [...argv]));

      // stderr is drained rather than read: wl-paste complains about an empty
      // clipboard there, and an unread pipe that fills would wedge the read.
      yield* Effect.forkScoped(
        handle.stderr.pipe(Stream.runDrain, Effect.catchCause(() => Effect.void))
      );

      const chunks = yield* handle.stdout.pipe(Stream.runCollect);

      let total = 0;
      for (const chunk of chunks) total += chunk.byteLength;
      if (total === 0 || total > LIMIT_BYTES) return null;

      const bytes = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      return bytes;
    });

    const safely = <A>(work: Effect.Effect<A, unknown, never>, fallback: A) =>
      work.pipe(
        Effect.timeout(TIMEOUT_MS),
        Effect.catchCause(() => Effect.succeed(fallback))
      );

    const read = (): Effect.Effect<ClipboardContent> =>
      Effect.scoped(
        Effect.gen(function* () {
          const listed = yield* safely(paste(['--list-types']), null);
          const offered = listed === null ? '' : new TextDecoder().decode(listed);

          const picture = IMAGE_TYPES.find((candidate) =>
            offered.split('\n').some((line) => line.trim() === candidate.mime)
          );

          if (picture !== undefined) {
            const bytes = yield* safely(paste(['--type', picture.mime]), null);
            if (bytes !== null && matches(bytes, picture.magic)) {
              return { kind: 'image', bytes, extension: picture.extension } as const;
            }
          }

          const text = yield* safely(paste(['--no-newline']), null);
          if (text === null) return { kind: 'empty' } as const;
          return { kind: 'text', text: new TextDecoder().decode(text) } as const;
        })
      ).pipe(Effect.catchCause(() => Effect.succeed({ kind: 'empty' } as const)));

    return Clipboard.of({ read });
  })
);
