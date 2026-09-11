/**
 * The renderer, and the agreement between its two implementations.
 *
 * Every expectation runs twice: once through `libghostty-vt` and once through
 * the TypeScript fallback. That is the point of the suite. The fallback exists
 * so a machine without Ghostty still works, and a fallback that quietly drifts
 * from the library would be worse than not having one, because the difference
 * would only ever show up as a wrong colour on someone else's screen.
 */

import { describe, expect, test } from 'bun:test';
import { ghosttyVtAvailable } from '../backend/adapters/ghostty-vt';
import { parseSgrParams, renderScreen, splitParams } from '../backend/adapters/sgr-renderer';
import { DEFAULT_STYLE, rowText, screenText } from '../backend/domain/screen';

const paths = [
  { name: 'libghostty-vt', native: true },
  { name: 'fallback', native: false },
] as const;

describe('splitParams', () => {
  test('reads parameters and the separator that follows each', () => {
    expect(splitParams('1;31')).toEqual({ params: [1, 31], separators: [';', ';'] });
    expect(splitParams('4:3')).toEqual({ params: [4, 3], separators: [':', ';'] });
  });

  test('an empty parameter is its default, which for SGR is zero', () => {
    expect(splitParams('')).toEqual({ params: [0], separators: [';'] });
    expect(splitParams(';')).toEqual({ params: [0, 0], separators: [';', ';'] });
  });

  test('a private marker is not an SGR body', () => {
    expect(splitParams('?25')).toEqual({ params: [], separators: [] });
  });
});

for (const path of paths) {
  // Running the native expectations on a machine without the library would
  // silently test the fallback twice, which is the one thing this suite is
  // supposed to catch.
  const when = path.native && !ghosttyVtAvailable() ? describe.skip : describe;

  when(`SGR through the ${path.name}`, () => {
    const parse = (params: ReadonlyArray<number>, separators: ReadonlyArray<string>) =>
      parseSgrParams(params, separators, path.native);

    test('the named colours', () => {
      expect(parse([31], [';'])).toEqual([{ tag: 'fg8', index: 1 }]);
      expect(parse([42], [';'])).toEqual([{ tag: 'bg8', index: 2 }]);
      expect(parse([91], [';'])).toEqual([{ tag: 'brightFg8', index: 9 }]);
      expect(parse([101], [';'])).toEqual([{ tag: 'brightBg8', index: 9 }]);
    });

    test('256-colour', () => {
      expect(parse([38, 5, 200], [';', ';', ';'])).toEqual([{ tag: 'fg256', index: 200 }]);
      expect(parse([48, 5, 17], [';', ';', ';'])).toEqual([{ tag: 'bg256', index: 17 }]);
    });

    test('truecolour, in both the semicolon and the colon form', () => {
      const semicolon = parse([38, 2, 255, 128, 0], [';', ';', ';', ';', ';']);
      expect(semicolon).toEqual([{ tag: 'directColorFg', rgb: [255, 128, 0] }]);

      // The colon form carries a colorspace slot the semicolon form does not,
      // so the components sit one position further along.
      const colon = parse([38, 2, 0, 255, 128, 0], [':', ':', ':', ':', ':', ';']);
      expect(colon).toEqual([{ tag: 'directColorFg', rgb: [255, 128, 0] }]);
    });

    test('the underline styles', () => {
      expect(parse([4], [';'])).toEqual([{ tag: 'underline', style: 1 }]);
      expect(parse([4, 3], [':', ';'])).toEqual([{ tag: 'underline', style: 3 }]);
      expect(parse([24], [';'])).toEqual([{ tag: 'underline', style: 0 }]);
    });

    test('reset clears everything', () => {
      expect(parse([0], [';'])).toEqual([{ tag: 'unset' }]);
      expect(parse([], [])).toEqual([{ tag: 'unset' }]);
    });

    test('several attributes in one sequence, in order', () => {
      expect(parse([1, 3, 31], [';', ';', ';'])).toEqual([
        { tag: 'bold' },
        { tag: 'italic' },
        { tag: 'fg8', index: 1 },
      ]);
    });

    test('bold and faint are cleared together, as SGR 22 says', () => {
      expect(parse([22], [';'])).toEqual([{ tag: 'resetBold' }]);
    });
  });
}

describe('renderScreen', () => {
  test('plain text is one run on one row', () => {
    const rows = renderScreen('hello');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runs).toHaveLength(1);
    expect(rows[0]!.runs[0]!.text).toBe('hello');
    expect(rows[0]!.runs[0]!.style).toEqual(DEFAULT_STYLE);
  });

  test('a colour change starts a new run', () => {
    const rows = renderScreen('plain[31mred[0mplain');
    expect(rows[0]!.runs.map((run) => run.text)).toEqual(['plain', 'red', 'plain']);
    expect(rows[0]!.runs[1]!.style.fg).toEqual({ kind: 'indexed', index: 1 });
    expect(rows[0]!.runs[2]!.style.fg).toEqual({ kind: 'default' });
  });

  test('style carries across a line ending, because the screen is one stream', () => {
    const rows = renderScreen('[1mbold\nstill bold');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.runs[0]!.style.bold).toBe(true);
    expect(rows[1]!.runs[0]!.style.bold).toBe(true);
  });

  test('the trailing newline of a capture is not an extra row', () => {
    expect(renderScreen('one\ntwo\n')).toHaveLength(2);
  });

  test('a blank line in the middle is kept, because the screen has one there', () => {
    const rows = renderScreen('one\n\nthree');
    expect(rows).toHaveLength(3);
    expect(rows[1]!.runs).toHaveLength(0);
  });

  test('carriage returns from the capture are not drawn', () => {
    expect(screenText(renderScreen('one\r\ntwo\r\n'))).toBe('one\ntwo');
  });

  test('a sequence that is not SGR is dropped rather than printed', () => {
    // This input does not occur in practice -- herdr and tmux send colour only
    // -- but printing the bytes of one would be worse than ignoring it.
    expect(rowText(renderScreen('a[2Jb')[0]!)).toBe('ab');
    expect(rowText(renderScreen('a[?25lb')[0]!)).toBe('ab');
  });

  test('the two implementations produce the same screen', () => {
    const input =
      '[1;38;2;255;128;0mwarm[0m normal [4:3;58:5:42mcurly[0m\n' +
      '[7minverse[27m [90mdim[39m done';
    expect(renderScreen(input, false)).toEqual(renderScreen(input, true));
  });
});
