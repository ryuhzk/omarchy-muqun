/**
 * The ports the application talks through.
 *
 * Everything above this file is written against these interfaces and knows
 * nothing about ssh, herdr, tmux, or Ghostty. Everything below implements one
 * of them. This is the seam that lets a tmux host and a herdr host run the same
 * use cases, and lets every use case be tested without a network.
 *
 * The gateway in the Muqun repository draws the same line for the same reason,
 * and calls its version `TerminalBackend`.
 */

import { Context, Effect, Schema, Stream, type Scope } from 'effect';
import type { Capability } from '../domain/host';
import type { Pane } from '../domain/pane';
import type { Row } from '../domain/screen';
import type {
  SimfarmConfig,
  SimulatorDevice,
  SimulatorStatus,
} from '../domain/simfarm';

/** Where a command on a host ended up. `code` is the remote command's status. */
export class CommandResult extends Schema.Class<CommandResult>('muqun/CommandResult')({
  stdout: Schema.String,
  stderr: Schema.String,
  code: Schema.Number,
}) {
  get ok(): boolean {
    return this.code === 0;
  }

  /** The first non-empty line of stderr, for showing a person what broke. */
  get firstError(): string {
    return this.stderr.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
  }

  /**
   * Whether this failed because the host could not be reached, rather than
   * because the command itself was unhappy.
   *
   * The panel says different things for the two. ssh reserves 255 for its own
   * failures; the text matches cover the hosts whose shell exits 255 for
   * reasons of its own.
   */
  get unreachable(): boolean {
    if (this.code === 0) return false;
    const text = this.stderr.toLowerCase();
    return (
      this.code === 255 ||
      text.includes('connection refused') ||
      text.includes('could not resolve') ||
      text.includes('no route to host') ||
      text.includes('connection timed out') ||
      text.includes('operation timed out') ||
      text.includes('permission denied')
    );
  }
}

