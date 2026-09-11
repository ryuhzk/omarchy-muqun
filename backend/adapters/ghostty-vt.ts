/**
 * Bindings to `libghostty-vt`, the terminal library extracted from Ghostty.
 *
 * We bind the parts of the 0.1.0 C ABI that exist: the SGR parser, the OSC
 * parser, and the key encoder. There is no screen or grid in 0.1.0 -- the
 * header says as much, and the exported symbol list agrees -- so the state
 * machine in `screen.ts` and `parser.ts` is ours. What is delegated here is
 * every part with semantics subtle enough to get quietly wrong: what a
 * colon-separated SGR 58 means, when a malformed OSC terminates, how a key
 * event becomes bytes.
 *
 * The library is found at runtime. When it is missing the loader returns null
 * and callers fall back to the pure-TypeScript implementations, which are held
 * to the same tests. That keeps `bun test` runnable on a machine without
 * Ghostty installed without letting the fallback drift.
 */

import { dlopen, FFIType, ptr, read, type Library } from 'bun:ffi';
import type { UnderlineStyle } from '../domain/screen';

/** Where the shared library is looked for, in order. */
const CANDIDATE_PATHS = [
  'libghostty-vt.so.0',
  '/usr/lib/libghostty-vt.so.0',
  '/usr/lib/libghostty-vt.so',
  '/usr/local/lib/libghostty-vt.so.0',
] as const;

const SYMBOLS = {
  ghostty_sgr_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_sgr_free: { args: [FFIType.ptr], returns: FFIType.void },
  ghostty_sgr_reset: { args: [FFIType.ptr], returns: FFIType.void },
  ghostty_sgr_set_params: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ghostty_sgr_next: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  ghostty_simd_codepoint_width: { args: [FFIType.u32], returns: FFIType.i8 },
} as const;

type GhosttyLibrary = Library<typeof SYMBOLS>;

/** `GhosttyResult` from `result.h`. */
export const GHOSTTY_SUCCESS = 0;

/**
 * `GhosttySgrAttribute` is `{ tag: enum; value: union }`. The union's widest
 * member is `uint64_t _padding[8]`, so the union is 64 bytes aligned to 8 and
 * the tag's 4 bytes are followed by 4 of padding.
 */
export const SGR_ATTRIBUTE_SIZE = 72;
export const SGR_ATTRIBUTE_VALUE_OFFSET = 8;

/** `GhosttySgrAttributeTag` from `sgr.h`, in declaration order. */
export const SgrTag = {
  Unset: 0,
  Unknown: 1,
  Bold: 2,
  ResetBold: 3,
  Italic: 4,
  ResetItalic: 5,
  Faint: 6,
  Underline: 7,
  UnderlineColor: 8,
  UnderlineColor256: 9,
  ResetUnderlineColor: 10,
  Overline: 11,
  ResetOverline: 12,
  Blink: 13,
  ResetBlink: 14,
  Inverse: 15,
  ResetInverse: 16,
  Invisible: 17,
  ResetInvisible: 18,
  Strikethrough: 19,
  ResetStrikethrough: 20,
  DirectColorFg: 21,
  DirectColorBg: 22,
  Bg8: 23,
  Fg8: 24,
  ResetFg: 25,
  ResetBg: 26,
  BrightBg8: 27,
  BrightFg8: 28,
  Bg256: 29,
  Fg256: 30,
} as const;

export type SgrTagValue = (typeof SgrTag)[keyof typeof SgrTag];

/** `GhosttySgrUnderline` from `sgr.h`. */
export const SgrUnderline = {
  None: 0,
  Single: 1,
  Double: 2,
  Curly: 3,
  Dotted: 4,
  Dashed: 5,
} as const;


