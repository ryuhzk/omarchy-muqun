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

/**
 * Keys that are one fixed sequence whatever else is held.
 *
 * The names are the panel's, which are the ones a person would say. The bytes
 * are what an xterm-compatible terminal sends, because that is what everything
 * on the far side expects to read.
 */
const PLAIN_KEYS: Readonly<Record<string, string>> = {
  Enter: '\r',
  Return: '\r',
  Tab: '\t',
  BTab: `${ESC}[Z`,
  Escape: ESC,
  BSpace: String.fromCharCode(0x7f),
};

/**
 * Keys whose sequence ends in a letter: `ESC [ A` for up, and `ESC [ 1 ; 2 A`
 * for shift-up. The home keys are the same family, which is why they are here
 * and not with the tilde keys.
 */
const LETTER_KEYS: Readonly<Record<string, string>> = {
  Up: 'A',
  Down: 'B',
  Right: 'C',
  Left: 'D',
  Home: 'H',
  End: 'F',
};

/** The first four function keys: `ESC O P` alone, `ESC [ 1 ; 2 P` with shift. */
const SS3_KEYS: Readonly<Record<string, string>> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };

/** Keys whose sequence is a number and a tilde: `ESC [ 3 ~` for delete. */
const TILDE_KEYS: Readonly<Record<string, number>> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};

/**
 * The control characters that are not a letter's.
 *
 * ctrl-space and ctrl-@ are both NUL; the brackets, backslash, caret and
 * underscore are the four after the letters, which is where escape lives.
 */
const CONTROL_KEYS: Readonly<Record<string, number>> = {
  Space: 0,
  '@': 0,
  '[': 0x1b,
  '\\': 0x1c,
  ']': 0x1d,
  '^': 0x1e,
  _: 0x1f,
};

/** The modifiers a name may begin with, and the bit each contributes. */
const MODIFIER_BITS: Readonly<Record<string, number>> = { S: 1, M: 2, C: 4 };

/**
 * Translate a key name into the bytes a keyboard would have sent.
 *
 * A name is modifiers, then a key: `C-S-Up` is ctrl and shift on up. The
 * modifiers on a named key become the xterm parameter, one plus the sum of
 * their bits, so that shift-up is `ESC [ 1 ; 2 A` and every program that reads
 * a modern terminal reads it. `C-<letter>` becomes the control code for that
 * letter, which is how ctrl-c reaches a program as an interrupt rather than as
 * the letter c; `M-<anything>` is escape and then the thing, which is what alt
 * has meant since before there were function keys.
 */
export function keyToBytes(key: string): string {
  let bits = 0;
  let rest = key;
  while (rest.length > 2 && rest[1] === '-' && MODIFIER_BITS[rest[0]!] !== undefined) {
    bits |= MODIFIER_BITS[rest[0]!]!;
    rest = rest.slice(2);
  }
  if (rest === '') return '';

  const shift = (bits & 1) !== 0;
  const alt = (bits & 2) !== 0;
  const control = (bits & 4) !== 0;
  const prefix = alt ? ESC : '';

  // Shift-enter is how agents take a newline without submitting. Terminals
  // have no separate code for it, so it goes as the escape-prefixed return that
  // readline and the agents both read as "insert a line".
  if (rest === 'Enter' && shift) return `${ESC}\r`;
  if (rest === 'Tab' && shift) return `${prefix}${ESC}[Z`;

  const plain = PLAIN_KEYS[rest];
  if (plain !== undefined) return `${prefix}${plain}`;

  const parameter = bits === 0 ? '' : `;${1 + bits}`;

  const letter = LETTER_KEYS[rest];
  if (letter !== undefined) {
    return bits === 0 ? `${ESC}[${letter}` : `${ESC}[1${parameter}${letter}`;
  }
  const ss3 = SS3_KEYS[rest];
  if (ss3 !== undefined) {
    return bits === 0 ? `${ESC}O${ss3}` : `${ESC}[1${parameter}${ss3}`;
  }
  const tilde = TILDE_KEYS[rest];
  if (tilde !== undefined) return `${ESC}[${tilde}${parameter}~`;

  if (control) {
    if (/^[a-z]$/.test(rest)) {
      return `${prefix}${String.fromCharCode(rest.charCodeAt(0) - 96)}`;
    }
    const code = CONTROL_KEYS[rest];
    if (code !== undefined) return `${prefix}${String.fromCharCode(code)}`;
  }

  if (alt && !control && [...rest].length === 1) return ESC + rest;

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
