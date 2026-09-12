/**
 * What the panel is sent when the screen changes.
 *
 * A pane that prints one line changes one row, and the panel should be told
 * about that row rather than handed the whole screen again. Every full screen
 * is a few tens of kilobytes of JSON encoded here, parsed in the shell that
 * also draws the bar, and turned into a few hundred items; sending only what
 * moved is what keeps the shell idle while an agent is quietly working.
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_STYLE, screenDelta, type Row } from '../backend/domain/screen';

function row(text: string): Row {
  return { runs: [{ text, style: DEFAULT_STYLE, column: 0, cells: text.length }] };
}

describe('screen delta', () => {
  test('with nothing sent yet, the whole screen goes', () => {
    const rows = [row('a'), row('b')];
    const delta = screenDelta(null, rows);
    expect(delta.full).toBe(true);
    expect(delta.changed.map((entry) => entry.index)).toEqual([0, 1]);
    expect(delta.keys.length).toBe(2);
  });

  test('a screen that has not changed sends no rows', () => {
    const rows = [row('a'), row('b')];
    const first = screenDelta(null, rows);
    const second = screenDelta(first.keys, [row('a'), row('b')]);
    expect(second.full).toBe(false);
    expect(second.changed).toEqual([]);
  });

  test('one row changed sends that row and nothing else', () => {
    const first = screenDelta(null, [row('a'), row('b'), row('c')]);
    const second = screenDelta(first.keys, [row('a'), row('B'), row('c')]);
    expect(second.full).toBe(false);
    expect(second.changed.length).toBe(1);
    expect(second.changed[0]?.index).toBe(1);
    expect(second.changed[0]?.row).toEqual(row('B'));
  });

  test('a row whose style changed counts as changed', () => {
    const first = screenDelta(null, [row('a')]);
    const bold: Row = {
      runs: [{ text: 'a', style: { ...DEFAULT_STYLE, bold: true }, column: 0, cells: 1 }],
    };
    const second = screenDelta(first.keys, [bold]);
    expect(second.changed.map((entry) => entry.index)).toEqual([0]);
  });

  test('a different number of rows is a whole new screen', () => {
    const first = screenDelta(null, [row('a'), row('b')]);
    const second = screenDelta(first.keys, [row('a'), row('b'), row('c')]);
    expect(second.full).toBe(true);
    expect(second.changed.length).toBe(3);
  });

  test('the keys handed back describe the screen just sent', () => {
    const first = screenDelta(null, [row('a'), row('b')]);
    const second = screenDelta(first.keys, [row('x'), row('b')]);
    const third = screenDelta(second.keys, [row('x'), row('b')]);
    expect(third.changed).toEqual([]);
  });
});
