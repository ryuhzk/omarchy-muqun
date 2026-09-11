/**
 * A terminal screen: cells, a cursor, and the operations a program performs on
 * them.
 *
 * This exists because a rendered screenshot is not a terminal. Reading a pane
 * gives you what it looked like a moment ago, with no cursor and no way to see
 * your own keystroke until the next read. Attaching to the pane's own stream
 * gives you the bytes a terminal is fed, and this is the thing that is fed.
 *
 * It is a state machine and nothing else: no parsing, no escape sequences, no
 * I/O. The parser decides what a sequence means and calls a method here, which
 * is what makes every rule below testable by writing a sentence of intent.
 *
 * Two decisions worth stating, because they are where naive implementations go
 * wrong:
 *
 * Wrapping is deferred. Writing into the last column does not move the cursor
 * to the next line; it sets a pending flag that the *next* printed character
 * acts on. A terminal that wraps eagerly puts the cursor on the wrong line
 * whenever a program fills a row exactly and then moves the cursor itself,
 * which every full-screen program does constantly.
 *
 * The alternate screen is a second grid, not a saved copy. A program that
 * enters it gets a blank screen and the scrollback is untouched, so leaving it
 * puts back exactly what was there without anything having to remember it.
 */

import { DEFAULT_STYLE, cloneStyle, type Row, type Run, type Style } from './screen';

export interface Cell {
  /** One grapheme. Empty means the cell has never been written. */
  char: string;
  style: Style;
  /**
   * Set on the cell to the right of a double-width character, which owns both.
   * The continuation is never drawn and never counted.
   */
  continuation: boolean;
}

export interface CursorPosition {
  row: number;
  column: number;
}

function blankCell(style: Style = DEFAULT_STYLE): Cell {
  return { char: '', style, continuation: false };
}

function blankRow(columns: number, style?: Style): Array<Cell> {
  return Array.from({ length: columns }, () => blankCell(style));
}

/** How wide a codepoint is on screen. Replaced by the library when present. */
export type WidthOf = (codepoint: number) => number;

const DEFAULT_WIDTH_OF: WidthOf = (codepoint) => {
  if (codepoint === 0) return 0;
  // A crude fallback: the ranges that are unambiguously wide. It is only used
  // when libghostty-vt is absent, and only affects alignment of CJK text.
  if (
    (codepoint >= 0x1100 && codepoint <= 0x115f) ||
    (codepoint >= 0x2e80 && codepoint <= 0xa4cf) ||
    (codepoint >= 0xac00 && codepoint <= 0xd7a3) ||
    (codepoint >= 0xf900 && codepoint <= 0xfaff) ||
    (codepoint >= 0xfe30 && codepoint <= 0xfe6f) ||
    (codepoint >= 0xff00 && codepoint <= 0xff60) ||
    (codepoint >= 0xffe0 && codepoint <= 0xffe6) ||
    (codepoint >= 0x20000 && codepoint <= 0x3fffd)
  ) {
    return 2;
  }
  // Combining marks take no room of their own.
  if (codepoint >= 0x0300 && codepoint <= 0x036f) return 0;
  return 1;
};

export interface ScreenOptions {
  rows: number;
  columns: number;
  /** How many rows of history to keep. Scrollback is off when zero. */
  scrollback?: number;
  widthOf?: WidthOf;
}

export class VtScreen {
  rows: number;
  columns: number;

  private readonly widthOf: WidthOf;
  private readonly scrollbackLimit: number;

  /** The visible grid. Replaced wholesale when the alternate screen is used. */
  private grid: Array<Array<Cell>>;
  /** Rows that have scrolled off the top of the main grid. */
  private history: Array<Array<Cell>> = [];

  /** The main grid, parked here while the alternate screen is showing. */
  private parkedGrid: Array<Array<Cell>> | null = null;
  private parkedCursor: CursorPosition | null = null;

  private cursorRow = 0;
  private cursorColumn = 0;
  private saved: { row: number; column: number; style: Style } | null = null;

  style: Style = cloneStyle(DEFAULT_STYLE);

  /** The scrolling region, as inclusive row indices. */
  private scrollTop = 0;
  private scrollBottom: number;

  /**
   * Whether the next printed character wraps first. See the note at the top:
   * writing into the last column arms this rather than moving the cursor.
   */
  private pendingWrap = false;

