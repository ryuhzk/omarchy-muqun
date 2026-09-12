/**
 * What the panel draws: a screen as rows of styled runs.
 *
 * This is a display model, not a terminal. herdr and tmux are the terminal
 * emulators, and their APIs hand a client a screen that has already been
 * emulated -- text plus SGR colour, with no cursor motion and no alternate
 * screen. So there is a style, and there are runs of text carrying it, and
 * nothing else.
 */

/** A colour, as the panel needs it: a palette index, or a literal RGB. */
export type Color =
  | { readonly kind: 'default' }
  | { readonly kind: 'indexed'; readonly index: number }
  | { readonly kind: 'rgb'; readonly r: number; readonly g: number; readonly b: number };

export const DEFAULT_COLOR: Color = { kind: 'default' };

/** The underline styles SGR 4 can select. */
export type UnderlineStyle = 0 | 1 | 2 | 3 | 4 | 5;

export interface Style {
  fg: Color;
  bg: Color;
  /**
   * The address a program marked this text with, if any.
   *
   * Terminals have carried hyperlinks for years, and the programs worth
   * watching use them: an agent prints a URL and expects it to be openable
   * rather than retyped. Held on the style so it travels with the run that
   * carries it.
   */
  link: string;
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: UnderlineStyle;
  underlineColor: Color;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
}

export const DEFAULT_STYLE: Style = Object.freeze({
  fg: DEFAULT_COLOR,
  bg: DEFAULT_COLOR,
  link: '',
  bold: false,
  faint: false,
  italic: false,
  underline: 0 as UnderlineStyle,
  underlineColor: DEFAULT_COLOR,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
  overline: false,
});

export function cloneStyle(style: Style): Style {
  return { ...style };
}

/**
 * A stretch of text sharing one style.
 *
 * It carries where it starts and how many cells it covers, because a terminal
 * is a grid and a renderer that lets a font decide the width will drift. A
 * monospace font's CJK glyph is not reliably twice its latin advance, so a row
 * with wide characters in it would end up a few pixels short and every vertical
 * line in a drawn table would stop lining up.
 */
export interface Run {
  readonly text: string;
  readonly style: Style;
  /** Column of the run's first cell. */
  readonly column: number;
  /** How many cells it occupies, counting a wide character as two. */
  readonly cells: number;
}

/** One screen row. */
export interface Row {
  readonly runs: ReadonlyArray<Run>;
}

/** Plain text of a row, for tooltips and for tests. */
export function rowText(row: Row): string {
  return row.runs.map((run) => run.text).join('');
}

/** Plain text of a whole screen. */
export function screenText(rows: ReadonlyArray<Row>): string {
  return rows.map(rowText).join('\n');
}

/** One row the panel has not seen in this form, and where it goes. */
export interface ChangedRow {
  readonly index: number;
  readonly row: Row;
}

/** What the panel is sent for one frame, and what to remember for the next. */
export interface ScreenDelta {
  /**
   * Whether this is the whole screen rather than a patch on the last one.
   *
   * True the first time, and whenever the screen changed shape: a patch on a
   * screen of a different size would be applied to rows that do not line up.
   */
  readonly full: boolean;
  /** The rows that differ from what was last sent, in order. All of them when `full`. */
  readonly changed: ReadonlyArray<ChangedRow>;
  /** How many rows the screen has now. */
  readonly rowCount: number;
  /** One key per row as just sent, to hand back next time. */
  readonly keys: ReadonlyArray<string>;
}

/**
 * The rows that changed since the panel was last told.
 *
 * A pane that prints a line changes one row, and a program that redraws its
 * status bar changes one row, but the terminal hands back a whole new screen
 * of new objects every time it is asked. Comparing what was sent with what is
 * there now, row by row, is what turns a screen a frame into a row a frame.
 * The panel keeps the rows it already has and replaces only these, which is
 * also what keeps its drawing of the unchanged rows in place.
 *
 * Rows are compared by their encoded form because that is what the panel
 * receives: two rows that encode the same are the same row to it, whatever
 * objects they were here.
 */
export function screenDelta(
  sent: ReadonlyArray<string> | null,
  rows: ReadonlyArray<Row>
): ScreenDelta {
  const keys = rows.map((row) => JSON.stringify(row));
  const full = sent === null || sent.length !== rows.length;
  const changed: Array<ChangedRow> = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (full || keys[index] !== sent[index]) changed.push({ index, row });
  }
  return { full, changed, rowCount: rows.length, keys };
}
