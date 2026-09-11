/**
 * `CommandRunner` over OpenSSH.
 *
 * Every host gets a `ControlMaster` socket, so a host costs one authentication
 * and one TCP connection no matter how many probes, reads, and held-open wait
 * channels are live against it. Without it the plugin would authenticate once
 * per pane refresh, which on a key with a passphrase is both slow and rude.
 */

import { Effect, Layer, Queue, Stream } from 'effect';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { runtimeDirectory } from './runtime-dir';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import {
  CommandResult,
  CommandRunner,
  TransportError,
  type CommandSession,
  type PortForward,
  type SessionOptions,
} from '../application/ports';

/**
 * How long to wait for a connection before giving up.
 *
 * Deliberately short. A host that is asleep or off the network is the common
 * case rather than an exception, and the panel should say so quickly instead of
 * sitting on a spinner.
 */
const CONNECT_TIMEOUT_SECONDS = 8;

/**
 * How long a shared connection outlives its last command.
 *
 * Long enough that closing and reopening the panel reuses it, short enough that
 * a laptop that slept on another network does not keep a socket pointing
 * somewhere that no longer exists.
 */
const CONTROL_PERSIST_SECONDS = 120;

/**
 * How long to wait for a forward to start accepting.
 *
 * Waited on rather than slept through. A fixed pause is a guess about a machine
 * you have never met: too short and the first request goes out before ssh is
 * listening, which reads as a server that will not answer rather than as a
 * forward that was late by a tenth of a second.
 */
const FORWARD_READY_TIMEOUT_MS = 5_000;
const FORWARD_POLL_MS = 50;

/**
 * How much of a one-shot command's output is read.
 *
 * Counted in chunks rather than bytes because that is what the stream offers,
 * and set far above anything these commands produce: the largest is a herdr
 * snapshot of a busy machine, which is tens of kilobytes. What it rules out is
 * a command that never stops printing filling this process's memory, which is
 * not a threat model so much as a thing that happens.
 *
 * The attached terminal is not read this way. It is a stream that is consumed
 * as it arrives and never accumulates, which is why it has no ceiling.
 */
const OUTPUT_CHUNK_LIMIT = 4_096;
const ERROR_CHUNK_LIMIT = 64;

function controlPath(): string {
  const base = runtimeDirectory();
  // `%C` hashes the connection parameters, so two aliases cannot collide and
  // the path stays inside the length a unix socket allows.
  return `${base}/omarchy-muqun-cm-%C`;
}

/**
 * Quote one argument for the shell on the far side.
 *
 * ssh does not pass an argument vector. It joins what it is given with spaces
 * and hands the result to the remote login shell, which splits it again. So
 * `send-text w1:p5 hello world` arrives as four words and the pane receives
 * "hello". Every argument is wrapped here instead, which also means a pane id
 * or a typed sentence cannot turn into remote shell syntax.
 */
function remoteQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

/**
 * The options every invocation shares.
 *
 * Kept in one list so a forward and a command cannot end up on different terms
 * and open two connections to the same host.
 */
function sharedOptions(): Array<string> {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlPath()}`,
    '-o',
    `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
    '-o',
    'ServerAliveInterval=15',
    // Ignored by ssh, and the marker `reapStrays` looks for.
    '-o',
    `SetEnv=OMARCHY_MUQUN=${OWNER_TAG}`,
  ];
}

/**
 * An ssh target, or a refusal.
 *
 * ssh takes its destination as a bare argument, so a "host" beginning with a
 * dash is not a host: it is an option, and `-oProxyCommand=...` is a command
 * this plugin would then run. The alias comes from a settings file, which is
 * the user's own, but a settings file is also the sort of thing that gets
 * pasted from somewhere. There is no legitimate alias that starts with a dash,
 * so there is nothing to weigh.
 */
function validDestination(alias: string): boolean {
  return alias !== '' && !alias.startsWith('-');
}

/** A forward's far end, held to the same rule for the same reason. */
function validForward(forward: PortForward): boolean {
  return (
    forward.remoteHost !== '' &&
    !forward.remoteHost.startsWith('-') &&
    !forward.remoteHost.includes(':') &&
    Number.isInteger(forward.localPort) &&
    Number.isInteger(forward.remotePort) &&
    forward.localPort > 0 &&
    forward.localPort < 65536 &&
    forward.remotePort > 0 &&
    forward.remotePort < 65536
  );
}

