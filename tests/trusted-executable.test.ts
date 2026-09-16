import { describe, expect, test } from 'bun:test';
import {
  clipboardEnvironment,
  resolveSystemExecutable,
  sidecarEnvironment,
  TRUSTED_PATH,
} from '../backend/adapters/trusted-executable';

describe('trusted executables', () => {
  test('resolveSystemExecutable finds ssh under /usr/bin', () => {
    expect(resolveSystemExecutable('ssh')).toBe('/usr/bin/ssh');
  });

  test('sidecarEnvironment pins PATH and keeps ssh-related variables', () => {
    const previous = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    process.env.BUN_INSTALL = '/tmp/evil';

    const env = sidecarEnvironment({ TERM: 'xterm-256color' });

    expect(env.PATH).toBe(TRUSTED_PATH);
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.BUN_INSTALL).toBeUndefined();

    if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous;
    delete process.env.BUN_INSTALL;
  });

  test('clipboardEnvironment only exposes Wayland session variables', () => {
    process.env.WAYLAND_DISPLAY = 'wayland-1';
    process.env.HOME = '/home/tester';

    const env = clipboardEnvironment();

    expect(env.PATH).toBe(TRUSTED_PATH);
    expect(env.WAYLAND_DISPLAY).toBe('wayland-1');
    expect(env.HOME).toBeUndefined();
  });
});
