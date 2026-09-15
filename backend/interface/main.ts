#!/usr/bin/env bun
/**
 * The composition root.
 *
 * This is the only file that names both a port and the thing that implements
 * it. It reads commands from stdin, writes changes to stdout, and wires the
 * layers together; everything it calls is written against interfaces.
 *
 * Closing stdin is how the panel says it is finished. `runMain` interrupts the
 * fibers, which closes the scope, which interrupts every host supervisor and
 * kills every ssh child underneath. Nothing is left behind when the shell
 * reloads.
 */

import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Effect, Layer, Stream } from 'effect';
import { ClipboardLayer } from '../adapters/clipboard';
import { GitContextLayer } from '../adapters/git-context';
import { makeHerdrSource } from '../adapters/herdr-source';
import { SimfarmLayer } from '../adapters/simfarm-source';
import { reapOwnChildren, SshRunnerLayer } from '../adapters/ssh-runner';
import { makeTmuxSource } from '../adapters/tmux-source';
import { VtTerminalFactoryLayer } from '../adapters/vt-parser';
import { HostRegistry } from '../application/host-registry';
import { TerminalSources } from '../application/ports';
import { acceptLine, type Event } from './sidecar';

/**
 * Every source, in the order a host is offered them.
 *
 * herdr first: a machine running it is running it on purpose, and it is the one
 * that knows what an agent is. tmux second, which is every other pane on every
 * other machine.
 */
const SourcesLayer = Layer.effect(
  TerminalSources,
  Effect.gen(function* () {
    const herdr = yield* makeHerdrSource;
    const tmux = yield* makeTmuxSource;
    return TerminalSources.of({ all: [herdr, tmux] });
  })
).pipe(Layer.provide(SshRunnerLayer));

const Infrastructure = Layer.mergeAll(
  VtTerminalFactoryLayer,
  SourcesLayer,
  SimfarmLayer.pipe(Layer.provide(SshRunnerLayer)),
  GitContextLayer.pipe(Layer.provide(SshRunnerLayer)),
  ClipboardLayer,
  SshRunnerLayer
).pipe(Layer.provide(BunServices.layer));

const Application = HostRegistry.layer.pipe(Layer.provide(Infrastructure));

const stdinLines = Stream.fromAsyncIterable(
  process.stdin as AsyncIterable<Uint8Array | string>,
  (cause) => cause
).pipe(
  Stream.map((chunk) => (typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))),
  Stream.splitLines
);

function writeEvent(event: Event): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const program = Effect.gen(function* () {
  const registry = yield* HostRegistry;

  // Drain changes to stdout for as long as the process lives.
  yield* Effect.forkScoped(
    Stream.fromQueue(registry.changes).pipe(
      Stream.runForEach((change) => Effect.sync(() => writeEvent(change)))
    )
  );

  yield* Effect.sync(() => writeEvent({ type: 'ready' }));

  // When stdin ends this returns, the scope closes, and everything stops.
  yield* stdinLines.pipe(
    Stream.runForEach((line) => acceptLine(line)),
    Effect.catchCause(() => Effect.void)
  );
});

/**
 * Leave when told, and leave when the panel does.
 *
 * A graceful shutdown closes the scope, which kills the ssh children -- but it
 * can only do that if it finishes. A fiber that will not be interrupted leaves
 * the process alive with its children, orphaned onto a shell that has already
 * gone, and the next shell's channels then contend with a previous one's. So
 * the signal starts the tidy shutdown and a short deadline ends it either way.
 */
const EXIT_GRACE_MS = 1_000;

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    setTimeout(() => {
      // Whatever the graceful path did not get to, take down here. An ssh that
      // outlives this process is not idle: it holds a channel on the far side
      // with a remote watch behind it and nobody reading the answer, and the
      // next start contends with it for the ten channels sshd allows.
      reapOwnChildren();
      process.exit(0);
    }, EXIT_GRACE_MS).unref();
  });
}

// The same on the way out of an ordinary exit, which is the path a panel that
// simply goes away takes.
process.on('exit', reapOwnChildren);

BunRuntime.runMain(
  Effect.scoped(program).pipe(Effect.provide(Application)) as Effect.Effect<void, never, never>,
  { disableErrorReporting: false }
);