function sshCommand(
  alias: string,
  argv: ReadonlyArray<string>,
  options?: SessionOptions
): ChildProcess.StandardCommand {
  // `-tt` forces a terminal even though this end has none. Without it the
  // remote command is handed a pipe and every program that asks whether it is
  // talking to a terminal answers no.
  const terminal = options?.pty === true ? ['-tt'] : [];
  const command = ChildProcess.make('ssh', [
    ...terminal,
    ...sharedOptions(),
    alias,
    '--',
    ...argv.map(remoteQuote),
  ]);
  if (options?.pty !== true) return command;

  // What kind of terminal the far side is talking to.
  //
  // ssh copies this end's `TERM` into the pty it asks for, and this end is a
  // desktop shell started by the session rather than from a terminal, so there
  // was nothing to copy. A pty whose `TERM` is empty is not a terminal any
  // program will draw on: tmux refuses outright with "terminal does not support
  // clear", which is why panes on a machine that answered perfectly well would
  // not open. It is set here rather than in each script because it is a fact
  // about the thing at this end -- the panel's own terminal, which understands
  // what a modern xterm understands.
  //
  // Everything this process already has goes with it. Setting an environment
  // replaces the inherited one rather than adding to it, and ssh without `PATH`
  // or the agent socket is ssh that cannot connect.
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[name] = value;
  }
  inherited.TERM = 'xterm-256color';

  return ChildProcess.setEnv(command, inherited) as ChildProcess.StandardCommand;
}

/**
 * Where a pasted picture lands on the far side, and what it is called.
 *
 * A directory of this plugin's own making under the remote user's own cache,
 * created with a umask that keeps everything in it owner-only. The name is
 * built at the call site from a clock reading and an extension chosen from a
 * fixed list, and quoted here, so nothing about the picture or the clipboard
 * reaches the remote shell as syntax. Written under a temporary name and moved,
 * so a reader never sees half a picture.
 */
function uploadScript(name: string): string {
  const safe = remoteQuote(name);
  return [
    'set -e',
    'umask 077',
    'dir="$HOME"/.cache/omarchy-muqun/incoming',
    'mkdir -p "$dir"',
    `cat >"$dir"/${safe}.part`,
    `mv "$dir"/${safe}.part "$dir"/${safe}`,
    `printf '%s\\n' "$dir"/${safe}`,
  ].join('\n');
}

/**
 * A name a remote shell cannot read as anything but a name.
 *
 * Everything outside the allowed set becomes a dash. A second fence rather than
 * the only one: the caller already builds the name itself.
 */
function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return cleaned === '' ? 'pasted' : cleaned.slice(0, 64);
}

/**
 * A forward with no command: `-N` asks for nothing to be run, so the connection
 * exists only to carry the port.
 */
function forwardCommand(alias: string, forward: PortForward): ChildProcess.StandardCommand {
  return ChildProcess.make('ssh', [
    ...sharedOptions(),
    '-N',
    // Fail loudly when the local port is taken. Without this ssh stays up
    // having forwarded nothing, and everything downstream reads as a machine
    // that will not answer.
    '-o',
    'ExitOnForwardFailure=yes',
    '-L',
    `${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`,
    alias,
  ]);
}

/**
 * A tag carried by every ssh this plugin starts.
 *
 * It is an option ssh already accepts and ignores in effect -- the control path
 * is set anyway -- and it is what makes the plugin's own processes findable
 * among everyone else's ssh.
 */
const OWNER_TAG = 'omarchy-muqun';

/**
 * Kill the channels a previous run left behind.
 *
 * A held-open channel does not end when the process that started it is killed
 * outright, which is how a shell restart leaves one behind. sshd allows ten
 * channels per connection, so a few restarts is all it takes to use the
 * allowance up: the next attach is refused, the panel shows an empty pane, and
 * nothing says why.
 *
 * Matched on the tag and on this user, so nothing else's ssh is touched.
 */
export function reapStrays(): void {
  const self = process.pid;
  try {
    const listed = spawnSync(
      'pgrep',
      ['-u', String(process.getuid?.() ?? 0), '-f', OWNER_TAG],
      { encoding: 'utf8' }
    );
    if (listed.status !== 0 || typeof listed.stdout !== 'string') return;

    for (const line of listed.stdout.split('\n')) {
      const pid = Number.parseInt(line.trim(), 10);
      if (!Number.isInteger(pid) || pid === self) continue;

      // Matching the tag is not enough on its own. Anything that merely
      // mentions it -- a shell running a diagnostic, an editor with this file
      // open -- matches too, and signalling those would be a plugin killing
      // things that are none of its business. The process must actually be an
      // ssh, which is a fact about it rather than about its arguments.
      if (!isSsh(pid)) continue;

      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone, or not ours to signal. Either is fine.
      }
    }
  } catch {
    // No pgrep is not a reason to refuse to start.
  }
}

