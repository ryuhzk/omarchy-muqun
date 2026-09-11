/**
 * SGR: what a colour sequence means, and what it does to a style.
 *
 * Used by the terminal parser for every `CSI ... m` it meets, and on its own by
 * anything that has a screen already rendered to SGR and only needs it
 * coloured.
 *
 * SGR has real subtlety: `4:3` is a curly underline, and the colon form of 38
 * and 58 carries a colorspace slot the semicolon form does not. So the
 * parameters go through `libghostty-vt` when it is installed. The fallback here
 * covers the same ground and is held to the same tests, so a machine without
 * Ghostty degrades rather than breaks.
 */

import {
  cloneStyle,
  DEFAULT_COLOR,
  DEFAULT_STYLE,
  type Color,
  type Row,
  type Run,
  type Style,
  type UnderlineStyle,
} from '../domain/screen';
import {
  codepointWidthNative,
  ghosttyVtAvailable,
  parseSgrParamsNative,
  type SgrAttribute,
} from './ghostty-vt';

/** Apply one decoded attribute to a style, in place. */
export function applyAttribute(style: Style, attribute: SgrAttribute): void {
  switch (attribute.tag) {
    case 'unset':
      Object.assign(style, DEFAULT_STYLE);
      return;
    case 'bold':
      style.bold = true;
      return;
    case 'resetBold':
      // SGR 22 clears bold and faint together; the library reports one tag.
      style.bold = false;
      style.faint = false;
      return;
    case 'faint':
      style.faint = true;
      return;
    case 'italic':
      style.italic = true;
      return;
    case 'resetItalic':
      style.italic = false;
      return;
    case 'underline':
      style.underline = attribute.style;
      return;
    case 'underlineColor':
      style.underlineColor = rgb(attribute.rgb);
      return;
    case 'underlineColor256':
      style.underlineColor = { kind: 'indexed', index: attribute.index };
      return;
    case 'resetUnderlineColor':
      style.underlineColor = DEFAULT_COLOR;
      return;
    case 'overline':
      style.overline = true;
      return;
    case 'resetOverline':
      style.overline = false;
      return;
    case 'blink':
      style.blink = true;
      return;
    case 'resetBlink':
      style.blink = false;
      return;
    case 'inverse':
      style.inverse = true;
      return;
    case 'resetInverse':
      style.inverse = false;
      return;
    case 'invisible':
      style.invisible = true;
      return;
    case 'resetInvisible':
      style.invisible = false;
      return;
    case 'strikethrough':
      style.strikethrough = true;
      return;
    case 'resetStrikethrough':
      style.strikethrough = false;
      return;
    case 'directColorFg':
      style.fg = rgb(attribute.rgb);
      return;
    case 'directColorBg':
      style.bg = rgb(attribute.rgb);
      return;
    case 'fg8':
    case 'fg256':
    case 'brightFg8':
      style.fg = { kind: 'indexed', index: attribute.index };
      return;
    case 'bg8':
    case 'bg256':
    case 'brightBg8':
      style.bg = { kind: 'indexed', index: attribute.index };
      return;
    case 'resetFg':
      style.fg = DEFAULT_COLOR;
      return;
    case 'resetBg':
      style.bg = DEFAULT_COLOR;
      return;
    case 'unknown':
      return;
  }
}

function rgb(value: readonly [number, number, number]): Color {
  return { kind: 'rgb', r: value[0], g: value[1], b: value[2] };
}

/**
 * Parse an SGR parameter list, preferring the library.
 *
 * Exported with an explicit switch so the tests can drive both paths against
 * one set of expectations.
 */
export function parseSgrParams(
  params: ReadonlyArray<number>,
  separators: ReadonlyArray<string>,
  preferNative = true
): ReadonlyArray<SgrAttribute> {
  if (preferNative && ghosttyVtAvailable()) {
    const native = parseSgrParamsNative(params, separators);
    if (native) return native;
  }
  return parseSgrParamsFallback(params, separators);
}

