/**
 * Resolve subprocess binaries from fixed directories instead of PATH.
 *
 * A bare command name follows whatever the shell's environment says `PATH` is,
 * and a shadowed executable or loader setting can run code inside a boundary
 * that was meant to be closed. These helpers pick a candidate only from
 * directories the distribution owns, and refuse anything that is missing,
 * not a regular file, not executable, or writable outside root.
 */

import { lstatSync } from 'node:fs';

const TRUSTED_BIN_DIRS = ['/usr/bin', '/bin', '/usr/local/bin'] as const;

function isRootOwnedRegularExecutable(path: string): boolean {
  const stat = lstatSync(path);
  if (!stat.isFile()) return false;
  if (stat.uid !== 0) return false;
  if ((stat.mode & 0o022) !== 0) return false;
  if ((stat.mode & 0o111) === 0) return false;
  return true;
}

/** A system binary from a root-owned path under `/usr/bin`, `/bin`, or `/usr/local/bin`. */
export function resolveSystemExecutable(name: string): string {
  for (const dir of TRUSTED_BIN_DIRS) {
    const path = `${dir}/${name}`;
    try {
      if (isRootOwnedRegularExecutable(path)) return path;
    } catch {
      // Missing or unreadable. Try the next directory.
    }
  }
  throw new Error(`missing trusted executable: ${name}`);
}

/** A closed PATH for subprocesses that only need distribution binaries. */
export const TRUSTED_PATH = '/usr/bin:/bin:/usr/local/bin';

const SIDECAR_ENV_NAMES = [
  'HOME',
  'USER',
  'LOGNAME',
  'SSH_AUTH_SOCK',
  'XDG_RUNTIME_DIR',
  'WAYLAND_DISPLAY',
  'DISPLAY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
] as const;

/** The smallest environment the sidecar needs for ssh, Wayland, and locale. */
export function sidecarEnvironment(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { PATH: TRUSTED_PATH };
  for (const name of SIDECAR_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  if (extra !== undefined) {
    for (const [name, value] of Object.entries(extra)) {
      env[name] = value;
    }
  }
  return env;
}

/** What `wl-clipboard` needs to reach the session compositor. */
export function clipboardEnvironment(): Record<string, string> {
  const env: Record<string, string> = { PATH: TRUSTED_PATH };
  for (const name of ['WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'] as const) {
    const value = process.env[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return env;
}

/** What a detached browser opener needs besides the URL itself. */
export function desktopOpenEnvironment(): Record<string, string> {
  const env: Record<string, string> = { PATH: TRUSTED_PATH };
  for (const name of ['HOME', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'DISPLAY'] as const) {
    const value = process.env[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return env;
}