/** Resolve once something is accepting connections on the loopback port. */
const waitForPort = Effect.fnUntraced(function* (port: number) {
  while (true) {
    const open = yield* Effect.tryPromise({
      try: () =>
        new Promise<boolean>((resolve) => {
          const probe = connect({ host: '127.0.0.1', port });
          probe.once('connect', () => {
            probe.destroy();
            resolve(true);
          });
          probe.once('error', () => {
            probe.destroy();
            resolve(false);
          });
        }),
      catch: () => false,
    }).pipe(Effect.catchCause(() => Effect.succeed(false)));

    if (open) return;
    yield* Effect.sleep(FORWARD_POLL_MS);
  }
});

function isSsh(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'ssh';
  } catch {
    return false;
  }
}

/** Who started a process, or nothing when it has already gone. */
function parentOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name is in brackets and may contain spaces, so the fields
    // after it are counted from the last bracket rather than from the start.
    const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const parent = Number.parseInt(after[1] ?? '', 10);
    return Number.isInteger(parent) ? parent : null;
  } catch {
    return null;
  }
}

/**
 * Take down the ssh children this process started, and only those.
 *
 * Used on the way out, where the broad reap would be wrong: the panel restarts
 * this process the moment it exits, so a dying instance reaping everything
 * tagged would take the new instance's connections with it, and the new one
 * would come up with no watch and no idea why.
 */
export function reapOwnChildren(): void {
  const self = process.pid;
  try {
    const listed = spawnSync(
      'pgrep',
      ['-u', String(process.getuid?.() ?? 0), '-f', OWNER_TAG],
      { encoding: 'utf8' }
    );
    if (listed.status !== 0 || typeof listed.stdout !== 'string') return;

    for (const line of listed.stdout.split('\n')) {
      const pid = Number.parseInt(line.trim(), 10);
      if (!Number.isInteger(pid) || pid === self) continue;
      if (parentOf(pid) !== self) continue;
      if (!isSsh(pid)) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone. Which is the point.
      }
    }
  } catch {
    // No pgrep is not a reason to refuse to leave.
  }
}