/**
 * The pure-TypeScript SGR parser.
 *
 * It covers what a pane preview actually meets: the attribute codes, the
 * sixteen named colours, 256-colour and truecolour in both the semicolon and
 * colon forms, and the underline styles. Anything else becomes `unknown`, which
 * renders as no change rather than as a wrong colour.
 */
export function parseSgrParamsFallback(
  params: ReadonlyArray<number>,
  separators: ReadonlyArray<string>
): ReadonlyArray<SgrAttribute> {
  if (params.length === 0) return [{ tag: 'unset' }];

  const attributes: Array<SgrAttribute> = [];
  const colonAfter = (position: number): boolean => separators[position] === ':';
  let index = 0;

  while (index < params.length) {
    const code = params[index]!;

    // The colon forms of 38, 48 and 58 keep their arguments in one parameter
    // group; the semicolon forms spread them across parameters. Both are
    // consumed here so callers never see the difference.
    if (code === 38 || code === 48 || code === 58) {
      const colon = colonAfter(index);
      const kind = params[index + 1];
      if (kind === 2) {
        // The colon form carries a colorspace slot before the components.
        const offset = colon ? index + 3 : index + 2;
        attributes.push(
          colorAttribute(code, {
            kind: 'rgb',
            r: params[offset] ?? 0,
            g: params[offset + 1] ?? 0,
            b: params[offset + 2] ?? 0,
          })
        );
        index = offset + 3;
        continue;
      }
      if (kind === 5) {
        attributes.push(colorAttribute(code, { kind: 'indexed', index: params[index + 2] ?? 0 }));
        index += 3;
        continue;
      }
      attributes.push({ tag: 'unknown' });
      index += 1;
      continue;
    }

    if (code === 4 && colonAfter(index)) {
      attributes.push({ tag: 'underline', style: (params[index + 1] ?? 1) as UnderlineStyle });
      index += 2;
      continue;
    }

    attributes.push(simpleAttribute(code) ?? { tag: 'unknown' });
    index += 1;
  }

  return attributes;
}

function colorAttribute(code: number, color: Color): SgrAttribute {
  if (color.kind === 'rgb') {
    const triple: [number, number, number] = [color.r, color.g, color.b];
    if (code === 38) return { tag: 'directColorFg', rgb: triple };
    if (code === 48) return { tag: 'directColorBg', rgb: triple };
    return { tag: 'underlineColor', rgb: triple };
  }
  if (color.kind === 'indexed') {
    if (code === 38) return { tag: 'fg256', index: color.index };
    if (code === 48) return { tag: 'bg256', index: color.index };
    return { tag: 'underlineColor256', index: color.index };
  }
  return { tag: 'unknown' };
}

function simpleAttribute(code: number): SgrAttribute | null {
  if (code === 0) return { tag: 'unset' };
  if (code === 1) return { tag: 'bold' };
  if (code === 2) return { tag: 'faint' };
  if (code === 3) return { tag: 'italic' };
  if (code === 4) return { tag: 'underline', style: 1 };
  if (code === 5 || code === 6) return { tag: 'blink' };
  if (code === 7) return { tag: 'inverse' };
  if (code === 8) return { tag: 'invisible' };
  if (code === 9) return { tag: 'strikethrough' };
  if (code === 21) return { tag: 'underline', style: 2 };
  if (code === 22) return { tag: 'resetBold' };
  if (code === 23) return { tag: 'resetItalic' };
  if (code === 24) return { tag: 'underline', style: 0 };
  if (code === 25) return { tag: 'resetBlink' };
  if (code === 27) return { tag: 'resetInverse' };
  if (code === 28) return { tag: 'resetInvisible' };
  if (code === 29) return { tag: 'resetStrikethrough' };
  if (code >= 30 && code <= 37) return { tag: 'fg8', index: code - 30 };
  if (code === 39) return { tag: 'resetFg' };
  if (code >= 40 && code <= 47) return { tag: 'bg8', index: code - 40 };
  if (code === 49) return { tag: 'resetBg' };
  if (code === 53) return { tag: 'overline' };
  if (code === 55) return { tag: 'resetOverline' };
  if (code === 59) return { tag: 'resetUnderlineColor' };
  if (code >= 90 && code <= 97) return { tag: 'brightFg8', index: code - 90 + 8 };
  if (code >= 100 && code <= 107) return { tag: 'brightBg8', index: code - 100 + 8 };
  return null;
}

