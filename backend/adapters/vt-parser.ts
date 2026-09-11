/**
 * The escape-sequence parser: bytes in, screen operations out.
 *
 * It owns no state a terminal would call its own. Everything it decides ends in
 * a method call on `VtScreen`, which is what keeps the rules of the screen
 * testable without going through escape sequences and the rules of the
 * sequences testable without asserting on a grid.
 *
 * The subtle parts are delegated to `libghostty-vt`, which ships with Ghostty:
 * what an SGR parameter list means, how wide a codepoint is. What is written
 * here is the dispatch, which is tedious but not subtle.
 *
 * The parser is resumable. A stream arrives in whatever pieces the pipe felt
 * like, so a sequence can be cut in half between two chunks; the state and the
 * partial sequence survive to the next call.
 */

import { Layer } from 'effect';
import { applyAttribute, parseSgrParams, splitParams } from './sgr-renderer';
import { codepointWidthNative, ghosttyVtAvailable } from './ghostty-vt';
import { TerminalFactory, type TerminalSize } from '../application/ports';
import { DEFAULT_STYLE, cloneStyle } from '../domain/screen';
import { VtScreen, type WidthOf } from '../domain/vt-screen';

type State = 'ground' | 'escape' | 'escapeFinal' | 'csi' | 'osc' | 'string';

/**
 * The DEC special graphics set: box drawing, sent as letters.
 *
 * A program that draws a frame does not send box-drawing characters. It selects
 * this set with `ESC ( 0` and then sends `q` for a horizontal rule and `x` for
 * a vertical one, which is why a terminal that ignores the selection prints a
 * row of q's where the top of a box should be. Every curses program's borders
 * and tmux's own rules arrive this way.
 */
const DEC_GRAPHICS: Record<string, string> = {
  _: ' ',
  '`': '◆',
  a: '▒',
  b: '␉',
  c: '␌',
  d: '␍',
  e: '␊',
  f: '°',
  g: '±',
  h: '␤',
  i: '␋',
  j: '┘',
  k: '┐',
  l: '┌',
  m: '└',
  n: '┼',
  o: '⎺',
  p: '⎻',
  q: '─',
  r: '⎼',
  s: '⎽',
  t: '├',
  u: '┤',
  v: '┴',
  w: '┬',
  x: '│',
  y: '≤',
  z: '≥',
  '{': 'π',
  '|': '≠',
  '}': '£',
  '~': '·',
};

/** Width measured by the library when it is installed. */
export function widthOf(): WidthOf | undefined {
  if (!ghosttyVtAvailable()) return undefined;
  return (codepoint: number) => codepointWidthNative(codepoint) ?? 1;
}

export class VtParser {
  private state: State = 'ground';
  /** Parameter and intermediate bytes of the sequence being read. */
  private buffer = '';
  /** Which string-terminated sequence we are inside, for OSC and friends. */
  private stringKind = '';
  /**
   * What the two character sets are, and which one the bytes belong to.
   *
   * `ESC ( X` names the first and `ESC ) X` the second; the control bytes SO
   * and SI switch between them. Only `0`, the special graphics set, means
   * anything other than plain ASCII here, because it is the only one anything
   * still uses.
   */
  private charsets: [string, string] = ['B', 'B'];
  private shift: 0 | 1 = 0;
  /** The intermediate byte that began the escape now being read. */
  private pendingIntermediate = '';

  constructor(readonly screen: VtScreen) {}

  /** Feed a chunk. Safe to call with a sequence split across calls. */
  write(input: string): void {
    let pending = '';

    const flush = (): void => {
      if (pending === '') return;
      this.screen.print(pending);
      pending = '';
    };

    for (const character of input) {
      const code = character.codePointAt(0) ?? 0;

      if (this.state === 'ground') {
        if (code === 0x1b) {
          flush();
          this.state = 'escape';
          this.buffer = '';
          continue;
        }
        if (code < 0x20 || code === 0x7f) {
          flush();
          this.control(code);
          continue;
        }
        pending +=
          this.charsets[this.shift] === '0' ? DEC_GRAPHICS[character] ?? character : character;
        continue;
      }

      flush();

      if (this.state === 'escape') {
        this.escape(character, code);
        continue;
      }
      // The byte after an intermediate, such as the `B` of `ESC ( B`. It names
      // a character set, which has to be remembered rather than merely eaten:
      // eating it printed a row of q's where a box's top edge should be, and
      // letting it fall through printed a stray letter at the start of every
      // prompt that reset its charset.
      if (this.state === 'escapeFinal') {
        if (this.pendingIntermediate === '(') this.charsets[0] = character;
        else if (this.pendingIntermediate === ')') this.charsets[1] = character;
        this.pendingIntermediate = '';
        this.state = 'ground';
        continue;
      }
      if (this.state === 'csi') {
        this.csi(character, code);
        continue;
      }
      if (this.state === 'osc' || this.state === 'string') {
        this.stringSequence(character, code);
      }
    }

    flush();
  }