export const SshRunnerLayer = Layer.effect(
  CommandRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    yield* Effect.sync(reapStrays);

    // And the other end of the same idea, as a finalizer rather than as
    // something remembered at the exit: when this layer's scope closes, the ssh
    // children this process started go with it. The deadline in the composition
    // root is only there for the case where the scope never gets to close.
    yield* Effect.addFinalizer(() => Effect.sync(reapOwnChildren));

    const execute = Effect.fnUntraced(function* (alias: string, argv: ReadonlyArray<string>) {
      if (!validDestination(alias)) {
        return yield* new TransportError({
          alias,
          cause: new Error('an ssh host cannot begin with a dash'),
        });
      }
      const handle = yield* spawner
        .spawn(sshCommand(alias, argv))
        .pipe(Effect.mapError((cause) => new TransportError({ alias, cause })));

      // Drain both streams before asking for the exit status, and drain them
      // concurrently. A pane read is a couple of hundred kilobytes, larger than
      // a pipe buffer: draining one stream to the end while the other fills
      // would deadlock, and waiting for the exit first would deadlock on both.
      const [stdout, stderr] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.take(OUTPUT_CHUNK_LIMIT), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.take(ERROR_CHUNK_LIMIT), Stream.mkString),
        ],
        { concurrency: 2 }
      ).pipe(Effect.mapError((cause) => new TransportError({ alias, cause })));

      const code = yield* handle.exitCode.pipe(
        Effect.mapError((cause) => new TransportError({ alias, cause }))
      );

      return new CommandResult({ stdout, stderr, code: Number(code) });
    });

    const session = Effect.fnUntraced(function* (
      alias: string,
      argv: ReadonlyArray<string>,
      options?: SessionOptions
    ) {
      if (!validDestination(alias)) {
        return yield* new TransportError({
          alias,
          cause: new Error('an ssh host cannot begin with a dash'),
        });
      }
      const handle = yield* spawner
        .spawn(sshCommand(alias, argv, options))
        .pipe(Effect.mapError((cause) => new TransportError({ alias, cause })));

      // What ssh itself says, as opposed to what the remote command says.
      //
      // With a terminal on the far side the remote command's own output is all
      // on stdout, so this stream carries only ssh's complaints: a channel the
      // far side refused, a host that went away, a warning on the way up.
      // Nothing read it before, which meant every one of those was invisible
      // and could fill its pipe and wedge the session. The last one is kept, so
      // a terminal that closes without printing can say why.
      const trouble = { last: '' };
      yield* Effect.forkScoped(
        handle.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              const line = chunk.trim();
              if (line !== '') trouble.last = line;
            })
          ),
          Effect.catchCause(() => Effect.void)
        )
      );

      // Input goes through a queue rather than straight at the sink, because a
      // sink is consumed once and keystrokes arrive whenever the person types.
      // The queue is the one long-lived producer that stdin gets.
      const outbox = yield* Queue.unbounded<Uint8Array>();
      yield* Effect.forkScoped(
        Stream.fromQueue(outbox).pipe(Stream.run(handle.stdin), Effect.catchCause(() => Effect.void))
      );

      const encoder = new TextEncoder();

      return {
        // With a terminal on the far side the remote command's own stderr is
        // already interleaved into it, so stdout is the whole stream.
        output: handle.stdout.pipe(
          Stream.decodeText(),
          Stream.mapError((cause) => new TransportError({ alias, cause }))
        ),
        write: (data: string) =>
          Queue.offer(outbox, encoder.encode(data)).pipe(Effect.asVoid),
        complaint: () => trouble.last,
      } satisfies CommandSession;
    });

    const forward = Effect.fnUntraced(function* (alias: string, wanted: PortForward) {
      if (!validDestination(alias) || !validForward(wanted)) {
        return yield* new TransportError({
          alias,
          cause: new Error('that forward does not name a host and two ports'),
        });
      }
      const handle = yield* spawner
        .spawn(forwardCommand(alias, wanted))
        .pipe(Effect.mapError((cause) => new TransportError({ alias, cause })));

      // Drain what ssh says about itself so a warning cannot fill the pipe and
      // wedge the forward.
      yield* Effect.forkScoped(
        handle.stderr.pipe(Stream.runDrain, Effect.catchCause(() => Effect.void))
      );

      yield* waitForPort(wanted.localPort).pipe(
        Effect.timeoutOption(FORWARD_READY_TIMEOUT_MS),
        // A forward that never comes up is left to the caller to notice: the
        // thing behind it will not answer, and that is the honest report.
        Effect.asVoid
      );
    });

    const upload = Effect.fnUntraced(function* (
      alias: string,
      name: string,
      bytes: Uint8Array
    ) {
      if (!validDestination(alias)) {
        return yield* new TransportError({
          alias,
          cause: new Error('an ssh host cannot begin with a dash'),
        });
      }

      const handle = yield* spawner
        .spawn(sshCommand(alias, ['sh', '-c', uploadScript(safeName(name))]))
        .pipe(Effect.mapError((cause) => new TransportError({ alias, cause })));

      // The picture goes in as the remote `cat`'s standard input, which is the
      // one way to hand over bytes that cannot be read as anything else. The
      // path it landed at comes back on standard output, in the remote shell's
      // own words, because only that shell knows where its cache is.
      const [, said, complained] = yield* Effect.all(
        [
          Stream.fromArray([bytes]).pipe(Stream.run(handle.stdin)),
          handle.stdout.pipe(Stream.decodeText(), Stream.take(ERROR_CHUNK_LIMIT), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.take(ERROR_CHUNK_LIMIT), Stream.mkString),
        ],
        { concurrency: 3 }
      ).pipe(Effect.mapError((cause) => new TransportError({ alias, cause })));

      const code = yield* handle.exitCode.pipe(
        Effect.mapError((cause) => new TransportError({ alias, cause }))
      );

      const path = said.trim().split('\n').pop()?.trim() ?? '';
      if (Number(code) !== 0 || path === '') {
        return yield* new TransportError({
          alias,
          cause: new Error(
            complained.trim().split('\n')[0] ?? 'the machine would not take the file'
          ),
        });
      }
      return path;
    });

    return CommandRunner.of({
      run: (alias, argv) => Effect.scoped(execute(alias, argv)),
      session,
      forward,
      upload: (alias, name, bytes) => Effect.scoped(upload(alias, name, bytes)),
    });
  })
);