  cursorVisible = true;
  autoWrap = true;
  /** Set by a program that wants bracketed paste; the panel reads it. */
  bracketedPaste = false;

  /**
   * Whether a program has asked to be told about the mouse.
   *
   * This decides who a wheel belongs to. A program that tracks the mouse does
   * its own scrolling -- an agent's transcript, a pager, an editor -- and in a
   * real terminal the wheel goes to it, not to the window's scrollback. Getting
   * this backwards is why a full-screen program can look like it will not
   * scroll at all.
   */
  mouseTracking = false;
  /** Whether it wants the modern encoding, which is the only one worth sending. */
  mouseSgr = false;
  /** The window title a program last set, if any. */
  title = '';

  /**
   * How far back the person has scrolled, in rows above the live bottom.
   *
   * Zero means they are watching the present, which is where a terminal starts
   * and where it returns the moment they type. While it is non-zero, output
   * still arrives and still enters history; what must not happen is the text
   * they are reading sliding upward under them, so a row leaving the screen
   * bumps this by one and the view stays where it was put.
   */
  private scrollOffset = 0;

  /**
   * How many times anything drawable has changed.
   *
   * Output arrives constantly and much of it changes nothing a person can see:
   * a program rewriting a status line with the same text, a cursor save and
   * restore, a mode set twice. Every published frame is a whole screen encoded
   * as JSON and rebuilt in the shell that also draws the bar and the lock
   * screen, so publishing one that looks identical is work spent on nothing.
   * This is what lets the caller tell those apart.
   */
  private mutations = 0;

  /** Bumped whenever the screen or the cursor moved. */
  get revision(): number {
    return this.mutations;
  }

  private touch(): void {
    this.mutations += 1;
  }

  constructor(options: ScreenOptions) {
    this.rows = Math.max(1, options.rows);
    this.columns = Math.max(1, options.columns);
    this.scrollbackLimit = Math.max(0, options.scrollback ?? 1000);
    this.widthOf = options.widthOf ?? DEFAULT_WIDTH_OF;
    this.grid = Array.from({ length: this.rows }, () => blankRow(this.columns));
    this.scrollBottom = this.rows - 1;
  }

  get cursor(): CursorPosition {
    return { row: this.cursorRow, column: this.cursorColumn };
  }

  get onAlternateScreen(): boolean {
    return this.parkedGrid !== null;
  }

  get historyLength(): number {
    return this.history.length;
  }

  // -- printing ------------------------------------------------------------

  /** Write text at the cursor, wrapping and scrolling as a terminal does. */
  print(text: string): void {
    for (const character of text) {
      this.printGrapheme(character);
    }
  }

  private printGrapheme(character: string): void {
    this.touch();
    const codepoint = character.codePointAt(0) ?? 0;
    const width = this.widthOf(codepoint);

    // A combining mark belongs to the cell before it rather than a cell of its
    // own, which is what makes an accented letter one character wide.
    if (width === 0) {
      const target = this.cellLeftOfCursor();
      if (target) target.char += character;
      return;
    }

    if (this.pendingWrap) {
      this.pendingWrap = false;
      this.carriageReturn();
      this.lineFeed();
    }

    // A double-width character will not straddle the right edge; it wraps.
    if (width === 2 && this.cursorColumn === this.columns - 1) {
      this.setCell(this.cursorRow, this.cursorColumn, blankCell(cloneStyle(this.style)));
      this.carriageReturn();
      this.lineFeed();
    }

    const cell = this.cellAt(this.cursorRow, this.cursorColumn);
    cell.char = character;
    cell.style = cloneStyle(this.style);
    cell.continuation = false;

    if (width === 2) {
      const right = this.cellAt(this.cursorRow, this.cursorColumn + 1);
      right.char = '';
      right.style = cloneStyle(this.style);
      right.continuation = true;
    }

    const advance = width;
    if (this.cursorColumn + advance >= this.columns) {
      this.cursorColumn = this.columns - 1;
      this.pendingWrap = this.autoWrap;
    } else {
      this.cursorColumn += advance;
    }
  }

  private cellLeftOfCursor(): Cell | null {
    let column = this.cursorColumn - 1;
    while (column >= 0 && this.cellAt(this.cursorRow, column).continuation) column -= 1;
    return column >= 0 ? this.cellAt(this.cursorRow, column) : null;
  }

