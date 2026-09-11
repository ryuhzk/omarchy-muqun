/**
 * The pane the person is sitting in front of.
 *
 * One at a time. Attaching to another pane detaches this one, which is what a
 * person means by moving to another pane, and it keeps the number of open
 * terminals equal to the number of things being looked at.
 *
 * The keyboard translation lives here rather than in the panel because it is
 * the sort of table that is wrong in small ways for years if nobody can test
 * it. What the panel sends is the name of a key; what goes down the wire is
 * what a keyboard would have produced.
 */

import { Effect, Queue, Stream } from 'effect';
import type { Row } from '../domain/screen';
import { VtScreen } from '../domain/vt-screen';
import { TerminalSource, type TerminalSize } from './ports';

/**
 * What a named key sends.
 *
 * The names are the panel's, which are the ones a person would say. The bytes
 * are what an xterm-compatible terminal sends, because that is what everything
 * on the far side expects to read.
 */
const ESC = String.fromCharCode(0x1b);

const KEY_BYTES: Readonly<Record<string, string>> = {
  Enter: '\r',
  Return: '\r',
  Tab: '\t',
  BTab: `${ESC}[Z`,
  Escape: ESC,
  BSpace: String.fromCharCode(0x7f),
  Delete: `${ESC}[3~`,
  Up: `${ESC}[A`,
  Down: `${ESC}[B`,
  Right: `${ESC}[C`,
  Left: `${ESC}[D`,
  Home: `${ESC}[H`,
  End: `${ESC}[F`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
  // Shift-enter is how agents take a newline without submitting. Terminals
  // have no separate code for it, so it goes as the escape-prefixed return
  // that readline and the agents both read as "insert a line".
  'S-Enter': `${ESC}\r`,
};

/**
 * Translate a key name into the bytes a keyboard would have sent.
 *
 * `C-<letter>` becomes the control code for that letter, which is how ctrl-c
 * reaches a program as an interrupt rather than as the letter c.
 */
export function keyToBytes(key: string): string {
  const named = KEY_BYTES[key];
  if (named !== undefined) return named;

  const control = /^C-([a-z])$/.exec(key);
  if (control) {
    const letter = control[1]!;
    return String.fromCharCode(letter.charCodeAt(0) - 96);
  }

  const alt = /^M-(.)$/.exec(key);
  if (alt) return ESC + alt[1]!;

  // A name this build does not know sends nothing rather than sending the name
  // itself, which would type the word "Pause" into whatever is running.
  return '';
}

/**
 * A mouse event, as a program that tracks the mouse expects to read it.
 *
 * The SGR form carries the position without the 223-column ceiling the original
 * encoding had, and says press and release apart with the final byte: `M` for
 * down, `m` for up. A program tracking the mouse without asking for SGR gets
 * nothing rather than a truncated position it would misread.
 *
 * Positions are one-based on the wire, as cursor positions are.
 */
export function mouseBytes(
  button: number,
  column: number,
  row: number,
  pressed: boolean,
  sgr: boolean
): string {
  if (!sgr) return '';
  const final = pressed ? 'M' : 'm';
  return `${ESC}[<${button};${Math.max(1, column + 1)};${Math.max(1, row + 1)}${final}`;
}

/** Buttons, as the encoding numbers them. */
export const MOUSE_BUTTON = { left: 0, middle: 1, right: 2, wheelUp: 64, wheelDown: 65 } as const;

/**
 * A wheel notch.
 *
 * Wheels report as a press with no matching release, which is the convention
 * and is why this is not just `mouseBytes` with a flag at the call site.
 */
export function wheelBytes(up: boolean, column: number, row: number, sgr: boolean): string {
  return mouseBytes(
    up ? MOUSE_BUTTON.wheelUp : MOUSE_BUTTON.wheelDown,
    column,
    row,
    true,
    sgr
  );
}

export interface AttachedTerminal {
  readonly alias: string;
  readonly paneId: string;
  /** Rows as they stand, for the panel to draw. */
  rows(): ReadonlyArray<Row>;
  cursor(): { row: number; column: number; visible: boolean };
  /** Feed raw output from the far side. */
  consume(chunk: string): void;
  write(data: string): Effect.Effect<void>;
  press(key: string): Effect.Effect<void>;
}

/**
 * How long output is allowed to accumulate before the panel is told.
 *
 * A program clearing and redrawing produces a burst of writes that are one
 * picture; sending each would flicker and would spend the budget on pictures
 * nobody sees.
 *
 * Twenty a second rather than sixty. Every frame is a whole screen encoded as
 * JSON and parsed again in the shell that also draws the bar, the notifications
 * and the lock screen; a busy pane at sixty was measurably making that process
 * work for nothing. Nobody reading a terminal can tell the difference.
 */
export const FRAME_INTERVAL_MS = 50;
