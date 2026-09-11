/**
 * `Simulators` over simfarm's socket, with a forward when the address needs one.
 *
 * The rules about which address may be used live in `domain/simfarm.ts`, because
 * they are rules and not plumbing. What is here is the plumbing: hold the
 * forward, speak the socket, and put each picture somewhere the panel can draw
 * it.
 *
 * A browser is not an option for the drawing. Qt's web engine has to be
 * initialised before the application object exists, which a plugin loaded into
 * a running shell cannot do -- it takes the shell down on the first frame -- and
 * a shell that also owns the bar, the notifications and the lock screen is not
 * somewhere to put a browser engine. So the picture is fetched here and drawn
 * as an image, which is all a viewer needs.
 */

import { Effect, Layer, Queue, Schema, Scope, Stream } from 'effect';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CommandRunner,
  Simulators,
  TransportError,
  type SimulatorInput,
  type SimulatorSession,
  type SimulatorUpdate,
} from '../application/ports';
import { forwardFor, statusUrl, type SimfarmConfig } from '../domain/simfarm';
import {
  decodeFrame,
  devicesFrom,
  encodeButton,
  encodeControl,
  encodeKey,
  encodeScroll,
  encodeText,
  encodeTouch,
  KEY_PHASE,
  TOUCH_PHASE,
  WireDeviceList,
} from './simfarm-wire';
import { runtimeDirectory } from './runtime-dir';

/**
 * The most a status reply may be.
 *
 * It is three numbers. Anything past this is a server that is not the one this
 * expects, or one that has been made to answer with something enormous, and
 * reading it into memory to find that out is the mistake. Read as bytes with a
 * ceiling rather than handed to `json()`, which has none.
 */
const STATUS_LIMIT_BYTES = 64 * 1024;

/** The most one video frame or control message may be. */
const FRAME_LIMIT_BYTES = 8 * 1024 * 1024;

async function readStatus(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > STATUS_LIMIT_BYTES) throw new Error('the simulator farm answered with too much');

  const reader = response.body?.getReader();
  if (reader === undefined) return JSON.parse(await response.text()) as unknown;

  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > STATUS_LIMIT_BYTES) {
      await reader.cancel();
      throw new Error('the simulator farm answered with too much');
    }
    chunks.push(next.value);
  }

  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

const Status = Schema.Struct({
  booted: Schema.Number,
  devices: Schema.Number,
});

/** A farm on a sleeping machine should be reported quickly, not waited on. */
const STATUS_TIMEOUT_MS = 3_000;

/** How long to wait for the farm to answer `list` or `attach`. */
const REPLY_TIMEOUT_MS = 10_000;

function socketUrl(config: SimfarmConfig): string {
  const base = statusUrl(config).replace(/\/healthz$/, '');
  return `${base.replace(/^http/, 'ws')}/v1`;
}