/** The transport itself failed. A non-zero remote exit is a `CommandResult`. */
export class TransportError extends Schema.TaggedError<TransportError>()('TransportError', {
  alias: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A tool answered, but not with something this plugin can read. */
export class SourceError extends Schema.TaggedError<SourceError>()('SourceError', {
  alias: Schema.String,
  command: Schema.String,
  message: Schema.String,
}) {}

/**
 * Running a command on a host.
 *
 * A command that blocks needs nothing special: the child belongs to the calling
 * fiber's scope, so interrupting the fiber kills it, and a caller that wants a
 * deadline says so with `Effect.timeout`.
 */
export class CommandRunner extends Context.Service<
  CommandRunner,
  {
    run(
      alias: string,
      argv: ReadonlyArray<string>
    ): Effect.Effect<CommandResult, TransportError>;
    /**
     * A command that stays open, with a writable stdin.
     *
     * This is what makes an attached pane feel like being logged in. A
     * keystroke becomes a write to a pipe that is already open rather than a
     * fresh ssh connection, so what it costs is one network trip and not a
     * handshake.
     *
     * Scoped: leaving the scope closes stdin and kills the remote command.
     */
    session(
      alias: string,
      argv: ReadonlyArray<string>,
      options?: SessionOptions
    ): Effect.Effect<CommandSession, TransportError, Scope.Scope>;
    /**
     * Hold a port forward open for as long as the scope lives.
     *
     * The one thing here that carries no command. Some things on the far side
     * are reached over HTTP rather than by running something -- simfarm streams
     * video to a browser -- and a browser will only turn on its decoder for a
     * secure origin, which loopback counts as and a plain remote address does
     * not.
     */
    forward(alias: string, forward: PortForward): Effect.Effect<void, TransportError, Scope.Scope>;
    /**
     * Put a file on the host, and answer with the path it landed at.
     *
     * The one thing this plugin writes to a machine it did not bring up, and it
     * writes it only because someone pasted a picture at an agent that can only
     * read one from a path. It goes into a directory of this plugin's own
     * making, owner-only, under the remote user's cache; the name is built
     * here and never taken from the file.
     */
    upload(
      alias: string,
      name: string,
      bytes: Uint8Array
    ): Effect.Effect<string, TransportError>;
  }
>()('muqun/CommandRunner') {}

/**
 * The desktop clipboard, as one of three things.
 *
 * A port because reading it means running a program, and because what the
 * panel does with a paste depends on which of the three it turns out to be.
 */
export class Clipboard extends Context.Service<
  Clipboard,
  {
    read(): Effect.Effect<ClipboardContent>;
  }
>()('muqun/Clipboard') {}

export type ClipboardContent =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'image';
      readonly bytes: Uint8Array;
      /** Without the dot, and always one this build chose. */
      readonly extension: string;
    }
  | { readonly kind: 'empty' };

export interface PortForward {
  readonly localPort: number;
  readonly remoteHost: string;
  readonly remotePort: number;
}

export interface SessionOptions {
  /**
   * Ask for a terminal on the far side.
   *
   * Without it the remote command gets a pipe, and a program that checks
   * whether it is talking to a terminal will behave as though it is being
   * redirected to a file: no colour, no cursor, no full-screen drawing. With
   * it the command gets a real pty and behaves exactly as it does when you log
   * in, which is the whole point of attaching.
   */
  readonly pty?: boolean;
}

export interface CommandSession {
  readonly output: Stream.Stream<string, TransportError>;
  write(data: string): Effect.Effect<void>;
  /**
   * The last thing the transport itself said, as opposed to the remote command.
   *
   * A terminal that opens and closes without printing anything has a reason,
   * and the reason is on this channel rather than in the output. Empty when
   * there was no trouble.
   */
  complaint(): string;
}

/**
 * A terminal workspace on a host, whatever manages it.
 *
 * `waitForAgent` is the one method that is not a request. It blocks until that
 * agent stops making progress on its own, which is what lets the panel change
 * the moment something needs a human instead of at the next poll. A source
 * whose tool cannot do that answers by never completing, and the caller's own
 * idle timer covers it.
 */
/**
 * What every terminal source can do.
 *
 * Named on its own because a host is not one source: a machine may have herdr,
 * or tmux, or both, and which one answers for it is decided per host at connect
 * time. Everything above this interface runs the same use cases either way,
 * which is the whole reason it exists.
 */
export interface TerminalSourceApi {
    /** The name this source goes by, for error messages. */
    readonly kind: Capability;
    /** Whether this host has the tool at all. */
    available(alias: string): Effect.Effect<boolean, TransportError>;
    /** Every pane the tool knows about, translated. */
    panes(alias: string): Effect.Effect<ReadonlyArray<Pane>, SourceError | TransportError>;
    /** A pane's visible screen, with SGR colour kept. */
    read(
      alias: string,
      paneId: string,
      lines: number
    ): Effect.Effect<string, SourceError | TransportError>;
    /** Type literal text into a pane. Never interpreted as key names. */
    sendText(
      alias: string,
      paneId: string,
      text: string
    ): Effect.Effect<void, SourceError | TransportError>;
    /** Send named keys, such as `Enter` or `C-c`. */
    sendKeys(
      alias: string,
      paneId: string,
      keys: ReadonlyArray<string>
    ): Effect.Effect<void, SourceError | TransportError>;
    /**
     * Block until one of these agents wants a human, and say which.
     *
     * All of them over one connection, not one each. Every held-open channel
     * costs one of the ten sshd allows per connection, so watching per pane
     * means a busy machine spends its whole allowance on watching and has none
     * left to open a terminal with.
     *
     * Scoped: leaving the scope ends the watch and everything it started.
     */
    waitForAgents(
      alias: string,
      paneIds: ReadonlyArray<string>
    ): Effect.Effect<string, TransportError, Scope.Scope>;
    /**
     * Attach to one pane over a terminal, the way logging in does.
     *
     * `read` and `sendKeys` above are one-shot, which is right for a glance and
     * wrong for sitting in front of a pane: there is no cursor in a snapshot,
     * and a keystroke is not visible until the next read. Attaching holds a
     * terminal open, so the bytes coming back are the ones a terminal is fed
     * and the bytes going out are the ones a keyboard produces.
     *
     * Scoped: leaving the scope detaches and leaves the pane running.
     */
    attach(
      alias: string,
      paneId: string,
      size: TerminalSize,
      options?: AttachOptions
    ): Effect.Effect<AttachedPane, TransportError, Scope.Scope>;
    /** Open a pane beside this one. The far side decides where it goes. */
    splitPane(
      alias: string,
      paneId: string,
      direction: 'right' | 'down'
    ): Effect.Effect<void, SourceError | TransportError>;
    /** Close a pane, and whatever is running in it. */
    closePane(alias: string, paneId: string): Effect.Effect<void, SourceError | TransportError>;
    /**
     * Open a terminal that was not there before, and say what it is called.
     *
     * Optional, because not every source can. herdr's terminals belong to the
     * agents herdr started in them, and a pane it did not start is one it will
     * not hand over; tmux will make a window for anybody. The panel offers the
     * button on a host where something answers this and nowhere else, which is
     * why it is absent rather than failing.
     */
    newPane?(alias: string): Effect.Effect<string, SourceError | TransportError>;
  }


export class TerminalSource extends Context.Service<TerminalSource, TerminalSourceApi>()(
  'muqun/TerminalSource'
) {}

/**
 * Every source this build knows, in the order their panes are listed.
 *
 * A host uses all of the ones it has, not the first. herdr and tmux are
 * separate worlds on the same machine -- herdr runs its own terminals and does
 * not sit on tmux -- so taking only one would hide half of what is running.
 * herdr comes first because its panes are the ones that need an answer.
 */
export class TerminalSources extends Context.Service<
  TerminalSources,
  { readonly all: ReadonlyArray<TerminalSourceApi> }
>()('muqun/TerminalSources') {}

export interface AttachOptions {
  /**
   * Take the terminal from whoever else is attached to it.
   *
   * herdr allows one attached client per agent terminal, so a pane being
   * watched from the machine it runs on refuses a second viewer. Taking it is
   * often exactly what someone at another desk wants, and is never something to
   * do to them without asking, so it is a decision that travels from the panel
   * rather than a default set down here.
   */
  readonly takeover?: boolean;
}

export interface TerminalSize {
  readonly rows: number;
  readonly columns: number;
}

export interface AttachedPane {
  /** Raw terminal output. Escape sequences and all: this is the real stream. */
  readonly output: Stream.Stream<string, TransportError>;
  /** Raw bytes to the terminal, as a keyboard would produce them. */
  write(data: string): Effect.Effect<void>;
  /** What the transport said about itself, if it said anything. */
  complaint(): string;
}

/** Where the cursor is, and whether the far side wants it drawn. */
export interface CursorState {
  readonly row: number;
  readonly column: number;
  readonly visible: boolean;
}

/**
 * A terminal: bytes in, a screen out.
 *
 * The application holds one of these per attached pane and knows nothing about
 * how it works. A port rather than a class because the implementation binds a C
 * library for the parts of the job that are subtle, and a machine without that
 * library must still get a terminal.
 */
export interface Terminal {
  /** Feed raw output. Safe with a sequence split across calls. */
  write(chunk: string): void;
  /** One screenful, at wherever the person has scrolled to. */
  rows(): ReadonlyArray<Row>;
  cursor(): CursorState;
  resize(size: TerminalSize): void;
  /**
   * Put the screen back to how it started, keeping its size.
   *
   * Reattaching is how the far side is told a new shape, and what it sends
   * first is a full redraw that assumes it is drawing on a fresh terminal. Fed
   * to a screen that still holds the last draw, it lands underneath it, and the
   * pane reads as though everything in it happened twice.
   */
  reset(): void;
  /** Scroll by whole rows; positive goes back into history. */
  scrollBy(rows: number): void;
  /** Return to the present, which is what typing does. */
  scrollToBottom(): void;
  readonly atBottom: boolean;
  readonly historyLength: number;
  /** Whether a program has asked to be told about the mouse. */
  readonly mouseTracking: boolean;
  /** Whether it asked for the modern mouse encoding. */
  readonly mouseSgr: boolean;
  /**
   * Whether a program wants pasted text marked as pasted.
   *
   * A shell that has asked for this will not run the lines in a paste until
   * they are confirmed, and an editor will not treat them as keystrokes to act
   * on. Sending a multi-line paste to a program that asked and not telling it
   * is how a paste runs half of itself.
   */
  readonly bracketedPaste: boolean;
  readonly size: TerminalSize;
}

/**
 * A simulator farm, reached over HTTP.
 *
 * A port because reaching it may mean holding a forward open, which is a
 * transport concern, while what the panel wants is a count.
 */
export class Simulators extends Context.Service<
  Simulators,
  {
    /**
     * Hold whatever is needed to reach the farm, for as long as the scope
     * lives.
     *
     * Scoped, because a forward held for a panel nobody has open is a tunnel to
     * a machine nobody is looking at.
     */
    open(config: SimfarmConfig): Effect.Effect<void, TransportError, Scope.Scope>;
    /** What is booted, or null when the farm did not answer. */
    status(config: SimfarmConfig): Effect.Effect<SimulatorStatus | null>;
    /**
     * Watch the farm: its devices, and the picture of one of them.
     *
     * Pictures arrive as files rather than as data in the protocol. A phone
     * screen is a hundred kilobytes and arrives ten times a second; base64
     * through a line protocol would be a megabyte a second of encoding and
     * parsing to move a picture between two processes on the same machine.
     */
    watch(
      config: SimfarmConfig,
      deviceId: string | null
    ): Effect.Effect<SimulatorSession, TransportError, Scope.Scope>;
  }
>()('muqun/Simulators') {}

export interface SimulatorSession {
  readonly updates: Stream.Stream<SimulatorUpdate>;
  /**
   * Act on the device.
   *
   * Input is its own channel in simfarm's protocol, independent of how the
   * picture arrives, so a device is as operable when its frames are JPEG as
   * when they are video. Positions are fractions of the picture, which is why
   * the panel can be any size.
   */
  send(input: SimulatorInput): Effect.Effect<void>;
}

export type SimulatorInput =
  | { readonly kind: 'touch'; readonly phase: 'begin' | 'move' | 'end'; readonly x: number; readonly y: number }
  | { readonly kind: 'key'; readonly phase: 'down' | 'up'; readonly usage: number }
  | { readonly kind: 'button'; readonly phase: 'down' | 'up'; readonly buttonId: number }
  | { readonly kind: 'scroll'; readonly dx: number; readonly dy: number; readonly x: number; readonly y: number }
  | { readonly kind: 'text'; readonly text: string };

export type SimulatorUpdate =
  | { readonly kind: 'devices'; readonly devices: ReadonlyArray<SimulatorDevice> }
  /** The connection went away, or never came up. */
  | { readonly kind: 'closed' }
  | {
      readonly kind: 'frame';
      readonly path: string;
      /** Bumped per frame, so a viewer can tell the file changed. */
      readonly revision: number;
    };

export class TerminalFactory extends Context.Service<
  TerminalFactory,
  {
    create(size: TerminalSize, scrollback?: number): Terminal;
  }
>()('muqun/TerminalFactory') {}