/**
 * Split a CSI body into parameters and the separator that follows each.
 *
 * An empty parameter means its default, which for SGR is zero, so `[;m` is two
 * resets. The separator array uses the convention `libghostty-vt` wants: entry
 * `i` is what came after parameter `i`.
 */
export function splitParams(body: string): {
  params: ReadonlyArray<number>;
  separators: ReadonlyArray<string>;
} {
  const params: Array<number> = [];
  const separators: Array<string> = [];
  let current = '';

  for (const character of body) {
    if (character === ';' || character === ':') {
      params.push(current === '' ? 0 : Number.parseInt(current, 10));
      separators.push(character);
      current = '';
      continue;
    }
    if (character >= '0' && character <= '9') {
      current += character;
      continue;
    }
    // A private marker such as `?`. SGR has none, so the body is not ours.
    return { params: [], separators: [] };
  }

  params.push(current === '' ? 0 : Number.parseInt(current, 10));
  separators.push(';');
  return { params, separators };
}

const ESC = 0x1b;

/**
 * Split an SGR-coloured screen into rows of styled runs.
 *
 * Style carries across rows, because a pane's screen is one stream and a colour
 * set at the end of one line is still in force at the start of the next.
 * Sequences that are not SGR are skipped rather than drawn: they do not occur
 * in this input, and printing their bytes would be worse than dropping them.
 */
export function renderScreen(input: string, preferNative = true): ReadonlyArray<Row> {
  const rows: Array<Row> = [];
  let runs: Array<Run> = [];
  let pending = '';
  let column = 0;
  const style = cloneStyle(DEFAULT_STYLE);

  // How many columns a run occupies, which is not how many characters it has:
  // a Chinese character is one character and two cells wide. The panel places
  // every run on the character grid by these numbers, so a run that reported
  // its length would push the rest of its line sideways.
  const cellsIn = (text: string): number => {
    let total = 0;
    for (const character of text) {
      total += codepointWidthNative(character.codePointAt(0) ?? 0) ?? 1;
    }
    return total;
  };

  const flush = (): void => {
    if (pending === '') return;
    const cells = cellsIn(pending);
    runs.push({ text: pending, style: cloneStyle(style), column, cells });
    column += cells;
    pending = '';
  };
  const endRow = (): void => {
    flush();
    rows.push({ runs });
    runs = [];
    column = 0;
  };

  let index = 0;
  while (index < input.length) {
    const code = input.charCodeAt(index);

    if (code === 0x0a) {
      endRow();
      index += 1;
      continue;
    }
    if (code === 0x0d) {
      // A carriage return at the end of a captured row is line-ending noise.
      index += 1;
      continue;
    }
    if (code !== ESC) {
      pending += input[index];
      index += 1;
      continue;
    }

    const next = input[index + 1];
    if (next !== '[') {
      // Not a CSI. Skip the escape, and its partner for two-character forms,
      // so a stray byte cannot be drawn as text.
      index += next === undefined ? 1 : 2;
      continue;
    }

    let cursor = index + 2;
    let body = '';
    while (cursor < input.length) {
      const character = input.charCodeAt(cursor);
      // Parameter and intermediate bytes, per ECMA-48.
      if (character < 0x30 || character > 0x3f) break;
      body += input[cursor];
      cursor += 1;
    }
    const final = input[cursor];
    cursor += 1;

    if (final === 'm') {
      flush();
      const { params, separators } = splitParams(body);
      for (const attribute of parseSgrParams(params, separators, preferNative)) {
        applyAttribute(style, attribute);
      }
    }
    // Any other final byte is a sequence this input is not supposed to carry.
    // Dropping it is deliberate.
    index = cursor;
  }

  endRow();
  // A capture ends with a newline, which would otherwise add a blank row that
  // is not on the screen.
  if (rows.length > 1 && rows[rows.length - 1]!.runs.length === 0) rows.pop();
  return rows;
}
