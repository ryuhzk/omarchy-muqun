/**
 * Addresses a program printed as text, found on the grid.
 *
 * Programs that know about terminal hyperlinks mark them with OSC 8 and the
 * screen carries the mark on the style. Most programs do not, and print the
 * address as plain characters; a build tool says "you can see your build
 * here:" and then the address, and that address should open on a click as
 * surely as a marked one.
 *
 * So each row is read as text and searched, and the cells that spell an
 * address get the link put on their style. The cells are what is searched,
 * not the runs: a run is broken by a change of style, and an address printed
 * half bold is still one address.
 */

import { cloneStyle } from './screen';
import type { Cell } from './vt-screen';

/**
 * What an address looks like in a row of text.
 *
 * http and https only, because those are the only ones the panel will open.
 * It runs to the first blank, quote or angle bracket; what to do about the
 * punctuation it may then be carrying is decided afterwards.
 */
const ADDRESS = /https?:\/\/[^\s<>"'`]+/g;

/** Punctuation a sentence puts after an address, which is not part of it. */
const TRAILING = /[.,;:!?]+$/;

/**
 * Trim what a sentence, rather than the address, put at the end.
 *
 * A closing bracket comes off only when the address did not open one: the
 * `(bar)` in a wiki title stays, the `)` closing a parenthetical remark does
 * not.
 */
function trimmed(address: string): string {
  let out = address.replace(TRAILING, '');
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    while (out.endsWith(close)) {
      const opens = out.split(open).length - 1;
      const closes = out.split(close).length - 1;
      if (closes <= opens) break;
      out = out.slice(0, -1).replace(TRAILING, '');
    }
  }
  return out;
}

/**
 * The same cells, with a link on every one that spells an address.
 *
 * Cells that already carry a link are left alone, and an address that
 * overlaps one is not marked: the program said what that text links to, and
 * it knows better than a pattern does.
 */
export function withPlainLinks(cells: ReadonlyArray<Cell>): ReadonlyArray<Cell> {
  // The row as text, remembering which cell each character came from.
  // Continuations are skipped: they are not characters. A never-written cell
  // reads as a blank so that words stay apart.
  let text = '';
  const origin: Array<number> = [];
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!;
    if (cell.continuation) continue;
    const char = cell.char === '' ? ' ' : cell.char;
    for (let unit = 0; unit < char.length; unit += 1) origin.push(index);
    text += char;
  }
  if (!text.includes('://')) return cells;

  let out: Array<Cell> | null = null;
  for (const match of text.matchAll(ADDRESS)) {
    const address = trimmed(match[0]);
    if (address === '') continue;
    const from = match.index ?? 0;
    const to = from + address.length;

    let marked = false;
    for (let unit = from; unit < to; unit += 1) {
      const index = origin[unit];
      if (index === undefined) continue;
      if (cells[index]!.style.link !== '') {
        marked = true;
        break;
      }
    }
    if (marked) continue;

    if (out === null) out = [...cells];
    for (let unit = from; unit < to; unit += 1) {
      const index = origin[unit];
      if (index === undefined) continue;
      const cell = out[index]!;
      if (cell.style.link === address) continue;
      const style = cloneStyle(cell.style);
      style.link = address;
      out[index] = { ...cell, style };
    }
  }
  return out ?? cells;
}
