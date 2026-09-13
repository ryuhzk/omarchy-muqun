/**
 * The JSON-lines protocol: the panel's side of the boundary.
 *
 * Commands arrive as one JSON object per line and are decoded before they reach
 * a use case. Changes go back the same way. QML holds no protocol knowledge, no
 * host credentials, and no parsing code -- it draws what arrives and sends what
 * was clicked.
 *
 * Nothing here knows about ssh, herdr, or Ghostty. It knows about lines.
 */

import { Effect, Schema } from 'effect';
import { HostRegistry, type Change } from '../application/host-registry';
import { BUTTON_ID } from '../domain/simfarm';

const HostEntry = Schema.Struct({
  alias: Schema.String,
  label: Schema.optional(Schema.String),
});

/** What the panel may ask for. Decoded, never trusted: it is external input. */
export const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal('setHosts'), hosts: Schema.Array(HostEntry) }),
  Schema.Struct({ type: Schema.Literal('refresh'), alias: Schema.optional(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal('attach'),
    alias: Schema.String,
    paneId: Schema.String,
    rows: Schema.optional(Schema.Number),
    columns: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal('resize'),
    rows: Schema.Number,
    columns: Schema.Number,
  }),
  // Typing goes to whatever is attached, so neither of these names a pane. The
  // panel cannot type into a pane it is not looking at, which is also true of a
  // terminal.
  Schema.Struct({
    type: Schema.Literal('scroll'),
    rows: Schema.Number,
    /** Where the pointer was, in cells, for programs that track the mouse. */
    column: Schema.optional(Schema.Number),
    row: Schema.optional(Schema.Number),
  }),
  // Opening the simulator strip is what holds whatever is needed to reach the
  // farm; closing it lets go. An empty url closes.
  Schema.Struct({
    type: Schema.Literal('simulators'),
    url: Schema.String,
    sshHost: Schema.String,
    localPort: Schema.Number,
    /** Which device to show. Null lists them without showing one. */
    deviceId: Schema.optional(Schema.String),
  }),
  // Acting on the device that is showing. Positions are fractions of the
  // picture, so the panel can be any size.
  Schema.Struct({
    type: Schema.Literal('tap'),
    phase: Schema.Literals(['begin', 'move', 'end']),
    x: Schema.Number,
    y: Schema.Number,
  }),
  // Named rather than numbered, because the panel knows what the device said it
  // has and the number is a wire detail.
  Schema.Struct({
    type: Schema.Literal('deviceButton'),
    button: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('deviceText'),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('deviceScroll'),
    dx: Schema.Number,
    dy: Schema.Number,
    x: Schema.Number,
    y: Schema.Number,
  }),
  // A click in the terminal. Forwarded only when a program is tracking the
  // mouse; otherwise it was only ever about where the keyboard points.
  Schema.Struct({
    type: Schema.Literal('click'),
    column: Schema.Number,
    row: Schema.Number,
    pressed: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal('splitPane'),
    direction: Schema.Literals(['right', 'down']),
  }),
  // Naming a pane closes that one; naming none closes whatever is being
  // watched, which is what the header's button means.
  Schema.Struct({
    type: Schema.Literal('closePane'),
    alias: Schema.optional(Schema.String),
    paneId: Schema.optional(Schema.String),
  }),
  // Let go of the pane without closing it. The panel sends this when its window
  // goes away: nobody is looking, and an attached pane is a held channel and,
  // on herdr, a terminal taken from whoever else had it.
  Schema.Struct({ type: Schema.Literal('detach') }),
  // A terminal that was not there before. Named by host rather than by pane,
  // because there is nothing to be beside yet.
  Schema.Struct({
    type: Schema.Literal('newTerminal'),
    alias: Schema.String,
    rows: Schema.optional(Schema.Number),
    columns: Schema.optional(Schema.Number),
    /** Run this in it once it exists. The panel offers this for one thing. */
    command: Schema.optional(Schema.String),
  }),
  // An agent that was not there before, on a herdr host: a place is made
  // for it and it is started there. `besidePane` is the pane being looked
  // at, which is what "beside" and "in this workspace" are measured from.
  Schema.Struct({
    type: Schema.Literal('newAgent'),
    alias: Schema.String,
    kind: Schema.String,
    where: Schema.Literals(['split', 'tab', 'workspace']),
    besidePane: Schema.optional(Schema.String),
    rows: Schema.optional(Schema.Number),
    columns: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal('type'), text: Schema.String }),
  // Pasting is not typing: a program that asked to be told about pastes is
  // told, so a shell can offer to run several lines rather than running them.
  Schema.Struct({ type: Schema.Literal('paste'), text: Schema.String }),
  // Paste what the desktop clipboard is holding, whatever that turns out to
  // be. The panel does not look: what a picture means to a pane is not the
  // panel's decision, and reading the clipboard twice would be two chances to
  // read two different things.
  Schema.Struct({ type: Schema.Literal('pasteClipboard') }),
  Schema.Struct({ type: Schema.Literal('keys'), keys: Schema.Array(Schema.String) }),
]);
export type Command = typeof Command.Type;

