/**
 * What the remote watch asks herdr for.
 *
 * `herdr agent wait` answers the moment an agent is in one of the named
 * states, including when it already was. A watch that names the state an
 * agent is already in returns at once, the registry re-reads the host and
 * arms the same watch again, and the machine on the far side is asked the
 * same question several times a second for as long as the panel is loaded.
 * The watch has to ask for a change, which means every state but the one the
 * agent is in now.
 */

import { describe, expect, test } from 'bun:test';
import { watchScript } from '../backend/adapters/herdr-source';

const STATES = ['blocked', 'working', 'idle', 'done', 'unknown'] as const;

describe('herdr watch', () => {
  test('an agent that is done is watched for leaving done, not for reaching it', () => {
    const script = watchScript([{ id: 'w1:p5', status: 'done' }]);
    expect(script).not.toContain('--until done');
    for (const state of STATES) {
      if (state === 'done') continue;
      expect(script).toContain(`--until ${state}`);
    }
  });

  test('a working agent is watched for every state but working', () => {
    const script = watchScript([{ id: 'w1:pA', status: 'working' }]);
    expect(script).not.toContain('--until working');
    expect(script).toContain('--until blocked');
    expect(script).toContain('--until done');
  });

  test('each agent gets its own wait with its own states', () => {
    const script = watchScript([
      { id: 'w1:p5', status: 'done' },
      { id: 'w1:pA', status: 'blocked' },
    ]);
    const lines = script.split('\n');
    const first = lines.find((line) => line.includes("'w1:p5'"));
    const second = lines.find((line) => line.includes("'w1:pA'"));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toContain('--until done');
    expect(first).toContain('--until blocked');
    expect(second).not.toContain('--until blocked');
    expect(second).toContain('--until done');
  });

  test('the hangup trap and the final wait are still there', () => {
    const script = watchScript([{ id: 'w1:p5', status: 'idle' }]);
    expect(script.split('\n')[0]).toContain('trap');
    expect(script.split('\n').pop()).toBe('wait');
  });
});
