import { describe, expect, test } from 'bun:test';
import { Effect, Stream } from 'effect';
import { collectBoundedBytes } from '../backend/adapters/clipboard';

describe('collectBoundedBytes', () => {
  test('returns null when output exceeds the limit', async () => {
    const limit = 16;
    const stdout = Stream.fromIterable([
      new Uint8Array([1, 2, 3, 4, 5]),
      new Uint8Array([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]),
    ]);

    const result = await Effect.runPromise(collectBoundedBytes(stdout, limit));
    expect(result).toBeNull();
  });

  test('assembles output that stays within the limit', async () => {
    const stdout = Stream.fromIterable([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
    ]);

    const result = await Effect.runPromise(collectBoundedBytes(stdout, 16));
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });
});