  private control(code: number): void {
    switch (code) {
      case 0x07:
        // A bell. Nothing here rings.
        return;
      case 0x08:
        this.screen.backspace();
        return;
      case 0x09:
        this.screen.tab();
        return;
      // Shift out and shift in: which of the two character sets the bytes that
      // follow belong to.
      case 0x0e:
        this.shift = 1;
        return;
      case 0x0f:
        this.shift = 0;
        return;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.screen.lineFeed();
        return;
      case 0x0d:
        this.screen.carriageReturn();
        return;
      default:
        return;
    }
  }

  private escape(character: string, code: number): void {
    // An intermediate byte: one more byte belongs to this sequence. `ESC ( B`,
    // `ESC ) 0` and `ESC # 8` all arrive this way.
    if (code >= 0x20 && code <= 0x2f) {
      this.pendingIntermediate = character;
      this.state = 'escapeFinal';
      return;
    }

    switch (character) {
      case '[':
        this.state = 'csi';
        this.buffer = '';
        return;
      case ']':
        this.state = 'osc';
        this.buffer = '';
        this.stringKind = 'osc';
        return;
      // DCS, SOS, PM and APC all run to a string terminator and none of them
      // says anything this panel draws, so they are read and dropped.
      case 'P':
      case 'X':
      case '^':
      case '_':
        this.state = 'string';
        this.buffer = '';
        this.stringKind = character;
        return;
      case 'M':
        this.screen.reverseIndex();
        this.state = 'ground';
        return;
      case 'D':
        this.screen.lineFeed();
        this.state = 'ground';
        return;
      case 'E':
        this.screen.carriageReturn();
        this.screen.lineFeed();
        this.state = 'ground';
        return;
      case '7':
        this.screen.saveCursor();
        this.state = 'ground';
        return;
      case '8':
        this.screen.restoreCursor();
        this.state = 'ground';
        return;
      case 'c':
        this.screen.reset();
        this.charsets = ['B', 'B'];
        this.shift = 0;
        this.state = 'ground';
        return;
      default:
        // Single-byte escapes this terminal does not act on.
        this.state = 'ground';
    }
  }

  private csi(character: string, code: number): void {
    // Parameter bytes, then intermediate bytes, then one final byte.
    if (code >= 0x20 && code <= 0x3f) {
      this.buffer += character;
      return;
    }
    const body = this.buffer;
    this.buffer = '';
    this.state = 'ground';
    this.dispatchCsi(body, character);
  }

  private dispatchCsi(body: string, final: string): void {
    const screen = this.screen;

    // `?` marks a private mode. Those are set and reset rather than acted on
    // positionally, so they are handled apart from the numbered sequences.
    if (body.startsWith('?')) {
      if (final === 'h' || final === 'l') {
        this.privateMode(body.slice(1), final === 'h');
      }
      return;
    }

    const numbers = body
      .split(';')
      .map((part) => (part === '' ? 0 : Number.parseInt(part, 10)))
      .map((value) => (Number.isFinite(value) ? value : 0));
    const first = numbers[0] ?? 0;
    // Most sequences treat a missing or zero parameter as one.
    const count = first === 0 ? 1 : first;

    switch (final) {
      case 'A':
        return screen.moveCursorBy(-count, 0);
      case 'B':
        return screen.moveCursorBy(count, 0);
      case 'C':
        return screen.moveCursorBy(0, count);
      case 'D':
        return screen.moveCursorBy(0, -count);
      case 'E':
        screen.moveCursorBy(count, 0);
        return screen.carriageReturn();
      case 'F':
        screen.moveCursorBy(-count, 0);
        return screen.carriageReturn();
      case 'G':
        // Columns are one-based on the wire and zero-based here.
        return screen.moveCursor(screen.cursor.row, count - 1);
      case 'd':
        return screen.moveCursor(count - 1, screen.cursor.column);
      case 'H':
      case 'f': {
        const row = (numbers[0] ?? 1) || 1;
        const column = (numbers[1] ?? 1) || 1;
        return screen.moveCursor(row - 1, column - 1);
      }
      case 'J':
        return screen.eraseInDisplay(asEraseMode(first, 3));
      case 'K':
        return screen.eraseInLine(asEraseMode(first, 2) as 0 | 1 | 2);
      case 'L':
        return screen.insertLines(count);
      case 'M':
        return screen.deleteLines(count);
      case 'P':
        return screen.deleteCharacters(count);
      case '@':
        return screen.insertCharacters(count);
      case 'X':
        return screen.eraseCharacters(count);
      case 'S':
        return screen.scrollUp(count);
      case 'T':
        return screen.scrollDown(count);
      case 'r': {
        const top = (numbers[0] ?? 1) || 1;
        const bottom = numbers[1] && numbers[1] > 0 ? numbers[1] : screen.rows;
        return screen.setScrollRegion(top - 1, bottom - 1);
      }
      case 's':
        return screen.saveCursor();
      case 'u':
        return screen.restoreCursor();
      case 'm':
        return this.sgr(body);
      default:
        return;
    }
  }

  private sgr(body: string): void {
    const { params, separators } = splitParams(body);
    if (params.length === 0) {
      this.screen.style = cloneStyle(DEFAULT_STYLE);
      return;
    }
    for (const attribute of parseSgrParams(params, separators)) {
      applyAttribute(this.screen.style, attribute);
    }
  }

