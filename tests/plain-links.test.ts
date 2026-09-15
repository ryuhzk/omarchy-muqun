/**
 * A URL a program merely printed is a link all the same.
 *
 * Programs that know about terminal hyperlinks mark them; most do not, and
 * print the address as text. The screen finds those and marks them itself,
 * exactly the characters of the address and nothing around them, so the
 * panel underlines and opens them the same way it does the marked ones.
 */

import { describe, expect, test } from 'bun:test';
import { makeTerminal } from '../backend/adapters/vt-parser';
import type { Row } from '../backend/domain/screen';

const ESC = String.fromCharCode(0x1b);

function rowsAfter(input: string, columns = 80): ReadonlyArray<Row> {
  const terminal = makeTerminal(5, columns, 100);
  terminal.write(input);
  return terminal.screen.viewport();
}

function linksIn(row: Row | undefined): Array<{ text: string; link: string; column: number }> {
  return (row?.runs ?? [])
    .filter((run) => run.style.link !== '')
    .map((run) => ({ text: run.text, link: run.style.link, column: run.column }));
}

describe('plain links', () => {
  test('an address printed as text becomes a run of its own with the link on it', () => {
    const rows = rowsAfter('see https://expo.dev/accounts/x/builds/abc for details');
    expect(linksIn(rows[0])).toEqual([
      { text: 'https://expo.dev/accounts/x/builds/abc', link: 'https://expo.dev/accounts/x/builds/abc', column: 4 },
    ]);
    // The words around it are still there, unlinked.
    expect(rows[0]?.runs.map((run) => run.text).join('')).toBe(
      'see https://expo.dev/accounts/x/builds/abc for details'
    );
  });

  test('a sentence-ending mark after the address is not part of it', () => {
    expect(linksIn(rowsAfter('at https://example.com/path.')[0])[0]?.link).toBe(
      'https://example.com/path'
    );
    expect(linksIn(rowsAfter('(see https://example.com/a)')[0])[0]?.link).toBe(
      'https://example.com/a'
    );
    expect(linksIn(rowsAfter('here: https://example.com/b, and')[0])[0]?.link).toBe(
      'https://example.com/b'
    );
  });

  test('a closing bracket that the address opened stays with it', () => {
    expect(linksIn(rowsAfter('https://en.wikipedia.org/wiki/Foo_(bar)')[0])[0]?.link).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    );
  });

  test('only http and https are addresses', () => {
    expect(linksIn(rowsAfter('ftp://x.y/z and file:///etc/passwd and javascript:alert(1)')[0])).toEqual([]);
  });

  test('an address a program already marked is left as the program marked it', () => {
    const marked = `${ESC}]8;;https://real.example/target${ESC}\\click here${ESC}]8;;${ESC}\\`;
    expect(linksIn(rowsAfter(marked)[0])).toEqual([
      { text: 'click here', link: 'https://real.example/target', column: 0 },
    ]);
  });

  test('an address after wide characters lands at the right column', () => {
    const links = linksIn(rowsAfter('中文 https://a.b/c')[0]);
    expect(links).toEqual([{ text: 'https://a.b/c', link: 'https://a.b/c', column: 5 }]);
  });

  test('an address split by a style change is still one address', () => {
    const rows = rowsAfter(`https://a.b/${ESC}[1mbold${ESC}[0m/tail end`);
    const links = linksIn(rows[0]);
    expect(links.map((entry) => entry.link)).toEqual([
      'https://a.b/bold/tail',
      'https://a.b/bold/tail',
      'https://a.b/bold/tail',
    ]);
    expect(links.map((entry) => entry.text).join('')).toBe('https://a.b/bold/tail');
  });

  test('two addresses on one row are two links', () => {
    const links = linksIn(rowsAfter('https://a.b/1 then https://a.b/2')[0]);
    expect(links.map((entry) => entry.link)).toEqual(['https://a.b/1', 'https://a.b/2']);
  });
});