/** What the panel is sent. `ready` is the only one the registry does not make. */
export type Event = Change | { readonly type: 'ready' };

/**
 * The terminal to ask for when the panel has not measured itself yet.
 *
 * The panel always does measure and then resizes, so this only governs the
 * first instant. It is the size every terminal has defaulted to for forty
 * years, which is the safest thing for a program to be drawn for briefly.
 */
const DEFAULT_SIZE = { rows: 24, columns: 80 } as const;

/** Act on one decoded command. */
export const runCommand = Effect.fnUntraced(function* (command: Command) {
  const registry = yield* HostRegistry;
  switch (command.type) {
    case 'setHosts':
      return yield* registry.setHosts(command.hosts);
    case 'refresh':
      return yield* command.alias ? registry.refreshOne(command.alias) : registry.refreshAll;
    case 'attach':
      return yield* registry.attach(command.alias, command.paneId, {
        rows: command.rows ?? DEFAULT_SIZE.rows,
        columns: command.columns ?? DEFAULT_SIZE.columns,
      });
    case 'resize':
      return yield* registry.resize({ rows: command.rows, columns: command.columns });
    case 'scroll':
      return yield* registry.scroll(command.rows, command.column ?? 0, command.row ?? 0);
    case 'simulators':
      return yield* registry.watchSimulators(
        command.url === ''
          ? null
          : { url: command.url, sshHost: command.sshHost, localPort: command.localPort },
        command.deviceId ?? null
      );
    case 'tap':
      return yield* registry.simulatorInput({
        kind: 'touch',
        phase: command.phase,
        x: command.x,
        y: command.y,
      });
    case 'deviceButton': {
      const buttonId = BUTTON_ID[command.button];
      if (buttonId === undefined) return;
      // Press and release together: a hardware button on a simulator is a tap,
      // not something anyone holds down through a panel.
      yield* registry.simulatorInput({ kind: 'button', phase: 'down', buttonId });
      return yield* registry.simulatorInput({ kind: 'button', phase: 'up', buttonId });
    }
    case 'deviceText':
      return yield* registry.simulatorInput({ kind: 'text', text: command.text });
    case 'deviceScroll':
      return yield* registry.simulatorInput({
        kind: 'scroll',
        dx: command.dx,
        dy: command.dy,
        x: command.x,
        y: command.y,
      });
    case 'click':
      return yield* registry.click(command.column, command.row, command.pressed).pipe(
        Effect.asVoid
      );
    case 'splitPane':
      return yield* registry.splitPane(command.direction);
    case 'closePane':
      return yield* command.alias && command.paneId
        ? registry.closeNamedPane(command.alias, command.paneId)
        : registry.closePane;
    case 'detach':
      return yield* registry.detach;
    case 'newTerminal':
      return yield* registry.newTerminal(
        command.alias,
        {
          rows: command.rows ?? DEFAULT_SIZE.rows,
          columns: command.columns ?? DEFAULT_SIZE.columns,
        },
        command.command
      );
    case 'newAgent':
      return yield* registry.newAgent(
        command.alias,
        {
          kind: command.kind,
          where: command.where,
          ...(command.besidePane === undefined ? {} : { besidePane: command.besidePane }),
        },
        {
          rows: command.rows ?? DEFAULT_SIZE.rows,
          columns: command.columns ?? DEFAULT_SIZE.columns,
        }
      );
    case 'type':
      return yield* registry.typeText(command.text);
    case 'paste':
      return yield* registry.pasteText(command.text);
    case 'pasteClipboard':
      return yield* registry.pasteClipboard;
    case 'keys':
      return yield* registry.pressKeys(command.keys);
  }
});

/**
 * Decode one line and act on it.
 *
 * A line that is not readable is reported and dropped. The panel and the
 * sidecar ship together, so an unreadable line means a bug rather than a
 * hostile caller, and the useful response is to say which line and carry on
 * rather than to take the process down.
 */
export const acceptLine = Effect.fnUntraced(function* (line: string) {
  const trimmed = line.trim();
  if (trimmed === '') return;

  const parsed = yield* Effect.try({
    try: () => JSON.parse(trimmed) as unknown,
    catch: () => new Error('the panel sent a line that is not JSON'),
  }).pipe(Effect.option);
  if (parsed._tag === 'None') {
    return yield* Effect.logWarning('sidecar: dropped a line that is not JSON');
  }

  const command = yield* Schema.decodeUnknownEffect(Command)(parsed.value).pipe(Effect.option);
  if (command._tag === 'None') {
    return yield* Effect.logWarning('sidecar: dropped a command this build does not know');
  }

  yield* runCommand(command.value).pipe(Effect.catchCause(() => Effect.void));
});
