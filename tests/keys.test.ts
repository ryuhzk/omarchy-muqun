/**
 * What a key and a wheel become on the wire.
 *
 * A table like this is wrong in small ways for years if nobody checks it: a
 * control code off by one, an arrow that sends the wrong letter, a wheel a
 * program never sees. Every entry here is a sentence about what the far side
 * should receive.
 */

import { describe, expect, test } from 'bun:test';
import { keyToBytes, wheelBytes } from '../backend/application/attached-terminal';

const ESC = String.fromCharCode(0x1b);

describe('keys', () => {
  test('return and tab are the characters they have always been', () => {
    expect(keyToBytes('Enter')).toBe('\r');
    expect(keyToBytes('Tab')).toBe('\t');
  });

  test('backspace sends delete, which is what terminals actually send', () => {
    expect(keyToBytes('BSpace')).toBe(String.fromCharCode(0x7f));
  });

  test('the arrows are the usual escape sequences', () => {
    expect(keyToBytes('Up')).toBe(`${ESC}[A`);
    expect(keyToBytes('Down')).toBe(`${ESC}[B`);
    expect(keyToBytes('Right')).toBe(`${ESC}[C`);
    expect(keyToBytes('Left')).toBe(`${ESC}[D`);
  });

  test('a control combination is the control code, not the letter', () => {
    // This is the one that matters: ctrl-c has to interrupt rather than type a c.
    expect(keyToBytes('C-c')).toBe(String.fromCharCode(3));
    expect(keyToBytes('C-d')).toBe(String.fromCharCode(4));
  });

  test('alt prefixes with escape', () => {
    expect(keyToBytes('M-b')).toBe(`${ESC}b`);
  });

  test('shift-enter inserts a line rather than submitting', () => {
    expect(keyToBytes('S-Enter')).toBe(`${ESC}\r`);
  });

  test('a name this build does not know sends nothing', () => {
    // Sending the name itself would type the word into whatever is running.
    expect(keyToBytes('Pause')).toBe('');
    expect(keyToBytes('')).toBe('');
  });
});

describe('the wheel', () => {
  test('up and down are the two wheel buttons, positioned one-based', () => {
    expect(wheelBytes(true, 0, 0, true)).toBe(`${ESC}[<64;1;1M`);
    expect(wheelBytes(false, 4, 9, true)).toBe(`${ESC}[<65;5;10M`);
  });

  test('a program that did not ask for the modern encoding gets nothing', () => {
    // The old encoding cannot carry a column past 223, and a program reading a
    // truncated position scrolls somewhere nobody pointed at.
    expect(wheelBytes(true, 0, 0, false)).toBe('');
  });
});
