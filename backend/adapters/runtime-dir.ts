/**
 * Where this plugin keeps the files it needs while it is running.
 *
 * A control socket and a couple of video frames, neither of which should
 * outlive the session or be readable by anyone else on the machine.
 * `XDG_RUNTIME_DIR` is exactly that directory: per-user, mode 0700, and cleared
 * when the session ends.
 *
 * The fallback is deliberately not `/tmp`. `/tmp` is world-writable, which
 * means anything there can be replaced by another user between the moment it is
 * checked and the moment it is used. A cache directory under the user's own
 * home has none of that, and is created with owner-only permissions.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const FALLBACK_NAME = '.cache/omarchy-muqun';

let resolved: string | null = null;

/** The directory, created if it is not there yet. Answered once per process. */
export function runtimeDirectory(): string {
  if (resolved !== null) return resolved;

  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && runtime !== '') {
    resolved = runtime;
    return resolved;
  }

  const fallback = `${homedir()}/${FALLBACK_NAME}`;
  try {
    mkdirSync(fallback, { recursive: true, mode: 0o700 });
  } catch {
    // Already there, or a home directory that cannot be written to. The caller
    // will find out when it tries to use the path, and will say so then.
  }
  resolved = fallback;
  return resolved;
}