  // -- control characters --------------------------------------------------

  carriageReturn(): void {
    this.touch();
    this.cursorColumn = 0;
    this.pendingWrap = false;
  }

  lineFeed(): void {
    this.touch();
    this.pendingWrap = false;
    if (this.cursorRow === this.scrollBottom) {
      this.scrollUp(1);
      return;
    }
    if (this.cursorRow < this.rows - 1) this.cursorRow += 1;
  }

  /** Reverse index: up one line, scrolling the region down at the top. */
  reverseIndex(): void {
    this.touch();
    this.pendingWrap = false;
    if (this.cursorRow === this.scrollTop) {
      this.scrollDown(1);
      return;
    }
    if (this.cursorRow > 0) this.cursorRow -= 1;
  }

  backspace(): void {
    this.touch();
    this.pendingWrap = false;
    if (this.cursorColumn > 0) this.cursorColumn -= 1;
  }

  /** Tab stops every eight columns, which is what a terminal does by default. */
  tab(): void {
    this.touch();
    this.pendingWrap = false;
    const next = Math.min(this.columns - 1, (Math.floor(this.cursorColumn / 8) + 1) * 8);
    this.cursorColumn = next;
  }

  // -- cursor --------------------------------------------------------------

  moveCursor(row: number, column: number): void {
    this.touch();
    this.cursorRow = clamp(row, 0, this.rows - 1);
    this.cursorColumn = clamp(column, 0, this.columns - 1);
    this.pendingWrap = false;
  }

  moveCursorBy(rowDelta: number, columnDelta: number): void {
    this.moveCursor(this.cursorRow + rowDelta, this.cursorColumn + columnDelta);
  }

  saveCursor(): void {
    this.saved = {
      row: this.cursorRow,
      column: this.cursorColumn,
      style: cloneStyle(this.style),
    };
  }

  restoreCursor(): void {
    if (!this.saved) return;
    this.touch();
    this.cursorRow = clamp(this.saved.row, 0, this.rows - 1);
    this.cursorColumn = clamp(this.saved.column, 0, this.columns - 1);
    this.style = cloneStyle(this.saved.style);
    this.pendingWrap = false;
  }

  // -- erasing -------------------------------------------------------------

  /** 0 clears to the end, 1 clears to the start, 2 clears the whole line. */
  eraseInLine(mode: 0 | 1 | 2): void {
    this.touch();
    const from = mode === 0 ? this.cursorColumn : 0;
    const to = mode === 1 ? this.cursorColumn : this.columns - 1;
    for (let column = from; column <= to; column += 1) {
      this.setCell(this.cursorRow, column, blankCell(cloneStyle(this.style)));
    }
    this.pendingWrap = false;
  }

  /**
   * 0 clears to the end of the screen, 1 to the start, 2 the whole screen, and
   * 3 the scrollback as well.
   */
  eraseInDisplay(mode: 0 | 1 | 2 | 3): void {
    this.touch();
    if (mode === 3) {
      this.history = [];
      return;
    }
    if (mode === 2) {
      for (let row = 0; row < this.rows; row += 1) {
        this.grid[row] = blankRow(this.columns, cloneStyle(this.style));
      }
      this.pendingWrap = false;
      return;
    }
    if (mode === 0) {
      this.eraseInLine(0);
      for (let row = this.cursorRow + 1; row < this.rows; row += 1) {
        this.grid[row] = blankRow(this.columns, cloneStyle(this.style));
      }
      return;
    }
    this.eraseInLine(1);
    for (let row = 0; row < this.cursorRow; row += 1) {
      this.grid[row] = blankRow(this.columns, cloneStyle(this.style));
    }
  }

  /** Blank `count` cells from the cursor without moving anything. */
  eraseCharacters(count: number): void {
    this.touch();
    for (let offset = 0; offset < count; offset += 1) {
      const column = this.cursorColumn + offset;
      if (column >= this.columns) break;
      this.setCell(this.cursorRow, column, blankCell(cloneStyle(this.style)));
    }
  }

  // -- insert and delete ---------------------------------------------------