  private privateMode(body: string, set: boolean): void {
    for (const part of body.split(';')) {
      const mode = Number.parseInt(part, 10);
      switch (mode) {
        case 7:
          this.screen.autoWrap = set;
          break;
        case 25:
          this.screen.cursorVisible = set;
          break;
        case 2004:
          this.screen.bracketedPaste = set;
          break;
        // The mouse-tracking modes. Which one a program picks says how much it
        // wants to hear about; for deciding who owns the wheel, any of them
        // means the program does.
        case 1000:
        case 1002:
        case 1003:
          this.screen.mouseTracking = set;
          break;
        case 1006:
          this.screen.mouseSgr = set;
          break;
        case 47:
        case 1047:
          this.screen.setAlternateScreen(set);
          break;
        case 1049:
          // The combined form: save the cursor, then switch. Programs rely on
          // leaving it putting the cursor back where it was.
          if (set) {
            this.screen.saveCursor();
            this.screen.setAlternateScreen(true);
          } else {
            this.screen.setAlternateScreen(false);
            this.screen.restoreCursor();
          }
          break;
        default:
          break;
      }
    }
  }

  private stringSequence(character: string, code: number): void {
    // A string sequence ends at BEL or at ST, which is ESC followed by
    // backslash. The escape is held in the buffer until its partner arrives so
    // a sequence split across two chunks still terminates.
    if (code === 0x07) {
      this.finishString();
      return;
    }
    if (this.buffer.endsWith('')) {
      this.buffer = this.buffer.slice(0, -1);
      if (character === '\\') {
        this.finishString();
        return;
      }
    }
    this.buffer += character;
  }

  private finishString(): void {
    if (this.stringKind === 'osc') this.osc(this.buffer);
    this.buffer = '';
    this.stringKind = '';
    this.state = 'ground';
  }

  /**
   * The window title and hyperlinks.
   *
   * OSC also carries colour queries and clipboard writes. A panel watching
   * someone else's pane has no business answering a query or touching a
   * clipboard, so those are read and dropped.
   *
   * A hyperlink is `OSC 8 ; params ; uri` and is closed by the same with an
   * empty uri. Everything printed in between belongs to it, which is why it is
   * held on the style rather than attached to a position: the run carries it,
   * and a run that is redrawn carries whatever was in force at the time.
   */
  private osc(body: string): void {
    const separator = body.indexOf(';');
    if (separator === -1) return;
    const command = body.slice(0, separator);

    if (command === '0' || command === '1' || command === '2') {
      this.screen.title = body.slice(separator + 1);
      return;
    }

    if (command === '8') {
      const rest = body.slice(separator + 1);
      const split = rest.indexOf(';');
      // `OSC 8 ; params ; uri`. The params are for things like an id that ties
      // two halves of one link together; nothing here needs them.
      const uri = split === -1 ? '' : rest.slice(split + 1);
      this.screen.style.link = safeLink(uri);
    }
  }
}

/**
 * A link worth offering to open.
 *
 * Only http and https. A pane on someone else's machine can print any string it
 * likes, and `file:` or a scheme some desktop handler claims would make a line
 * of terminal output into a way to start things here. Anything else is dropped,
 * so the text still shows and the click does not.
 */
function safeLink(uri: string): string {
  const trimmed = uri.trim();
  if (trimmed === '') return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : '';
  } catch {
    return '';
  }
}

function asEraseMode(value: number, highest: number): 0 | 1 | 2 | 3 {
  const mode = value >= 0 && value <= highest ? value : 0;
  return mode as 0 | 1 | 2 | 3;
}

/** A screen and a parser wired together, sized as asked. */
export function makeTerminal(rows: number, columns: number, scrollback = 2000): VtParser {
  return new VtParser(
    new VtScreen({ rows, columns, scrollback, widthOf: widthOf() })
  );
}

export const VtTerminalFactoryLayer = Layer.succeed(
  TerminalFactory,
  TerminalFactory.of({
    create: (size, scrollback = 2000) => {
      const parser = makeTerminal(size.rows, size.columns, scrollback);
      return {
        write: (chunk) => parser.write(chunk),
        rows: () => parser.screen.viewport(),
        cursor: () => parser.screen.viewportCursor(),
        resize: (next) => parser.screen.resize(next.rows, next.columns),
        reset: () => parser.screen.reset(),
        scrollBy: (rows) => parser.screen.scrollBy(rows),
        scrollToBottom: () => parser.screen.scrollToBottom(),
        get atBottom(): boolean {
          return parser.screen.atBottom;
        },
        get mouseTracking(): boolean {
          return parser.screen.mouseTracking;
        },
        get mouseSgr(): boolean {
          return parser.screen.mouseSgr;
        },
        get bracketedPaste(): boolean {
          return parser.screen.bracketedPaste;
        },
        get historyLength(): number {
          return parser.screen.historyLength;
        },
        get size(): TerminalSize {
          return { rows: parser.screen.rows, columns: parser.screen.columns };
        },
      };
    },
  })
);
