/**
 * The terminal: the screen's rules, and the sequences that drive them.
 *
 * Written as sentences of intent rather than as byte comparisons, because the
 * reason a rule exists is the part that is easy to break later. The two halves
 * are tested apart: the screen through its own methods, the parser through the
 * screen it produced.
 */

import { describe, expect, test } from 'bun:test';
import { makeTerminal, VtParser } from '../backend/adapters/vt-parser';
import { screenText } from '../backend/domain/screen';
import { VtScreen } from '../backend/domain/vt-screen';

// Built from codepoints rather than written as escapes, so that what is in the
// file is unambiguous and survives being edited or copied by anything.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = `${ESC}[`;
const OSC = `${ESC}]`;
const ST = `${ESC}\\`;

function screen(rows = 5, columns = 10): VtScreen {
  return new VtScreen({ rows, columns, scrollback: 100 });
}

function lines(target: VtScreen): Array<string> {
  return target.toText().split('\n');
}

/** The plain text of one row of a viewport. */
function rowOf(row: { runs: ReadonlyArray<{ text: string }> }): string {
  return row.runs.map((run) => run.text).join('');
}

describe('the screen', () => {
  test('printing puts text at the cursor', () => {
    const s = screen();
    s.print('hello');
    expect(lines(s)[0]).toBe('hello');
    expect(s.cursor).toEqual({ row: 0, column: 5 });
  });

  test('filling the last column arms a wrap rather than taking it', () => {
    // The rule naive terminals get wrong. After exactly filling a row the
    // cursor is still on that row; only the next character moves it.
    const s = screen(3, 4);
    s.print('abcd');
    expect(s.cursor).toEqual({ row: 0, column: 3 });
    s.print('e');
    expect(s.cursor).toEqual({ row: 1, column: 1 });
    expect(lines(s)[0]).toBe('abcd');
    expect(lines(s)[1]).toBe('e');
  });

  test('a cursor move cancels a pending wrap', () => {
    const s = screen(3, 4);
    s.print('abcd');
    s.moveCursor(0, 0);
    s.print('X');
    expect(lines(s)[0]).toBe('Xbcd');
  });

  test('autowrap off keeps writing over the last column', () => {
    const s = screen(3, 4);
    s.autoWrap = false;
    s.print('abcdefg');
    expect(lines(s)[0]).toBe('abcg');
    expect(lines(s)[1]).toBe('');
  });

  test('a line feed at the bottom scrolls, and the row that left is history', () => {
    const s = screen(3, 10);
    for (const word of ['one', 'two', 'three']) {
      s.print(word);
      s.carriageReturn();
      s.lineFeed();
    }
    s.print('four');
    expect(lines(s)).toEqual(['two', 'three', 'four']);
    expect(s.historyLength).toBe(1);
  });

  test('a double-width character owns two cells and is drawn once', () => {
    const s = screen(2, 6);
    s.print('中文');
    expect(s.cursor.column).toBe(4);
    expect(lines(s)[0]).toBe('中文');
  });

  test('a double-width character will not straddle the right edge', () => {
    const s = screen(2, 2);
    s.print('a中');
    expect(lines(s)[0]).toBe('a');
    expect(lines(s)[1]).toBe('中');
  });

  test('a combining mark joins the cell before it', () => {
    const s = screen(2, 6);
    s.print('e' + String.fromCharCode(0x0301));
    expect(s.cursor.column).toBe(1);
    expect(lines(s)[0]).toBe('e' + String.fromCharCode(0x0301));
  });

  test('erase to end of line leaves what came before', () => {
    const s = screen();
    s.print('abcdef');
    s.moveCursor(0, 3);
    s.eraseInLine(0);
    expect(lines(s)[0]).toBe('abc');
  });

  test('the scrolling region confines a scroll', () => {
    const s = screen(4, 6);
    const write = (row: number, text: string): void => {
      s.moveCursor(row, 0);
      s.print(text);
    };
    write(0, 'one');
    write(1, 'two');
    write(2, 'three');
    write(3, 'four');

    s.setScrollRegion(1, 2);
    s.moveCursor(2, 0);
    s.lineFeed();

    expect(lines(s)[0]).toBe('one');
    expect(lines(s)[1]).toBe('three');
    expect(lines(s)[3]).toBe('four');
  });

  test('a region scroll is redrawing, so it does not become scrollback', () => {
    const s = screen(4, 6);
    s.setScrollRegion(1, 2);
    s.moveCursor(2, 0);
    s.lineFeed();
    expect(s.historyLength).toBe(0);
  });

  test('the alternate screen is blank, and leaving it puts back what was there', () => {
    const s = screen(3, 8);
    s.print('before');
    s.setAlternateScreen(true);
    expect(lines(s)[0]).toBe('');
    s.print('inside');
    s.setAlternateScreen(false);
    expect(lines(s)[0]).toBe('before');
  });

  test('the alternate screen does not add to scrollback', () => {
    const s = screen(2, 4);
    s.setAlternateScreen(true);
    for (let n = 0; n < 6; n += 1) {
      s.print('x');
      s.carriageReturn();
      s.lineFeed();
    }
    expect(s.historyLength).toBe(0);
  });

  test('growing keeps what is on screen where it is', () => {
    const s = screen(2, 6);
    s.print('one');
    s.carriageReturn();
    s.lineFeed();
    s.print('two');
    s.resize(4, 6);
    expect(lines(s)[0]).toBe('one');
    expect(lines(s)[1]).toBe('two');
  });

  test('insert and delete move a line without disturbing the rest', () => {
    const s = screen(4, 6);
    for (const [row, text] of [
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ] as const) {
      s.moveCursor(row, 0);
      s.print(text);
    }

    s.moveCursor(1, 0);
    s.deleteLines(1);
    expect(lines(s).slice(0, 2)).toEqual(['a', 'c']);

    s.moveCursor(1, 0);
    s.insertLines(1);
    expect(lines(s).slice(0, 3)).toEqual(['a', '', 'c']);
  });

  test('scrolling back shows history, and coming back shows the present', () => {
    const s = screen(2, 8);
    for (const word of ['one', 'two', 'three', 'four']) {
      s.print(word);
      s.carriageReturn();
      s.lineFeed();
    }
    expect(s.viewport().map(rowOf)).toEqual(['four', '']);

    s.scrollBy(2);
    expect(s.viewport().map(rowOf)).toEqual(['two', 'three']);

    s.scrollToBottom();
    expect(s.viewport().map(rowOf)).toEqual(['four', '']);
  });

  test('output arriving while scrolled back does not move what is being read', () => {
    // The rule that makes scrollback usable. New lines keep arriving, and the
    // text under the reader's eye stays exactly where they put it.
    const s = screen(2, 8);
    for (const word of ['one', 'two', 'three']) {
      s.print(word);
      s.carriageReturn();
      s.lineFeed();
    }
    s.scrollBy(2);
    const before = s.viewport().map(rowOf);

    s.print('four');
    s.carriageReturn();
    s.lineFeed();

    expect(s.viewport().map(rowOf)).toEqual(before);
  });

  test('the cursor is not drawn on a view you have scrolled away from', () => {
    const s = screen(2, 8);
    for (const word of ['one', 'two', 'three']) {
      s.print(word);
      s.carriageReturn();
      s.lineFeed();
    }
    expect(s.viewportCursor().visible).toBe(true);
    s.scrollBy(2);
    expect(s.viewportCursor().visible).toBe(false);
  });

  test('a full-screen program owns its grid, so scrolling back refuses', () => {
    const s = screen(2, 8);
    for (const word of ['one', 'two', 'three']) {
      s.print(word);
      s.carriageReturn();
      s.lineFeed();
    }
    s.setAlternateScreen(true);
    s.scrollBy(5);
    expect(s.atBottom).toBe(true);
  });

  test('runs merge neighbours that share a style', () => {
    const s = screen(1, 6);
    s.print('abc');
    const rows = s.toRows();
    expect(rows[0]!.runs).toHaveLength(1);
    expect(rows[0]!.runs[0]!.text).toBe('abc');
  });
});