  insertLines(count: number): void {
    this.touch();
    if (this.cursorRow < this.scrollTop || this.cursorRow > this.scrollBottom) return;
    for (let done = 0; done < count; done += 1) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.cursorRow, 0, blankRow(this.columns, cloneStyle(this.style)));
    }
  }

  deleteLines(count: number): void {
    this.touch();
    if (this.cursorRow < this.scrollTop || this.cursorRow > this.scrollBottom) return;
    for (let done = 0; done < count; done += 1) {
      this.grid.splice(this.cursorRow, 1);
      this.grid.splice(this.scrollBottom, 0, blankRow(this.columns, cloneStyle(this.style)));
    }
  }

  insertCharacters(count: number): void {
    this.touch();
    const row = this.grid[this.cursorRow]!;
    for (let done = 0; done < count; done += 1) {
      row.splice(this.cursorColumn, 0, blankCell(cloneStyle(this.style)));
      row.pop();
    }
  }

  deleteCharacters(count: number): void {
    this.touch();
    const row = this.grid[this.cursorRow]!;
    for (let done = 0; done < count; done += 1) {
      row.splice(this.cursorColumn, 1);
      row.push(blankCell(cloneStyle(this.style)));
    }
  }

  // -- scrolling -----------------------------------------------------------

  /** The scrolling region, given as inclusive row indices. */
  setScrollRegion(top: number, bottom: number): void {
    const first = clamp(top, 0, this.rows - 1);
    const last = clamp(bottom, 0, this.rows - 1);
    if (first >= last) {
      this.scrollTop = 0;
      this.scrollBottom = this.rows - 1;
    } else {
      this.scrollTop = first;
      this.scrollBottom = last;
    }
    this.moveCursor(this.scrollTop, 0);
  }

  scrollUp(count: number): void {
    this.touch();
    for (let done = 0; done < count; done += 1) {
      const leaving = this.grid.splice(this.scrollTop, 1)[0];
      // Only the main screen keeps history, and only when the region is the
      // whole screen. A program scrolling a region is redrawing, not producing
      // output someone will want to scroll back to.
      const keeps =
        leaving !== undefined &&
        !this.onAlternateScreen &&
        this.scrollTop === 0 &&
        this.scrollBottom === this.rows - 1;
      if (keeps) {
        this.history.push(leaving!);
        if (this.history.length > this.scrollbackLimit) {
          this.history.shift();
        } else if (this.scrollOffset > 0) {
          // Hold the reader's place: one row arrived, so the view is one row
          // further from the bottom than it was.
          this.scrollOffset += 1;
        }
      }
      this.grid.splice(this.scrollBottom, 0, blankRow(this.columns, cloneStyle(this.style)));
    }
  }

  scrollDown(count: number): void {
    this.touch();
    for (let done = 0; done < count; done += 1) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.scrollTop, 0, blankRow(this.columns, cloneStyle(this.style)));
    }
  }

  // -- alternate screen ----------------------------------------------------

  setAlternateScreen(active: boolean): void {
    if (active === this.onAlternateScreen) return;
    this.touch();
    // Entering or leaving puts the view back at the present: the grid about to
    // be shown is not the one that was scrolled.
    this.scrollOffset = 0;
    if (active) {
      this.parkedGrid = this.grid;
      this.parkedCursor = { row: this.cursorRow, column: this.cursorColumn };
      this.grid = Array.from({ length: this.rows }, () => blankRow(this.columns));
      this.moveCursor(0, 0);
      return;
    }
    this.grid = this.parkedGrid!;
    const cursor = this.parkedCursor!;
    this.parkedGrid = null;
    this.parkedCursor = null;
    this.moveCursor(cursor.row, cursor.column);
  }

  // -- resize --------------------------------------------------------------

  /**
   * Change the size.
   *
   * Rows are added at the bottom and taken from the top, so what the person is
   * reading stays where it is instead of jumping. Columns are padded or
   * truncated without reflowing: reflow needs to know which rows were wrapped
   * rather than ended, and an attached pane is resized by telling the far end,
   * which redraws. Guessing here would fight that redraw.
   */
  resize(rows: number, columns: number): void {
    const nextRows = Math.max(1, rows);
    const nextColumns = Math.max(1, columns);

    for (const row of this.grid) {
      while (row.length < nextColumns) row.push(blankCell());
      if (row.length > nextColumns) row.length = nextColumns;
    }

    while (this.grid.length < nextRows) this.grid.push(blankRow(nextColumns));
    while (this.grid.length > nextRows) {
      const leaving = this.grid.shift();
      if (leaving && !this.onAlternateScreen) {
        this.history.push(leaving);
        if (this.history.length > this.scrollbackLimit) this.history.shift();
      }
      if (this.cursorRow > 0) this.cursorRow -= 1;
    }

    this.rows = nextRows;
    this.columns = nextColumns;
    this.scrollTop = 0;
    this.scrollBottom = nextRows - 1;
    this.cursorRow = clamp(this.cursorRow, 0, nextRows - 1);
    this.cursorColumn = clamp(this.cursorColumn, 0, nextColumns - 1);
    this.pendingWrap = false;
  }

  /** Back to a blank screen with default everything. */
  reset(): void {
    this.grid = Array.from({ length: this.rows }, () => blankRow(this.columns));
    this.history = [];
    this.parkedGrid = null;
    this.parkedCursor = null;
    this.style = cloneStyle(DEFAULT_STYLE);
    this.cursorRow = 0;
    this.cursorColumn = 0;
    this.saved = null;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.pendingWrap = false;
    this.scrollOffset = 0;
    this.cursorVisible = true;
    this.autoWrap = true;
    this.bracketedPaste = false;
    this.mouseTracking = false;
    this.mouseSgr = false;
  }

  // -- reading it back -----------------------------------------------------

  /**
   * The screen as rows of styled runs, with `historyRows` of scrollback above.
   *
   * Adjacent cells sharing a style become one run, because the panel draws one
   * text item per run and a per-cell item would be thousands of items a frame.
   */
  toRows(historyRows = 0): ReadonlyArray<Row> {
    const wanted = clamp(historyRows, 0, this.history.length);
    const source = [...this.history.slice(this.history.length - wanted), ...this.grid];
    return source.map((cells) => ({ runs: runsOf(cells) }));
  }

  /** Plain text of the visible screen, for tests and for tooltips. */
  toText(): string {
    return this.grid.map((cells) => textOf(cells)).join('\n');
  }

  /**
   * The rows to draw: one screenful, at wherever the person has scrolled to.
   *
   * At the bottom this is the live screen. Above it, the screen's top rows give
   * way to history, which is what scrolling back means.
   */
  viewport(): ReadonlyArray<Row> {
    if (this.scrollOffset === 0) {
      return this.grid.map((cells) => ({ runs: runsOf(cells) }));
    }
    const start = this.viewportStart();
    const shown: Array<Array<Cell>> = [];
    for (let offset = 0; offset < this.rows; offset += 1) {
      shown.push(this.documentRow(start + offset));
    }
    return shown.map((cells) => ({ runs: runsOf(cells) }));
  }

  /**
   * History and the live grid are one document, and the viewport is a window
   * of `rows` on it ending `scrollOffset` rows above the end.
   *
   * Treating them as one sequence rather than as two slices to stitch is what
   * makes the offset mean the same thing however far back it goes, and is why
   * a row arriving can hold the view still by simply bumping the offset.
   */
  private viewportStart(): number {
    const total = this.history.length + this.rows;
    return clamp(total - this.scrollOffset - this.rows, 0, Math.max(0, total - this.rows));
  }

  private documentRow(index: number): Array<Cell> {
    if (index < this.history.length) {
      return this.history[index] ?? blankRow(this.columns);
    }
    return this.grid[index - this.history.length] ?? blankRow(this.columns);
  }

  /** Where the cursor is in the viewport, or off it while scrolled back. */
  viewportCursor(): { row: number; column: number; visible: boolean } {
    const row =
      this.scrollOffset === 0
        ? this.cursorRow
        : this.history.length + this.cursorRow - this.viewportStart();
    return {
      row,
      column: this.cursorColumn,
      // A terminal does not draw a cursor you have scrolled away from.
      visible: this.cursorVisible && this.scrollOffset === 0,
    };
  }

  get offsetFromBottom(): number {
    return this.scrollOffset;
  }

  get atBottom(): boolean {
    return this.scrollOffset === 0;
  }

  /**
   * Scroll by whole rows. Positive goes back into history.
   *
   * The alternate screen has no history, by definition: a full-screen program
   * owns the whole grid and its own scrolling. Refusing here is what a terminal
   * does, and it is why a wheel over a pager moves the pager rather than the
   * window.
   */
  scrollBy(rows: number): void {
    if (this.onAlternateScreen) return;
    this.touch();
    this.scrollOffset = clamp(this.scrollOffset + rows, 0, this.history.length);
  }

  scrollToBottom(): void {
    this.touch();
    this.scrollOffset = 0;
  }

  private cellAt(row: number, column: number): Cell {
    const line = this.grid[clamp(row, 0, this.rows - 1)]!;
    const index = clamp(column, 0, this.columns - 1);
    let cell = line[index];
    if (!cell) {
      cell = blankCell();
      line[index] = cell;
    }
    return cell;
  }

  private setCell(row: number, column: number, cell: Cell): void {
    const line = this.grid[clamp(row, 0, this.rows - 1)];
    if (!line) return;
    line[clamp(column, 0, this.columns - 1)] = cell;
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function sameStyle(a: Style, b: Style): boolean {
  return (
    a.bold === b.bold &&
    a.faint === b.faint &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.blink === b.blink &&
    a.inverse === b.inverse &&
    a.invisible === b.invisible &&
    a.strikethrough === b.strikethrough &&
    a.overline === b.overline &&
    a.link === b.link &&
    sameColor(a.fg, b.fg) &&
    sameColor(a.bg, b.bg) &&
    sameColor(a.underlineColor, b.underlineColor)
  );
}

function sameColor(a: Style['fg'], b: Style['fg']): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'indexed' && b.kind === 'indexed') return a.index === b.index;
  if (a.kind === 'rgb' && b.kind === 'rgb') return a.r === b.r && a.g === b.g && a.b === b.b;
  return true;
}