/** Where frames are written: tmpfs, private, and gone on restart. */
function frameDirectory(): string {
  const base = runtimeDirectory();
  const directory = join(base, 'omarchy-muqun');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** Turn what the panel asked for into the bytes the device expects. */
function encodeInput(
  streamId: number,
  input: SimulatorInput,
  nextSequence: () => number
): Uint8Array | null {
  switch (input.kind) {
    case 'touch':
      return encodeTouch(
        streamId,
        TOUCH_PHASE[input.phase],
        input.x,
        input.y,
        nextSequence()
      );
    case 'key':
      return encodeKey(streamId, KEY_PHASE[input.phase], input.usage);
    case 'button':
      return encodeButton(streamId, KEY_PHASE[input.phase], input.buttonId);
    case 'scroll':
      return encodeScroll(streamId, input.dx, input.dy, input.x, input.y);
    case 'text':
      return encodeText(streamId, input.text);
    default:
      return null;
  }
}

export const SimfarmLayer = Layer.effect(
  Simulators,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;

    const open = (config: SimfarmConfig): Effect.Effect<void, TransportError, Scope.Scope> =>
      Effect.suspend(() => {
        const wanted = forwardFor(config);
        if (wanted === null) return Effect.void;
        return runner.forward(config.sshHost, {
          localPort: config.localPort,
          remoteHost: wanted.remoteHost,
          remotePort: wanted.remotePort,
        });
      });

    const watch = Effect.fnUntraced(function* (
      config: SimfarmConfig,
      deviceId: string | null
    ) {
      const directory = frameDirectory();
      const updates = yield* Queue.unbounded<SimulatorUpdate>();

      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => new WebSocket(socketUrl(config))),
        (live) => Effect.sync(() => live.close())
      );
      socket.binaryType = 'arraybuffer';

      let nextId = 1;
      let streamId: number | null = null;
      let revision = 0;
      const waiting = new Map<number, (json: Record<string, unknown>) => void>();

      const ask = (message: Record<string, unknown>): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const id = nextId;
          nextId += 1;
          waiting.set(id, resolve);
          socket.send(encodeControl({ id, ...message }));
          setTimeout(() => {
            if (waiting.delete(id)) reject(new Error('simfarm did not answer'));
          }, REPLY_TIMEOUT_MS);
        });

      const publishDevices = (json: unknown): void => {
        const decoded = Schema.decodeUnknownOption(WireDeviceList)(json);
        if (decoded._tag !== 'Some') return;
        const devices = devicesFrom(decoded.value);
        if (devices.length === 0) return;
        Queue.offerUnsafe(updates, { kind: 'devices', devices });
      };

      // Two files, used alternately. The panel may be reading one at the moment
      // the next arrives, and a half-written picture is worse than the previous
      // whole one; the rename is atomic and the alternation means the file being
      // read is never the file being replaced.
      const frameFile = (n: number): string => join(directory, `device-${n % 2}.jpg`);

      socket.addEventListener('message', (event) => {
        const raw = new Uint8Array(event.data as ArrayBuffer);
        // A phone screen is a hundred kilobytes or so. Anything past this is
        // not a frame, and decoding it to find that out is the mistake.
        if (raw.byteLength > FRAME_LIMIT_BYTES) return;

        const frame = decodeFrame(raw);
        if (frame === null) return;

        if (frame.channel === 'video') {
          if (streamId !== null && frame.streamId !== streamId) return;
          revision += 1;
          const target = frameFile(revision);
          try {
            const scratch = `${target}.next`;
            // Owner-only: a frame is a picture of somebody's screen.
            writeFileSync(scratch, frame.data, { mode: 0o600 });
            renameSync(scratch, target);
            Queue.offerUnsafe(updates, { kind: 'frame', path: target, revision });
          } catch {
            // A frame that cannot be written is one frame missed.
          }
          return;
        }

        // Anything that is not video and not one of the two JSON channels is a
        // channel this build does not speak, and there is nothing to read.
        if (frame.channel === 'other') return;

        const json = frame.json as Record<string, unknown>;
        if (frame.channel === 'control') {
          const id = typeof json.id === 'number' ? json.id : null;
          if (id !== null) {
            const resolve = waiting.get(id);
            waiting.delete(id);
            if (resolve) resolve(json);
          }
          publishDevices(json);
          return;
        }
        if (frame.channel === 'event' && json.ev === 'devices') publishDevices(json);
      });

      // Ask for the list as soon as the socket is up, then attach if a device
      // was named. A farm that will not answer shows as no devices, which is
      // what the panel then says.
      // A socket that never opens, or one that drops, has to say so. Without
      // this the strip sits on "waiting" for as long as the panel is open and
      // never explains itself.
      socket.addEventListener('error', () => {
        Queue.offerUnsafe(updates, { kind: 'closed' });
      });
      socket.addEventListener('close', () => {
        Queue.offerUnsafe(updates, { kind: 'closed' });
      });

      socket.addEventListener('open', () => {
        void ask({ op: 'list' })
          .then(async (reply) => {
            publishDevices(reply);
            if (deviceId === null) return;
            const attached = await ask({ op: 'attach', deviceId, codec: 'jpeg' });
            if (typeof attached.streamId === 'number') streamId = attached.streamId;
          })
          .catch(() => {});
      });

      let sequence = 0;

      const send = (input: SimulatorInput): Effect.Effect<void> =>
        Effect.sync(() => {
          // Input before the attachment has finished is dropped rather than
          // queued: a tap meant for a device that is not showing yet is not a
          // tap anyone wants delivered late.
          if (streamId === null || socket.readyState !== WebSocket.OPEN) return;
          const frame = encodeInput(streamId, input, () => {
            sequence += 1;
            return sequence;
          });
          if (frame !== null) socket.send(frame);
        });

      return { updates: Stream.fromQueue(updates), send } satisfies SimulatorSession;
    });

    return Simulators.of({
      open,
      watch,

      status: (config) =>
        Effect.tryPromise({
          try: (signal) => readStatus(statusUrl(config), signal),
          catch: (cause) => cause,
        }).pipe(
          Effect.timeout(STATUS_TIMEOUT_MS),
          Effect.flatMap((body) => Schema.decodeUnknownEffect(Status)(body)),
          // A farm that does not answer, or answers with something else, is no
          // answer. The panel says so rather than showing a count it invented.
          Effect.catchCause(() => Effect.succeed(null))
        ),
    });
  })
);