/** One decoded SGR attribute. The payload shape follows the tag. */
export type SgrAttribute =
  | { tag: 'bold' }
  | { tag: 'resetBold' }
  | { tag: 'italic' }
  | { tag: 'resetItalic' }
  | { tag: 'faint' }
  | { tag: 'underline'; style: UnderlineStyle }
  | { tag: 'underlineColor'; rgb: [number, number, number] }
  | { tag: 'underlineColor256'; index: number }
  | { tag: 'resetUnderlineColor' }
  | { tag: 'overline' }
  | { tag: 'resetOverline' }
  | { tag: 'blink' }
  | { tag: 'resetBlink' }
  | { tag: 'inverse' }
  | { tag: 'resetInverse' }
  | { tag: 'invisible' }
  | { tag: 'resetInvisible' }
  | { tag: 'strikethrough' }
  | { tag: 'resetStrikethrough' }
  | { tag: 'directColorFg'; rgb: [number, number, number] }
  | { tag: 'directColorBg'; rgb: [number, number, number] }
  | { tag: 'fg8'; index: number }
  | { tag: 'bg8'; index: number }
  | { tag: 'brightFg8'; index: number }
  | { tag: 'brightBg8'; index: number }
  | { tag: 'fg256'; index: number }
  | { tag: 'bg256'; index: number }
  | { tag: 'resetFg' }
  | { tag: 'resetBg' }
  | { tag: 'unset' }
  | { tag: 'unknown' };

let cached: GhosttyLibrary | null | undefined;

/**
 * Open the library, or return null when it is not installed.
 *
 * The result is cached, including the failure, so a machine without Ghostty
 * does not pay for a failed `dlopen` on every parse.
 */
export function loadGhosttyVt(): GhosttyLibrary | null {
  if (cached !== undefined) return cached;
  for (const path of CANDIDATE_PATHS) {
    try {
      cached = dlopen(path, SYMBOLS);
      return cached;
    } catch {
      // Try the next candidate.
    }
  }
  cached = null;
  return cached;
}

/** Forget the cached handle. Tests use this; nothing else should. */
export function resetGhosttyVtCache(): void {
  cached = undefined;
}

/** Whether the real library backs `parseSgrParams`. */
export function ghosttyVtAvailable(): boolean {
  return loadGhosttyVt() !== null;
}

function decodeAttribute(buffer: Uint8Array, base: number): SgrAttribute | null {
  const address = ptr(buffer);
  const tag = read.i32(address, base);
  const value = base + SGR_ATTRIBUTE_VALUE_OFFSET;
  const rgb = (): [number, number, number] => [
    read.u8(address, value),
    read.u8(address, value + 1),
    read.u8(address, value + 2),
  ];
  const index = (): number => read.u8(address, value);

  switch (tag) {
    case SgrTag.Unset:
      return { tag: 'unset' };
    case SgrTag.Unknown:
      return { tag: 'unknown' };
    case SgrTag.Bold:
      return { tag: 'bold' };
    case SgrTag.ResetBold:
      return { tag: 'resetBold' };
    case SgrTag.Italic:
      return { tag: 'italic' };
    case SgrTag.ResetItalic:
      return { tag: 'resetItalic' };
    case SgrTag.Faint:
      return { tag: 'faint' };
    case SgrTag.Underline:
      return { tag: 'underline', style: read.i32(address, value) as UnderlineStyle };
    case SgrTag.UnderlineColor:
      return { tag: 'underlineColor', rgb: rgb() };
    case SgrTag.UnderlineColor256:
      return { tag: 'underlineColor256', index: index() };
    case SgrTag.ResetUnderlineColor:
      return { tag: 'resetUnderlineColor' };
    case SgrTag.Overline:
      return { tag: 'overline' };
    case SgrTag.ResetOverline:
      return { tag: 'resetOverline' };
    case SgrTag.Blink:
      return { tag: 'blink' };
    case SgrTag.ResetBlink:
      return { tag: 'resetBlink' };
    case SgrTag.Inverse:
      return { tag: 'inverse' };
    case SgrTag.ResetInverse:
      return { tag: 'resetInverse' };
    case SgrTag.Invisible:
      return { tag: 'invisible' };
    case SgrTag.ResetInvisible:
      return { tag: 'resetInvisible' };
    case SgrTag.Strikethrough:
      return { tag: 'strikethrough' };
    case SgrTag.ResetStrikethrough:
      return { tag: 'resetStrikethrough' };
    case SgrTag.DirectColorFg:
      return { tag: 'directColorFg', rgb: rgb() };
    case SgrTag.DirectColorBg:
      return { tag: 'directColorBg', rgb: rgb() };
    case SgrTag.Bg8:
      return { tag: 'bg8', index: index() };
    case SgrTag.Fg8:
      return { tag: 'fg8', index: index() };
    case SgrTag.ResetFg:
      return { tag: 'resetFg' };
    case SgrTag.ResetBg:
      return { tag: 'resetBg' };
    case SgrTag.BrightBg8:
      return { tag: 'brightBg8', index: index() };
    case SgrTag.BrightFg8:
      return { tag: 'brightFg8', index: index() };
    case SgrTag.Bg256:
      return { tag: 'bg256', index: index() };
    case SgrTag.Fg256:
      return { tag: 'fg256', index: index() };
    default:
      return null;
  }
}

