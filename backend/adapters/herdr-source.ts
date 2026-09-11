/**
 * `TerminalSource` over the herdr command line.
 *
 * herdr 0.9.0 exposes its socket API through its own CLI, so this is a
 * translation layer rather than a protocol implementation. Three commands carry
 * the whole cockpit:
 *
 *   herdr api snapshot                    everything, in one document
 *   herdr agent wait <id> --until ...     blocks until an agent changes
 *   herdr pane read | send-text | send-keys
 *
 * The snapshot is decoded rather than trusted. It comes off another machine,
 * from a herdr that may not be the one this was written against, and a field
 * that quietly changed shape should surface as a decode failure rather than as
 * `undefined` reaching the panel.
 */

import { Effect, Layer, Schema, Stream } from 'effect';
import {
  CommandRunner,
  SourceError,
  type AttachedPane,
  type TerminalSourceApi,
  type AttachOptions,
  type CommandResult,
  type TerminalSize,
} from '../application/ports';
import { parseAgentStatus } from '../domain/agent-status';
import { isAgentPane, type Pane } from '../domain/pane';

/**
 * A pane as herdr describes it.
 *
 * Only the fields the panel uses are named. Everything else herdr sends is
 * allowed through and ignored, so a newer herdr does not fail to decode merely
 * for knowing more than we do.
 */
const HerdrPane = Schema.Struct({
  pane_id: Schema.String,
  tab_id: Schema.String,
  agent: Schema.optional(Schema.String),
  agent_status: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  focused: Schema.optional(Schema.Boolean),
  terminal_title: Schema.optional(Schema.String),
  terminal_title_stripped: Schema.optional(Schema.String),
});
type HerdrPane = typeof HerdrPane.Type;

const HerdrTab = Schema.Struct({
  tab_id: Schema.String,
  label: Schema.optional(Schema.String),
  number: Schema.optional(Schema.Number),
});

const HerdrSnapshot = Schema.Struct({
  panes: Schema.optional(Schema.Array(HerdrPane)),
  tabs: Schema.optional(Schema.Array(HerdrTab)),
});
type HerdrSnapshot = typeof HerdrSnapshot.Type;

/**
 * herdr's CLI wraps a result as `{ id, result: { snapshot }, type }`.
 *
 * Unwrapped by hand rather than by schema because several envelope shapes are
 * in the wild and none is worth failing over: take the innermost thing that
 * looks like a snapshot.
 */
function unwrap(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== 'object') return parsed;
  const envelope = parsed as Record<string, unknown>;
  const result = envelope.result as Record<string, unknown> | undefined;
  return result?.snapshot ?? envelope.snapshot ?? envelope;
}

/**
 * What to call a pane.
 *
 * herdr offers both the raw terminal title and one with its own status glyphs
 * removed. The stripped form is what a person would call it, so prefer that,
 * then the raw title, then the last segment of the working directory.
 */
export function paneTitle(pane: HerdrPane): string {
  const stripped = pane.terminal_title_stripped?.trim();
  if (stripped) return stripped;
  const raw = pane.terminal_title?.trim();
  if (raw) return raw;
  return pane.cwd?.split('/').filter(Boolean).pop() ?? pane.pane_id;
}

/** Translate a decoded snapshot into the domain. */
export function panesFromSnapshot(snapshot: HerdrSnapshot): ReadonlyArray<Pane> {
  const tabLabels = new Map<string, string>();
  for (const tab of snapshot.tabs ?? []) {
    const label = tab.label?.trim();
    tabLabels.set(tab.tab_id, label || `tab ${tab.number ?? ''}`.trim());
  }

  return (snapshot.panes ?? []).map((pane) => ({
    id: pane.pane_id,
    source: 'herdr' as const,
    title: paneTitle(pane),
    cwd: pane.cwd ?? '',
    focused: pane.focused === true,
    status: parseAgentStatus(pane.agent_status),
    agent: pane.agent,
    groupId: pane.tab_id,
    groupLabel: tabLabels.get(pane.tab_id) ?? pane.tab_id,
  }));
}

/** Parse a snapshot document. Exported so tests can drive it without ssh. */
export const decodeSnapshot = Effect.fnUntraced(function* (alias: string, raw: string) {
  const parsed = yield* Effect.try({
    try: () => unwrap(JSON.parse(raw) as unknown),
    catch: () =>
      new SourceError({ alias, command: 'api snapshot', message: 'herdr did not answer with JSON' }),
  });

  const snapshot = yield* Schema.decodeUnknownEffect(HerdrSnapshot)(parsed).pipe(
    Effect.mapError(
      (issue) =>
        new SourceError({
          alias,
          command: 'api snapshot',
          message: `herdr sent a snapshot this plugin cannot read: ${issue}`,
        })
    )
  );

  return panesFromSnapshot(snapshot);
});

/**
 * The remote half of an attached pane.
 *
 * `herdr agent attach` puts this connection in front of one pane's terminal.
 * ssh supplies the pty, and `stty` sizes it before the attach begins so the far
 * end draws for the window it is actually being shown in.
 *
 * `exec` replaces the shell rather than leaving one waiting on it, so closing
 * the connection tears down exactly one process. Detaching is not closing: the
 * pane and whatever is running in it carry on.
 */
function attachScript(paneId: string, size: TerminalSize, takeover: boolean): string {
  const rows = Math.max(1, Math.floor(size.rows));
  const columns = Math.max(1, Math.floor(size.columns));
  const attach = takeover
    ? `herdr agent attach ${shellSingleQuote(paneId)} --takeover`
    : `herdr agent attach ${shellSingleQuote(paneId)}`;
  return [`stty rows ${rows} cols ${columns} 2>/dev/null`, `exec ${attach}`].join('\n');
}