describe('the parser', () => {
  const feed = (input: string, rows = 5, columns = 20): VtParser => {
    const terminal = makeTerminal(rows, columns, 100);
    terminal.write(input);
    return terminal;
  };

  test('a character-set selection leaves nothing on the screen', () => {
    // `ESC ( B` is three bytes, and a parser that consumed two of them printed
    // the third. Every zsh prompt that resets its charset began with a stray
    // letter.
    const parser = feed(`${ESC}(Bhello`);
    expect(screenText(parser.screen.viewport()).split('\n')[0]).toBe('hello');
  });

  test('a two-byte escape with an intermediate is consumed whole', () => {
    const parser = feed(`${ESC}#8ok`);
    expect(screenText(parser.screen.viewport()).split('\n')[0]).toBe('ok');
  });

  test('the graphics set turns letters into box drawing', () => {
    // `ESC ( 0` is how every curses program draws a frame: `q` is the
    // horizontal rule and `x` the vertical one. Ignoring the selection is what
    // printed a row of q's across the top of a pane.
    const parser = feed(`${ESC}(0qqq${ESC}(Bdone`);
    expect(screenText(parser.screen.viewport()).split('\n')[0]).toBe('\u2500\u2500\u2500done');
  });

  test('shift out and shift in pick between the two sets', () => {
    const SO = String.fromCharCode(0x0e);
    const SI = String.fromCharCode(0x0f);
    const parser = feed(`${ESC})0a${SO}q${SI}b`);
    expect(screenText(parser.screen.viewport()).split('\n')[0]).toBe('a\u2500b');
  });

  test('plain text reaches the screen', () => {
    expect(lines(feed('hello').screen)[0]).toBe('hello');
  });

  test('cursor positioning is one-based on the wire', () => {
    const terminal = feed(`${CSI}2;3Hx`);
    expect(terminal.screen.cursor).toEqual({ row: 1, column: 3 });
    expect(lines(terminal.screen)[1]).toBe('  x');
  });

  test('erase in display clears the screen', () => {
    const terminal = feed(`junk\n${CSI}2Jclean`);
    expect(lines(terminal.screen).join('').trim()).toBe('clean');
  });

  test('colour becomes style on the cells it applies to', () => {
    const terminal = feed(`${CSI}31mred${CSI}0mplain`);
    const runs = terminal.screen.toRows()[0]!.runs;
    expect(runs[0]!.text).toBe('red');
    expect(runs[0]!.style.fg).toEqual({ kind: 'indexed', index: 1 });
    expect(runs[1]!.text).toBe('plain');
    expect(runs[1]!.style.fg).toEqual({ kind: 'default' });
  });

  test('the alternate screen is entered and left by 1049', () => {
    const terminal = feed(`main${CSI}?1049halt`);
    expect(terminal.screen.onAlternateScreen).toBe(true);
    terminal.write(`${CSI}?1049l`);
    expect(terminal.screen.onAlternateScreen).toBe(false);
    expect(lines(terminal.screen)[0]).toBe('main');
  });

  test('hiding the cursor is recorded, because the panel draws one', () => {
    const terminal = feed(`${CSI}?25l`);
    expect(terminal.screen.cursorVisible).toBe(false);
    terminal.write(`${CSI}?25h`);
    expect(terminal.screen.cursorVisible).toBe(true);
  });

  test('a window title is taken from OSC, terminated either way', () => {
    expect(feed(`${OSC}0;from bel${BEL}`).screen.title).toBe('from bel');
    expect(feed(`${OSC}2;from st${ST}`).screen.title).toBe('from st');
  });

  test('a sequence split across two writes still works', () => {
    const terminal = makeTerminal(3, 20, 10);
    terminal.write(`${CSI}3`);
    terminal.write('1mred');
    expect(terminal.screen.toRows()[0]!.runs[0]!.style.fg).toEqual({
      kind: 'indexed',
      index: 1,
    });
    expect(lines(terminal.screen)[0]).toBe('red');
  });

  test('an OSC split across two writes still terminates', () => {
    const terminal = makeTerminal(3, 20, 10);
    terminal.write(`${OSC}0;split ti`);
    terminal.write(`tle${BEL}after`);
    expect(terminal.screen.title).toBe('split title');
    expect(lines(terminal.screen)[0]).toBe('after');
  });

  test('a sequence this panel does not implement is consumed, not printed', () => {
    // Answering a device query or writing someone's clipboard is not a
    // watcher's job, but the bytes must not reach the screen either.
    const terminal = feed(`a${CSI}>0cb${OSC}52;c;cGVybA==${BEL}c`);
    expect(lines(terminal.screen)[0]).toBe('abc');
  });

  test('a carriage return with no line feed overwrites, as a progress bar does', () => {
    const terminal = feed('50%\r100%');
    expect(lines(terminal.screen)[0]).toBe('100%');
  });

  test('backspace and overwrite, which is how a shell edits a line', () => {
    const terminal = feed('cat\b\bup');
    expect(lines(terminal.screen)[0]).toBe('cup');
  });

  test('a hyperlink is carried by the text it was wrapped around', () => {
    const link = 'https://example.com/a';
    const terminal = feed(`${OSC}8;;${link}${ST}click${OSC}8;;${ST} plain`);
    const runs = terminal.screen.toRows()[0]!.runs;
    expect(runs[0]!.text).toBe('click');
    expect(runs[0]!.style.link).toBe(link);
    expect(runs[1]!.style.link).toBe('');
  });

  test('a link this panel will not open is dropped, and its text still shows', () => {
    // A pane on another machine can print anything. A scheme some desktop
    // handler claims would turn a line of output into a way to start things
    // here, so only the web ones survive.
    for (const uri of ['file:///etc/passwd', 'ssh://host', 'javascript:alert(1)', 'nonsense']) {
      const terminal = feed(`${OSC}8;;${uri}${ST}text`);
      const run = terminal.screen.toRows()[0]!.runs[0]!;
      expect(run.text).toBe('text');
      expect(run.style.link).toBe('');
    }
  });

  test('a program that asks about the mouse is recorded as owning the wheel', () => {
    const terminal = feed(`${CSI}?1002h${CSI}?1006h`);
    expect(terminal.screen.mouseTracking).toBe(true);
    expect(terminal.screen.mouseSgr).toBe(true);
    terminal.write(`${CSI}?1002l`);
    expect(terminal.screen.mouseTracking).toBe(false);
  });

  test('scrollback is offered above the screen when asked for', () => {
    const terminal = makeTerminal(2, 8, 100);
    for (const word of ['one', 'two', 'three', 'four']) {
      terminal.write(`${word}\r\n`);
    }
    const withHistory = screenText(terminal.screen.toRows(10)).split('\n');
    expect(withHistory).toContain('one');
    expect(withHistory).toContain('four');
  });
});
