/**
 * The use cases: what the plugin does, in terms of the ports.
 *
 * Nothing here knows about ssh, herdr, JSON lines, or QML. It knows that hosts
 * are probed, that panes are watched, and that a watch returning means the
 * panel should be told something changed.
 */

import { Cause, Context, Effect, Fiber, Layer, Queue, Schedule, Stream } from 'effect';
import { attentionCount, connectingHost, type Capability, type Host } from '../domain/host';
import { isAgentPane, type Pane } from '../domain/pane';
import type { Row } from '../domain/screen';
import { browserUrl, type SimfarmConfig, type SimulatorDevice } from '../domain/simfarm';
import {
  FRAME_INTERVAL_MS,
  keyToBytes,
  MOUSE_BUTTON,
  mouseBytes,
  wheelBytes,
} from './attached-terminal';
import {
  Clipboard,
  CommandRunner,
  Simulators,
  type SimulatorInput,
  TerminalFactory,
  TerminalSources,
  type TerminalSourceApi,
  type CursorState,
  type Terminal,
  type TerminalSize,
} from './ports';

/** What the panel is told. */
export type Change =
  | { readonly type: 'hosts'; readonly hosts: ReadonlyArray<Host>; readonly attention: number }
  | {
      readonly type: 'screen';
      readonly alias: string;
      readonly paneId: string;
      readonly rows: ReadonlyArray<Row>;
      readonly cursor: CursorState;
    }
  | { readonly type: 'error'; readonly alias: string; readonly message: string }
  | {
      readonly type: 'simulators';
      readonly devices: ReadonlyArray<SimulatorDevice>;
      /** The address a browser may open, which is not always the one given. */
      readonly openUrl: string;
    }
  | {
      readonly type: 'simulatorFrame';
      readonly path: string;
      readonly revision: number;
    }
  | { readonly type: 'simulatorsUnreachable' };

/**
 * How often a host is re-read when nothing has told us it changed.
 *
 * The blocking agent watch covers the case that matters, so this is only a net
 * for what it cannot see: a pane opened by hand, a title change, a host that
 * came back. Long on purpose, and longer now that it no longer takes the watch
 * down with it every time it fires.
 */
const IDLE_REFRESH_MS = 60_000;

/** A probe or refresh that hangs must not wedge a host's whole fiber. */
const COMMAND_TIMEOUT_MS = 20_000;

/**
 * The most wheel notches one gesture sends onward.
 *
 * A touchpad can report a large delta in one event, and a program reading a
 * hundred notches at once jumps somewhere nobody asked for.
 */
const MAX_WHEEL_NOTCHES = 5;

/** What surrounds a paste for a program that asked to be told about pastes. */
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/**
 * How often the simulator strip asks the farm what is booted.
 *
 * Only while it is open. Booting a simulator takes tens of seconds, so there is
 * nothing to see between these.
 */
const SIMULATOR_POLL_MS = 15_000;

/**
 * What a refusal on the terminal means, in words.
 *
 * herdr attaches to an agent's terminal, and a pane that is not running an
 * agent -- an editor, a shell, a server -- has none to attach to. That is a
 * real limit of what it offers, not a fault, and the panel should say which.
 */
function refusalIn(chunk: string): string | null {
  if (/agent_not_found|agent target .* not found/i.test(chunk)) {
    return 'herdr can only open a terminal on a pane running an agent. '
      + 'This one is not, so there is nothing to attach to.';
  }
  if (/already has an attached client/i.test(chunk)) {
    return 'Another client holds this terminal and would not give it up.';
  }
  return null;
}

export interface HostEntry {
  readonly alias: string;
  readonly label?: string;
}