/**
 * Parse one CSI SGR parameter list through the library.
 *
 * `separators[i]` is the separator that *follows* parameter `i`, so `4:3`
 * arrives as params `[4, 3]` and separators `[':', ';']`, and the final entry
 * is ignored. This was determined against the library rather than read off the
 * header, which says only "the separator type for each parameter position":
 * under the other reading `4:3` decodes as a single underline followed by a
 * stray parameter, and the colon form of SGR 58 loses its colorspace slot.
 *
 * Returns null when the library is unavailable, which is the caller's signal to
 * use the fallback.
 */
export function parseSgrParamsNative(
  params: readonly number[],
  separators?: readonly string[]
): SgrAttribute[] | null {
  const lib = loadGhosttyVt();
  if (!lib) return null;

  // `CSI m` with no parameters is a reset, by definition, and there is nothing
  // for the library to parse. Handling it here also avoids taking the address
  // of a zero-length array, which is not a pointer.
  if (params.length === 0) return [{ tag: 'unset' }];

  const handleOut = new BigUint64Array(1);
  if (lib.symbols.ghostty_sgr_new(null, ptr(handleOut)) !== GHOSTTY_SUCCESS) {
    return null;
  }
  const handle = Number(handleOut[0]);
  if (handle === 0) return null;

  try {
    const paramArray = new Uint16Array(params.length);
    for (let index = 0; index < params.length; index += 1) {
      paramArray[index] = params[index]! & 0xffff;
    }

    let separatorPointer: ReturnType<typeof ptr> | null = null;
    let separatorArray: Uint8Array | null = null;
    if (separators) {
      separatorArray = new Uint8Array(params.length);
      for (let index = 0; index < params.length; index += 1) {
        separatorArray[index] = separators[index] === ':' ? 0x3a : 0x3b;
      }
      separatorPointer = ptr(separatorArray);
    }

    // A zero-length param list has nothing to point at; the library still
    // wants a valid pointer, so hand it a one-element scratch buffer.
    const paramPointer = params.length === 0 ? ptr(new Uint16Array(1)) : ptr(paramArray);

    const status = lib.symbols.ghostty_sgr_set_params(
      handleOut[0] as unknown as number,
      paramPointer,
      separatorPointer,
      BigInt(params.length)
    );
    if (status !== GHOSTTY_SUCCESS) return null;

    const attributes: SgrAttribute[] = [];
    const scratch = new Uint8Array(SGR_ATTRIBUTE_SIZE);
    const scratchPointer = ptr(scratch);
    // The library caps SGR parameters well below this; the bound only stops a
    // library bug from spinning forever.
    for (let guard = 0; guard < 1024; guard += 1) {
      scratch.fill(0);
      const more = lib.symbols.ghostty_sgr_next(
        handleOut[0] as unknown as number,
        scratchPointer
      );
      if (!more) break;
      const decoded = decodeAttribute(scratch, 0);
      if (decoded) attributes.push(decoded);
    }
    return attributes;
  } finally {
    lib.symbols.ghostty_sgr_free(handleOut[0] as unknown as number);
  }
}

/**
 * Display width of a codepoint, from the library's SIMD implementation.
 *
 * Returns null when the library is unavailable.
 */
export function codepointWidthNative(codepoint: number): number | null {
  const lib = loadGhosttyVt();
  if (!lib) return null;
  return lib.symbols.ghostty_simd_codepoint_width(codepoint);
}