/**
 * Wait on every agent at once, and print the first to stop.
 *
 * `blocked` alone would miss an agent that finished. Both are states where the
 * pane has stopped making progress on its own, which is when the badge should
 * change.
 *
 * Each wait is a background job writing its own id when it returns.
 *
 * The trap is the important part, and its absence once filled a machine with
 * sixteen hundred of these. Without a terminal on the far side, sshd closing a
 * channel does not signal what was running in it: the client goes away, and the
 * shell and its waits are reparented to init and left there. Every re-arm of
 * this watch leaked another set. So the watch asks for a terminal, which makes
 * the remote shell a session leader that sshd sends a hangup to, and this trap
 * passes that hangup on to the whole group.
 */
function watchScript(paneIds: ReadonlyArray<string>): string {
  const lines = paneIds.map(
    (id) =>
      `( herdr agent wait ${shellSingleQuote(id)} --until blocked --until done >/dev/null 2>&1; ` +
      `printf '%s\\n' ${shellSingleQuote(id)} ) &`
  );
  return [`trap 'kill 0 2>/dev/null' EXIT HUP INT TERM`, ...lines, 'wait'].join('\n');
}

/** Wrap a value so the remote shell reads it as one literal word. */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Build the herdr source. The composition root decides where it is offered. */
export const makeHerdrSource = Effect.gen(function* () {
  const runner = yield* CommandRunner;

    const demand = Effect.fnUntraced(function* (
      alias: string,
      command: string,
      result: CommandResult
    ) {
      if (result.ok) return result.stdout;
      return yield* new SourceError({
        alias,
        command,
        message: result.firstError || `herdr ${command} exited ${result.code}`,
      });
    });

  const source: TerminalSourceApi = {
    kind: 'herdr',

    available: (alias) =>
      runner
        .run(alias, ['command', '-v', 'herdr'])
        .pipe(Effect.map((result) => result.ok && result.stdout.trim() !== '')),

    /**
     * The agents herdr is running, and only those.
     *
     * herdr also holds plain shells -- an editor, a server, a prompt -- and it
     * will not hand one over: `agent attach` is the only way in, and it refuses
     * a pane with no agent in it. Listing them anyway put rows in the panel
     * whose only possible answer to a click was an apology. The shells on a
     * machine are reachable through tmux, which will attach anything, so this
     * source now offers what it can actually open.
     */
    panes: Effect.fnUntraced(function* (alias: string) {
      const result = yield* runner.run(alias, ['herdr', 'api', 'snapshot']);
      const raw = yield* demand(alias, 'api snapshot', result);
      const panes = yield* decodeSnapshot(alias, raw);
      return panes.filter(isAgentPane);
    }),

    read: Effect.fnUntraced(function* (alias: string, paneId: string, lines: number) {
      // `--source visible` is the screen as it stands rather than the recent
      // scrollback, which is what a preview of a live pane should show.
      const result = yield* runner.run(alias, [
        'herdr',
        'pane',
        'read',
        paneId,
        '--source',
        'visible',
        '--format',
        'ansi',
        '--lines',
        String(lines),
      ]);
      return yield* demand(alias, 'pane read', result);
    }),

    sendText: Effect.fnUntraced(function* (alias: string, paneId: string, text: string) {
      const result = yield* runner.run(alias, ['herdr', 'pane', 'send-text', paneId, text]);
      yield* demand(alias, 'pane send-text', result);
    }),

    sendKeys: Effect.fnUntraced(function* (
      alias: string,
      paneId: string,
      keys: ReadonlyArray<string>
    ) {
      const result = yield* runner.run(alias, ['herdr', 'pane', 'send-keys', paneId, ...keys]);
      yield* demand(alias, 'pane send-keys', result);
    }),

    attach: Effect.fnUntraced(function* (
      alias: string,
      paneId: string,
      size: TerminalSize,
      options?: AttachOptions
    ) {
      const session = yield* runner.session(
        alias,
        ['sh', '-c', attachScript(paneId, size, options?.takeover === true)],
        { pty: true }
      );
      return {
        output: session.output,
        write: session.write,
        complaint: session.complaint,
      } satisfies AttachedPane;
    }),

    splitPane: Effect.fnUntraced(function* (
      alias: string,
      paneId: string,
      direction: 'right' | 'down'
    ) {
      const result = yield* runner.run(alias, [
        'herdr',
        'pane',
        'split',
        paneId,
        '--direction',
        direction,
      ]);
      yield* demand(alias, 'pane split', result);
    }),

    closePane: Effect.fnUntraced(function* (alias: string, paneId: string) {
      const result = yield* runner.run(alias, ['herdr', 'pane', 'close', paneId]);
      yield* demand(alias, 'pane close', result);
    }),

    waitForAgents: Effect.fnUntraced(function* (
      alias: string,
      paneIds: ReadonlyArray<string>
    ) {
      // With a terminal, so that hanging up takes the waits with it. See
      // `watchScript`: this is the difference between a watch that ends and a
      // watch that is merely abandoned.
      const session = yield* runner.session(alias, ['sh', '-c', watchScript(paneIds)], {
        pty: true,
      });
      // The first line is the first agent to stop. Taking one and leaving
      // ends the scope, which kills the ssh client; the remote shell and its
      // waiters get a hangup from that, so nothing has to tidy up on the far
      // side.
      const fired = yield* session.output.pipe(
        Stream.splitLines,
        Stream.filter((line) => line.trim() !== ''),
        Stream.take(1),
        Stream.runCollect,
        Effect.map((lines) => lines[0] ?? '')
      );
      return fired.trim();
    }),
  };

  return source;
});