/** A never-written cell draws as a space. */
function drawable(cell: Cell): string {
  return cell.char === '' ? ' ' : cell.char;
}

function runsOf(cells: ReadonlyArray<Cell>): ReadonlyArray<Run> {
  const runs: Array<Run> = [];
  let text = '';
  let style: Style | null = null;
  let startColumn = 0;
  let cellCount = 0;
  let runWidth = 0;
  let column = 0;

  const close = (): void => {
    if (style === null || text === '') return;
    runs.push({ text, style, column: startColumn, cells: cellCount });
  };

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!;

    // A continuation belongs to the character before it. It is not drawn, but
    // it is a cell, so it counts toward the run's width and the next column.
    if (cell.continuation) {
      if (style !== null) cellCount += 1;
      column += 1;
      continue;
    }

    // How wide this character is, read off the grid rather than measured again:
    // a wide one owns the cell after it.
    const width = cells[index + 1]?.continuation === true ? 2 : 1;

    // A run is broken by a change of style, and a wide character is a run of
    // its own.
    //
    // A terminal puts every character at its own cell and leaves whatever room
    // is left over to the right. A monospace face's CJK glyph is not reliably
    // twice its latin advance, so a run of them drawn as one string drifts from
    // the grid, and padding the difference back in spreads the characters apart
    // -- which is not what a terminal does and is visibly not what anyone
    // wants. One wide character per run lets the panel place each at its column
    // exactly, with nothing added between them.
    const continues =
      style !== null && sameStyle(style, cell.style) && runWidth === 1 && width === 1;

    if (continues) {
      text += drawable(cell);
      cellCount += width;
      column += 1;
      continue;
    }

    close();
    text = drawable(cell);
    style = cell.style;
    startColumn = column;
    cellCount = width;
    runWidth = width;
    column += 1;
  }
  close();

  // Trailing blanks in the default style are not information, and a screen is
  // mostly trailing blanks. Dropping them keeps a nearly empty row from being a
  // hundred spaces. Blanks carrying a background are kept: that is a drawn
  // rectangle, not padding.
  while (runs.length > 0) {
    const last = runs[runs.length - 1]!;
    if (!sameStyle(last.style, DEFAULT_STYLE)) break;
    const trimmed = last.text.replace(/ +$/, '');
    if (trimmed === last.text) break;
    if (trimmed === '') {
      runs.pop();
      continue;
    }
    runs[runs.length - 1] = {
      text: trimmed,
      style: last.style,
      column: last.column,
      cells: last.cells - (last.text.length - trimmed.length),
    };
    break;
  }
  return runs;
}

function textOf(cells: ReadonlyArray<Cell>): string {
  return cells
    .filter((cell) => !cell.continuation)
    .map(drawable)
    .join('')
    .replace(/\s+$/, '');
}