const makeRegistry = Effect.gen(function* () {
  const sources = yield* TerminalSources;
  const clipboard = yield* Clipboard;
  const runner = yield* CommandRunner;
  const simulators = yield* Simulators;
  const terminals = yield* TerminalFactory;
  const changes = yield* Queue.unbounded<Change>();

  // One mutable map rather than a `SubscriptionRef`, because there is exactly
  // one consumer and it wants a whole snapshot whenever anything moves, not a
  // stream of deltas to reassemble.
  const hosts = new Map<string, Host>();
  const supervisors = new Map<string, Fiber.Fiber<void, never>>();

  const publish = Effect.suspend(() => {
    const all = [...hosts.values()];
    return Queue.offer(changes, {
      type: 'hosts' as const,
      hosts: all,
      attention: attentionCount(all),
    }).pipe(Effect.asVoid);
  });

  const patch = (alias: string, change: Partial<Host>): Effect.Effect<void> =>
    Effect.suspend(() => {
      const current = hosts.get(alias);
      if (!current) return Effect.void;
      hosts.set(alias, { ...current, ...change });
      return publish;
    });

  const report = (alias: string, error: unknown): Effect.Effect<void> =>
    Queue.offer(changes, {
      type: 'error' as const,
      alias,
      message: error instanceof Error ? error.message : String(error),
    }).pipe(Effect.asVoid);

  /**
   * Which sources answer for a host. All of the ones it has, not one.
   *
   * herdr and tmux are two separate worlds on the same machine: herdr runs its
   * own terminals and does not sit on tmux, so a pane in one is invisible to
   * the other. Taking only the first hid half of what was running and left the
   * panel with rows it could not open.
   */
  const usable = new Map<string, ReadonlyArray<TerminalSourceApi>>();

  const sourcesFor = (alias: string): ReadonlyArray<TerminalSourceApi> => usable.get(alias) ?? [];

  const sourceOfKind = (alias: string, kind: Capability): TerminalSourceApi | null =>
    sourcesFor(alias).find((source) => source.kind === kind) ?? null;

  /**
   * The source that owns a pane.
   *
   * Taken from the pane itself. Every pane carries the name of the tool that
   * described it, so routing is a lookup rather than a guess, and a herdr agent
   * and a tmux window can sit next to each other in the same list.
   */
  const sourceForPane = (alias: string, paneId: string): TerminalSourceApi | null => {
    const pane = hosts.get(alias)?.panes.find((candidate) => candidate.id === paneId);
    return pane === undefined ? null : sourceOfKind(alias, pane.source);
  };

  /** Ask the host what it has, and remember every source it can offer. */
  const probe = Effect.fnUntraced(function* (alias: string) {
    const found: Array<TerminalSourceApi> = [];

    for (const candidate of sources.all) {
      const present = yield* candidate
        .available(alias)
        .pipe(Effect.timeout(COMMAND_TIMEOUT_MS), Effect.catch(() => Effect.succeed(false)));
      if (present) found.push(candidate);
    }

    const capabilities: Array<Capability> = found.map((source) => source.kind);

    if (found.length === 0) {
      yield* patch(alias, {
        capabilities,
        state: 'error',
        error: 'this host has neither herdr nor tmux',
      });
      return false;
    }

    usable.set(alias, found);
    yield* patch(alias, { capabilities });
    return true;
  });

  /**
   * Every pane on the host, from every source it has.
   *
   * A source that fails is skipped rather than fatal, because one of two tools
   * being unhappy should not empty a list the other one filled. Only when
   * nothing answered at all does the host say so.
   */
  const refresh = Effect.fnUntraced(function* (alias: string) {
    const list = sourcesFor(alias);
    if (list.length === 0) return [] as ReadonlyArray<Pane>;

    const collected: Array<Pane> = [];
    let failure: string | null = null;

    for (const source of list) {
      const panes = yield* source.panes(alias).pipe(
        Effect.timeout(COMMAND_TIMEOUT_MS),
        Effect.catch((error) =>
          Effect.sync(() => {
            failure = error instanceof Error ? error.message : String(error);
            return [] as ReadonlyArray<Pane>;
          })
        )
      );
      collected.push(...panes);
    }

    if (collected.length === 0 && failure !== null) {
      yield* patch(alias, { panes: [], state: 'error', error: failure });
      return [] as ReadonlyArray<Pane>;
    }

    yield* patch(alias, { panes: collected, state: 'ready', error: undefined });
    return collected;
  });

  /**
   * Watch every agent pane on a host and re-read when any of them stops.
   *
   * Racing the watches means the first to return wins and the rest are
   * interrupted, which kills their remote commands because each is scoped to
   * its own fiber. The loop then re-reads and re-arms against whatever the
   * topology has become, so a pane that disappeared simply stops being watched.
   *
   * The idle timer is one of the racers, so a host with no agents still
   * refreshes and a host full of them still catches what the watches cannot
   * see.
   */
  const supervise = Effect.fnUntraced(function* (alias: string) {
    const usable = yield* probe(alias).pipe(
      Effect.catch((error) =>
        report(alias, error).pipe(
          Effect.andThen(
            patch(alias, { state: 'offline', error: 'could not reach this host' })
          ),
          Effect.as(false)
        )
      )
    );
    if (!usable) return;

    /**
     * The watch that is up, and which agents it was armed for.
     *
     * Kept across refreshes. The loop used to tear the watch down and build it
     * again every time the idle timer went off, which meant a connection, a
     * remote shell and one blocking `herdr agent wait` per agent, twice a
     * minute, for as long as the panel was loaded -- all of it thrown away and
     * remade to arrive at the same answer. Now it is remade only when the set
     * of agents is genuinely different.
     */
    let watcher: Fiber.Fiber<void, never> | null = null;
    let armed = '';

    while (true) {
      const panes: ReadonlyArray<Pane> = yield* refresh(alias).pipe(
        Effect.catch((error) =>
          report(alias, error).pipe(
            Effect.andThen(patch(alias, { state: 'error', error: String(error) })),
            Effect.as([] as ReadonlyArray<Pane>)
          )
        )
      );

      // One watch per source that has agents. A source with none sits out
      // rather than holding a connection open to say nothing.
      const wanted = sourcesFor(alias)
        .map((source) => ({
          source,
          agents: panes
            .filter((pane) => pane.source === source.kind && isAgentPane(pane))
            .map((pane) => pane.id)
            .sort(),
        }))
        .filter((entry) => entry.agents.length > 0);

      const signature = wanted
        .map((entry) => `${entry.source.kind}:${entry.agents.join(',')}`)
        .join('|');

      if (signature !== armed) {
        if (watcher !== null) yield* Fiber.interrupt(watcher);
        watcher = null;
        armed = signature;

        if (signature !== '') {
          watcher = yield* Effect.forkScoped(
            Effect.raceAll(
              wanted.map((entry) =>
                Effect.scoped(entry.source.waitForAgents(alias, entry.agents))
              )
            ).pipe(
              Effect.asVoid,
              Effect.catchCause(() => Effect.void)
            )
          );
        }
      }

      // Whichever comes first: an agent stopping, or the timer that covers what
      // a watch cannot see -- a pane opened by hand, a title changed. Awaiting
      // a fiber only observes it, so a timer that wins leaves the watch up.
      const current = watcher;
      let stopped = false;
      if (current === null) {
        yield* Effect.sleep(IDLE_REFRESH_MS);
      } else {
        stopped = yield* Effect.raceAll([
          Fiber.await(current).pipe(Effect.as(true)),
          Effect.sleep(IDLE_REFRESH_MS).pipe(Effect.as(false)),
        ]).pipe(Effect.catch(() => Effect.succeed(false)));
      }

      // A watch that returned has said its piece and is spent; the next turn
      // of the loop arms a new one against whatever the refresh finds.
      if (stopped && current !== null) {
        yield* Fiber.interrupt(current);
        watcher = null;
        armed = '';
      }
    }
  });

  const setHosts = Effect.fnUntraced(function* (entries: ReadonlyArray<HostEntry>) {
    const wanted = new Map(
      entries.filter((entry) => entry.alias.trim() !== '').map((entry) => [entry.alias, entry])
    );

    for (const [alias, fiber] of supervisors) {
      if (wanted.has(alias)) continue;
      yield* Fiber.interrupt(fiber);
      supervisors.delete(alias);
      hosts.delete(alias);
    }

    for (const [alias, entry] of wanted) {
      if (supervisors.has(alias)) continue;
      hosts.set(alias, connectingHost(alias, entry.label));
      // Forked into the service's own scope, so shutting down interrupts every
      // host and every remote command underneath it.
      const fiber = yield* Effect.forkScoped(
        supervise(alias).pipe(Effect.catchCause(() => Effect.void))
      );
      supervisors.set(alias, fiber);
    }

    yield* publish;
  });

  const guard = (alias: string, work: Effect.Effect<void, unknown>): Effect.Effect<void> =>
    work.pipe(Effect.catch((error) => report(alias, error)));

  /**
   * The simulator strip, open or closed.
   *
   * Nothing is held while it is closed. A forward to a machine nobody is
   * looking at is a tunnel with no reader, and the whole reason this is scoped
   * is so that closing the strip takes it down.
   */
  let simfarmFiber: Fiber.Fiber<void, never> | null = null;
  let simfarmSend: ((input: SimulatorInput) => Effect.Effect<void>) | null = null;

  /**
   * Watch the farm, and one device on it.
   *
   * Called again with a different device to switch, and with no config to close
   * the strip. Each call replaces the last, so there is one socket and at most
   * one forward, for as long as someone is looking.
   */
  const watchSimulators = Effect.fnUntraced(function* (
    config: SimfarmConfig | null,
    deviceId: string | null
  ) {
    if (simfarmFiber !== null) {
      yield* Fiber.interrupt(simfarmFiber);
      simfarmFiber = null;
      simfarmSend = null;
    }
    if (config === null || config.url === '') return;

    simfarmFiber = yield* Effect.forkScoped(
      Effect.scoped(
        Effect.gen(function* () {
          yield* simulators.open(config);
          const session = yield* simulators.watch(config, deviceId);
          simfarmSend = session.send;

          yield* session.updates.pipe(
            Stream.runForEach((update) => {
              if (update.kind === 'devices') {
                return Queue.offer(changes, {
                  type: 'simulators' as const,
                  devices: update.devices,
                  openUrl: browserUrl(config),
                }).pipe(Effect.asVoid);
              }
              if (update.kind === 'closed') {
                return Queue.offer(changes, {
                  type: 'simulatorsUnreachable' as const,
                }).pipe(Effect.asVoid);
              }
              return Queue.offer(changes, {
                type: 'simulatorFrame' as const,
                path: update.path,
                revision: update.revision,
              }).pipe(Effect.asVoid);
            })
          );
        })
      ).pipe(
        Effect.andThen(Queue.offer(changes, { type: 'simulatorsUnreachable' as const })),
        Effect.asVoid,
        Effect.catchCause(() =>
          Queue.offer(changes, { type: 'simulatorsUnreachable' as const }).pipe(Effect.asVoid)
        )
      )
    );
  });

  /**
   * The pane the person is sitting in front of.
   *
   * One at a time. Attaching to another detaches this one, which is what a
   * person means by moving to another pane, and it keeps the number of open
   * terminals equal to the number of things being looked at.
   */
  let attached: {
    alias: string;
    paneId: string;
    terminal: Terminal;
    write(data: string): Effect.Effect<void>;
  } | null = null;
  let attachedFiber: Fiber.Fiber<void, never> | null = null;

  /**
   * Whether the attached screen has changed since it was last sent.
   *
   * Set by everything that changes it and read by one timer, so a burst of
   * changes costs one picture rather than one each. Output already worked this
   * way; scrolling did not, and a wheel gesture that moves five rows sent five
   * whole screens down the pipe in as many milliseconds, which is what made
   * scrolling feel like it was replaying rather than moving.
   */
  let dirty = false;

  /**
   * The pane being opened, and anything typed while it opens.
   *
   * Reopening is not rare: it is how the far side is told the window changed
   * shape, because a pty's size is fixed when it is opened. Between the old
   * connection going down and the new one coming up there is nothing to write
   * to, and dropping those keystrokes is exactly what "it stopped taking input"
   * looks like from the outside. They wait here instead.
   */
  let opening: { token: number; alias: string; paneId: string } | null = null;
  let attempts = 0;
  let queued = '';

  const writeTo = (data: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (data === '') return Effect.void;
      if (attached !== null) return attached.write(data);
      if (opening === null) return Effect.void;
      queued += data;
      return Effect.void;
    });

  const publishScreen = Effect.suspend(() => {
    if (attached === null) return Effect.void;
    return Queue.offer(changes, {
      type: 'screen' as const,
      alias: attached.alias,
      paneId: attached.paneId,
      rows: attached.terminal.rows(),
      cursor: attached.terminal.cursor(),
    }).pipe(Effect.asVoid);
  });

  /**
   * Attach to a pane, taking the terminal if something else holds it.
   *
   * herdr allows one attached client per agent terminal, so a pane left open on
   * the machine it runs on would refuse a second viewer. Taking it is what
   * someone at another desk means by opening it: they are here, not there.
   */
  const attachPane = Effect.fnUntraced(function* (
    alias: string,
    paneId: string,
    size: TerminalSize,
    /**
     * Keep the screen that is already there.
     *
     * Re-attaching is how the far side is told the window changed shape, and a
     * resize should not look like anything happened. Handing the same terminal
     * back means the text stays put while the pty is reopened behind it,
     * instead of the window blanking every time a panel slides in beside it.
     */
    keepScreen = false
  ) {
    const carried =
      keepScreen && attached !== null && attached.alias === alias && attached.paneId === paneId
        ? attached.terminal
        : null;

    if (attachedFiber !== null) {
      yield* Fiber.interrupt(attachedFiber);
      attachedFiber = null;
      attached = null;
    }

    const attempt = ++attempts;
    opening = { token: attempt, alias, paneId };

    attachedFiber = yield* Effect.forkScoped(
      Effect.scoped(
        Effect.gen(function* () {
          const source = sourceForPane(alias, paneId);
          if (source === null) {
            if (opening?.token === attempt) opening = null;
            queued = '';
            // Said rather than swallowed. A pane whose tool is not on this host
            // any more is a real situation, and the panel otherwise sits on
            // "opening" with nothing to show and nothing to say.
            return yield* report(
              alias,
              new Error('this pane belongs to a tool this host is no longer offering')
            );
          }
          const terminal = carried ?? terminals.create(size);
          if (carried !== null) carried.resize(size);
          const pane = yield* source.attach(alias, paneId, size, { takeover: true });
          attached = { alias, paneId, terminal, write: pane.write };

          // Whatever was typed while this was opening, now that there is
          // somewhere to put it.
          if (opening?.token === attempt) opening = null;
          if (queued !== '') {
            const waiting = queued;
            queued = '';
            yield* pane.write(waiting);
          }

          // Output is coalesced rather than drawn as it arrives. A program
          // clearing and redrawing produces a burst of writes that are one
          // picture; drawing each would flicker and would spend the frame on
          // pictures nobody sees.
          dirty = false;
          yield* Effect.forkScoped(
            Effect.repeat(
              Effect.suspend(() => {
                if (!dirty) return Effect.void;
                dirty = false;
                return publishScreen;
              }),
              { schedule: Schedule.spaced(FRAME_INTERVAL_MS) }
            )
          );

          // herdr answers a refusal on the terminal rather than with an exit
          // status, so it arrives as output. Reported once, in words, because
          // otherwise the panel sits on "opening" for as long as it is left
          // there and never says what is wrong.
          let explained = false;
          let printed = false;
          // A carried screen still holds the last draw, and what arrives first
          // from a reattach is a full redraw that assumes an empty terminal.
          // Cleared on the first byte rather than before it, so the pane stays
          // readable in the gap instead of blinking empty.
          let carriedStill = carried !== null;

          yield* pane.output.pipe(
            Stream.runForEach((chunk) =>
              Effect.suspend(() => {
                printed = true;
                if (carriedStill) {
                  carriedStill = false;
                  terminal.reset();
                }
                terminal.write(chunk);
                dirty = true;
                if (explained) return Effect.void;
                const refusal = refusalIn(chunk);
                if (refusal === null) return Effect.void;
                explained = true;
                return report(alias, new Error(refusal));
              })
            )
          );

          // A terminal that opened and closed without printing one byte did not
          // open. Saying so is the difference between a panel that is waiting
          // and a panel that has given up without mentioning it.
          if (!printed) {
            const said = pane.complaint();
            yield* report(
              alias,
              new Error(
                said === ''
                  ? `${source.kind} would not open this pane`
                  : `${source.kind} would not open this pane: ${said}`
              )
            );
          }
        })
      ).pipe(
        Effect.catch((error) => report(alias, error)),
        // A defect is a bug in this file, not a remote failure, and swallowing
        // it left the panel waiting on a terminal that was never opened with
        // nothing anywhere saying why. Interruption is not a defect: it is how
        // one attach replaces another, and it is the normal end of this fiber.
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : report(alias, new Error(Cause.pretty(cause).split('\n').slice(0, 3).join(' ')))
        ),
        // However this ends -- opened, failed, or interrupted by the next
        // attach -- nothing may be left waiting to be typed into it. Only this
        // attempt's own claim is released, so the one that replaced it keeps
        // whatever was typed while it was starting.
        Effect.ensuring(
          Effect.sync(() => {
            if (opening?.token !== attempt) return;
            opening = null;
            queued = '';
          })
        )
      )
    );
  });

  return {
    changes,

    setHosts,

    refreshOne: (alias: string) => guard(alias, refresh(alias).pipe(Effect.asVoid)),

    refreshAll: Effect.suspend(() =>
      Effect.forEach(
        [...hosts.keys()],
        (alias) => guard(alias, refresh(alias).pipe(Effect.asVoid)),
        { concurrency: 'unbounded', discard: true }
      )
    ),

    watchSimulators,

    /** Act on the simulator that is showing. */
    simulatorInput: (input: SimulatorInput) =>
      Effect.suspend(() => (simfarmSend === null ? Effect.void : simfarmSend(input))),

    attach: (alias: string, paneId: string, size: TerminalSize) =>
      attachPane(alias, paneId, size),

    /**
     * Let go of whatever is attached, leaving it running.
     *
     * What the panel does when its window closes. The pane carries on, the
     * channel is given back, and a herdr terminal returns to whoever else was
     * in front of it. The watch that counts agents is separate and stays, which
     * is what keeps the number on the bar right while the window is shut.
     */
    detach: Effect.suspend(() => {
      if (attachedFiber === null) return Effect.void;
      const fiber = attachedFiber;
      attachedFiber = null;
      attached = null;
      opening = null;
      queued = '';
      return Fiber.interrupt(fiber).pipe(Effect.asVoid);
    }),

    /**
     * Open a terminal on a host and sit down in front of it.
     *
     * The first source that can make one gets to. Nothing on a machine has to
     * be arranged in advance for this to work, which is what makes the panel a
     * place to do something rather than only a place to watch.
     */
    newTerminal: (alias: string, size: TerminalSize, command?: string) =>
      Effect.suspend(() => {
        const source = sourcesFor(alias).find((candidate) => candidate.newPane !== undefined);
        const make = source?.newPane;
        if (source === undefined || make === undefined) return Effect.void;
        // Not wrapped in `guard`: attaching forks into the service's scope, so
        // this effect carries one, and reporting is done here instead.
        return make.call(source, alias).pipe(
          Effect.andThen((paneId) =>
            refresh(alias).pipe(
              Effect.andThen(paneId === '' ? Effect.void : attachPane(alias, paneId, size)),
              // Typed into the pane rather than into the terminal this end just
              // attached to. The pane exists the moment it is made and holds
              // what is sent to it; the attachment is still opening, and a
              // command sent down a pipe that is not up yet is a command that
              // was never run.
              Effect.andThen(
                paneId === '' || command === undefined || command === ''
                  ? Effect.void
                  : source.sendText(alias, paneId, `${command}\n`)
              )
            )
          ),
          Effect.asVoid,
          Effect.catch((error) => report(alias, error))
        );
      }),

    /** Whether this host can make a terminal that was not there before. */
    canOpenTerminal: (alias: string) =>
      sourcesFor(alias).some((candidate) => candidate.newPane !== undefined),

    /**
     * Open a pane beside the one being watched, and watch the host again so it
     * appears in the list. The far side decides where it goes.
     */
    splitPane: (direction: 'right' | 'down') =>
      Effect.suspend(() => {
        if (attached === null) return Effect.void;
        const { alias, paneId } = attached;
        const source = sourceForPane(alias, paneId);
        if (source === null) return Effect.void;
        return guard(
          alias,
          source.splitPane(alias, paneId, direction).pipe(
            Effect.andThen(refresh(alias)),
            Effect.asVoid
          )
        );
      }),

    /**
     * Close a named pane, whether or not it is the one being watched.
     *
     * Letting go of it first when it is: killing a pane out from under an
     * attached terminal leaves the terminal reading a pipe that will never say
     * anything again.
     */
    closeNamedPane: (alias: string, paneId: string) =>
      Effect.suspend(() => {
        const source = sourceForPane(alias, paneId);
        if (source === null) return Effect.void;
        const watching =
          attached !== null && attached.alias === alias && attached.paneId === paneId;
        const letGo =
          watching && attachedFiber !== null
            ? Effect.suspend(() => {
                const fiber = attachedFiber;
                attachedFiber = null;
                attached = null;
                opening = null;
                queued = '';
                return fiber === null ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.asVoid);
              })
            : Effect.void;
        return letGo.pipe(
          Effect.andThen(
            guard(
              alias,
              source.closePane(alias, paneId).pipe(Effect.andThen(refresh(alias)), Effect.asVoid)
            )
          )
        );
      }),

    /**
     * Close the pane being watched.
     *
     * It takes whatever is running in it, which is why nothing here does it
     * quietly: the panel asks first.
     */
    closePane: Effect.suspend(() => {
      if (attached === null) return Effect.void;
      const { alias, paneId } = attached;
      const source = sourceForPane(alias, paneId);
      if (source === null) return Effect.void;
      return guard(
        alias,
        source.closePane(alias, paneId).pipe(Effect.andThen(refresh(alias)), Effect.asVoid)
      );
    }),

    /**
     * Type into whatever is attached.
     *
     * Doing nothing when nothing is attached is right: the panel can type
     * before the attachment has finished opening, and a keystroke that arrives
     * a moment early is not an error worth showing anyone.
     */
    typeText: (text: string) =>
      Effect.suspend(() => {
        // Typing returns you to the present. Every terminal does this, and a
        // panel that left you reading history while your keystrokes went
        // somewhere you could not see would be worse than one that scrolled.
        if (attached !== null) attached.terminal.scrollToBottom();
        return writeTo(text);
      }),

    /**
     * Put text in as though it were pasted, which is not the same as typed.
     *
     * A program that asked for bracketed paste is told where the paste begins
     * and ends, so a shell can offer to run it rather than running each line as
     * it arrives. One that did not ask gets the text plainly, which is what a
     * terminal has always done.
     */
    pasteText: (text: string) =>
      Effect.suspend(() => {
        if (text === '') return Effect.void;
        if (attached !== null) attached.terminal.scrollToBottom();
        const bracketed = attached !== null && attached.terminal.bracketedPaste;
        return writeTo(bracketed ? `${PASTE_START}${text}${PASTE_END}` : text);
      }),

    /**
     * Paste whatever the desktop clipboard is holding.
     *
     * Text is typed. A picture cannot be: an agent reads a picture from a path,
     * and the path has to mean something on the machine the agent is running
     * on, so the picture goes there first and the pane is handed where it
     * landed. That is the only file this plugin writes to a machine, and it is
     * written because somebody pasted it.
     *
     * Only pictures. A clipboard holding anything else is text or nothing.
     */
    pasteClipboard: Effect.suspend(() => {
      if (attached === null && opening === null) return Effect.void;
      const target = attached?.alias ?? opening?.alias ?? '';

      return clipboard.read().pipe(
        Effect.andThen((content) => {
          if (content.kind === 'empty') return Effect.void;

          if (content.kind === 'text') {
            if (attached !== null) attached.terminal.scrollToBottom();
            const bracketed = attached !== null && attached.terminal.bracketedPaste;
            return writeTo(
              bracketed ? `${PASTE_START}${content.text}${PASTE_END}` : content.text
            );
          }

          // A name of this plugin's making: when it was pasted, and what it
          // turned out to be. Nothing from the clipboard is in it.
          const name = `paste-${Date.now()}.${content.extension}`;
          return runner.upload(target, name, content.bytes).pipe(
            Effect.andThen((path) => writeTo(`${path} `)),
            Effect.catch((error) => report(target, error))
          );
        })
      );
    }),

    pressKeys: (keys: ReadonlyArray<string>) =>
      Effect.suspend(() => {
        const bytes = keys.map(keyToBytes).join('');
        if (bytes === '') return Effect.void;
        if (attached !== null) attached.terminal.scrollToBottom();
        return writeTo(bytes);
      }),

    /**
     * A click on the pane.
     *
     * Only reaches the far side when a program is tracking the mouse: those are
     * the programs with something to click, and an agent's "jump to bottom" is
     * one of them. When nothing is tracking, a click is just where the keyboard
     * should point, which the panel has already done.
     *
     * Answered with whether it was forwarded, so the panel can tell a click
     * that did something from one that did not.
     */
    click: (column: number, row: number, pressed: boolean) =>
      Effect.suspend(() => {
        if (attached === null || !attached.terminal.mouseTracking) return Effect.succeed(false);
        const bytes = mouseBytes(
          MOUSE_BUTTON.left,
          column,
          row,
          pressed,
          attached.terminal.mouseSgr
        );
        return bytes === '' ? Effect.succeed(false) : attached.write(bytes).pipe(Effect.as(true));
      }),

    /**
     * A wheel notch over the pane.
     *
     * Who it belongs to is the program's decision, not ours. A program that
     * tracks the mouse -- an agent's transcript, a pager, an editor -- does its
     * own scrolling and expects the wheel; sending it to our scrollback instead
     * is why a full-screen program can look like it will not scroll at all.
     * Only when nothing is tracking does the window's own history move.
     */
    scroll: (rows: number, column = 0, row = 0) =>
      Effect.suspend(() => {
        if (attached === null) return Effect.void;

        if (attached.terminal.mouseTracking) {
          const bytes = wheelBytes(
            rows > 0,
            column,
            row,
            attached.terminal.mouseSgr
          ).repeat(Math.min(Math.abs(rows), MAX_WHEEL_NOTCHES));
          return bytes === '' ? Effect.void : attached.write(bytes);
        }

        attached.terminal.scrollBy(rows);
        dirty = true;
        return Effect.void;
      }),

    /** Tell both ends the window changed shape. */
    resize: (size: TerminalSize) =>
      Effect.suspend(() => {
        if (attached === null) return Effect.void;
        // The far side is told by re-attaching, because a pty's size is set
        // when it is opened. Re-attaching is cheap on a connection that is
        // already up, and the alternative is a terminal drawing for a window
        // that is no longer that shape.
        const { alias, paneId } = attached;
        return attachPane(alias, paneId, size, true);
      }),
  } as const;
});

/**
 * The service interface is taken from the implementation rather than written
 * out twice. There is one implementation and one consumer, so a hand-written
 * interface would be a second place to keep in step and nothing more.
 */
export class HostRegistry extends Context.Service<
  HostRegistry,
  Effect.Effect.Success<typeof makeRegistry>
>()('muqun/HostRegistry') {
  static readonly layer = Layer.effect(HostRegistry, makeRegistry);
}
