/**
 * `TerminalSourceApi` over tmux.
 *
 * The same use cases as herdr, over a tool that has been doing this since 2007.
 * tmux has no idea what an agent is, so every pane here is `unknown` and the
 * panel says so rather than inventing a status; what tmux does have is every
 * pane on the machine, attachable, which herdr reserves for its agents.
 *
 * tmux is invoked with an argument vector and never with a shell command
 * string. A pane id, a window name or a line of typed text is not ours and must
 * not be able to become syntax.
 */

import { Effect } from 'effect';
import {
  CommandRunner,
  SourceError,
  type AttachedPane,
  type AttachOptions,
  type CommandResult,
  type TerminalSize,
  type TerminalSourceApi,
} from '../application/ports';
import type { Pane } from '../domain/pane';

/**
 * What separates one field from the next.
 *
 * Not a tab, and not any other control character: tmux replaces every
 * unprintable byte in an expanded format with an underscore before it prints
 * it, so a tab-separated format arrives as one unsplittable line. So it has to
 * be printable, which means it could in principle occur in a window name -- and
 * every field that a person can type into is put through tmux's own `s/` first
 * to take it back out. The separator cannot appear inside a field, so splitting
 * is exact rather than hopeful.
 */
const FIELD = '@!@';

/** A field a person names, with the separator removed from it by tmux. */
function safeField(name: string): string {
  return `#{s/${FIELD}//:${name}}`;
}

/**
 * One line per pane.
 *
 * Asked for by name rather than parsed out of tmux's own layout, because these
 * names are tmux's public contract and its default output is not.
 */
const PANE_FORMAT = [
  '#{pane_id}',
  safeField('session_name'),
  '#{window_index}',
  safeField('window_name'),
  safeField('pane_title'),
  safeField('pane_current_command'),
  safeField('pane_current_path'),
  // The machine's own name, so a title that is only the machine's own name can
  // be recognised as tmux's default and ignored.
  safeField('host_short'),
  '#{?pane_active,1,0}',
].join(FIELD);

/** Shells. A pane running one is described by where it is, not by which one. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'nu', 'login']);

/**
 * Tidy what tmux printed.
 *
 * tmux writes an underscore for every byte it will not print, so a title made
 * of status glyphs arrives as a row of them. Collapsing them back to spaces
 * leaves the words that were in there.
 */
function tidy(value: string): string {
  return value.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Read what `list-panes` printed. */
export function panesFrom(output: string): ReadonlyArray<Pane> {
  const panes: Array<Pane> = [];

  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const [id, session, windowIndex, windowName, title, command, path, host, active] =
      line.split(FIELD);
    if (id === undefined || session === undefined || windowIndex === undefined) continue;

    // What to call it, in the order a person would: the title when someone set
    // one, else what is running, else where it is.
    //
    // Two things are thrown out first. A title that is only the machine's name
    // is tmux's default and says nothing about this pane in particular; and a
    // pane running a shell is described by the directory it is sitting in,
    // because a column of seventeen rows all called `zsh` is a column of
    // nothing.
    const running = tidy(command ?? '');
    const directory = (path ?? '').split('/').filter(Boolean).pop() ?? '';
    const named = tidy(title ?? '');
    // `host_short` is the machine's name without its domain, and the title tmux
    // writes by default may carry one, so the domain is allowed for.
    const machine = tidy(host ?? '');
    const isDefault =
      named === '' ||
      named === running ||
      named === id ||
      (machine !== '' && (named === machine || named.startsWith(`${machine}.`)));
    const label = !isDefault
      ? named
      : SHELLS.has(running)
        ? directory || running
        : running || directory || id;

    panes.push({
      id,
      source: 'tmux',
      title: label,
      cwd: path ?? '',
      focused: active === '1',
      // tmux does not model agents. Saying `unknown` is the honest answer and
      // the panel draws it as no opinion rather than as a problem.
      status: 'unknown',
      groupId: `${session}:${windowIndex}`,
      // Where it is, for the second line of the row. The window's name when it
      // says something the label does not already say, and otherwise the
      // session and window it is in -- which is what tells thirteen shells in
      // thirteen sessions apart.
      groupLabel:
        tidy(windowName ?? '') !== '' && tidy(windowName ?? '') !== label
          ? tidy(windowName ?? '')
          : `${session}:${windowIndex}`,
    });
  }

  return panes;
}

/**
 * The remote half of an attached tmux pane.
 *
 * A tmux client attaches to a session, not to a pane, so the pane is selected
 * first and the client then shows the window it is in. That is what tmux is:
 * the other panes in that window are on screen because they are on screen for
 * anyone attached to it. Selecting first and attaching second means the client
 * opens already looking at the right thing.
 *
 * The status line is left alone. Turning it off is a session-wide setting and
 * would change what everyone else attached sees.
 */
function attachScript(paneId: string, size: TerminalSize): string {
  const pane = shellSingleQuote(paneId);
  const rows = Math.max(1, Math.floor(size.rows));
  const columns = Math.max(1, Math.floor(size.columns));
  return [
    `stty rows ${rows} cols ${columns} 2>/dev/null`,
    // Which session the pane is in, asked rather than assumed: `attach-session`
    // wants a session and a pane id is not one. The `=` prefix makes tmux match
    // the name exactly, so a session called `web` cannot be reached by asking
    // for `w`.
    `session=$(tmux display-message -p -t ${pane} '#{session_name}') || exit 1`,
    `tmux select-window -t ${pane} 2>/dev/null`,
    `tmux select-pane -t ${pane} 2>/dev/null`,
    // `-u` says this client speaks UTF-8.
    //
    // tmux decides that from the locale it was started with, and a login over
    // ssh often has no locale at all, in which case it writes an underscore for
    // every character it thinks the client cannot show. A pane full of Chinese
    // came through as a wall of underscores for exactly that reason. Saying so
    // outright is better than sending a locale, which would also change what
    // the programs inside the pane do.
    `exec tmux -u attach-session -t "=$session"`,
  ].join('\n');
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Build the tmux source. The composition root decides where it is offered. */
export const makeTmuxSource = Effect.gen(function* () {
  const runner = yield* CommandRunner;

  const demand = Effect.fnUntraced(function* (
    alias: string,
    command: string,
    result: CommandResult
  ) {
    if (result.ok) return result.stdout;
    return yield* new SourceError({
      alias,
      command,
      message: result.firstError || `tmux ${command} exited ${result.code}`,
    });
  });

  const source: TerminalSourceApi = {
    kind: 'tmux',

    available: (alias) =>
      runner
        .run(alias, ['command', '-v', 'tmux'])
        .pipe(Effect.map((result) => result.ok && result.stdout.trim() !== '')),

    panes: Effect.fnUntraced(function* (alias: string) {
      const result = yield* runner.run(alias, ['tmux', 'list-panes', '-a', '-F', PANE_FORMAT]);
      // No server running is not a failure: it is a machine with tmux
      // installed and nothing in it, which the panel shows as no panes.
      if (!result.ok && /no server running|no sessions/i.test(result.stderr)) return [];
      const listed = yield* demand(alias, 'list-panes', result);
      return panesFrom(listed);
    }),

    read: Effect.fnUntraced(function* (alias: string, paneId: string, lines: number) {
      const result = yield* runner.run(alias, [
        'tmux',
        'capture-pane',
        '-p',
        // Keep the colour, and join what tmux wrapped so a long line reads as
        // the one line it was.
        '-e',
        '-J',
        '-t',
        paneId,
        '-S',
        `-${Math.max(0, Math.floor(lines))}`,
      ]);
      return yield* demand(alias, 'capture-pane', result);
    }),

    sendText: Effect.fnUntraced(function* (alias: string, paneId: string, text: string) {
      // `-l` is literal: what follows is typed, never read as a key name.
      const result = yield* runner.run(alias, ['tmux', 'send-keys', '-t', paneId, '-l', text]);
      yield* demand(alias, 'send-keys', result);
    }),

    sendKeys: Effect.fnUntraced(function* (
      alias: string,
      paneId: string,
      keys: ReadonlyArray<string>
    ) {
      const result = yield* runner.run(alias, ['tmux', 'send-keys', '-t', paneId, ...keys]);
      yield* demand(alias, 'send-keys', result);
    }),

    splitPane: Effect.fnUntraced(function* (
      alias: string,
      paneId: string,
      direction: 'right' | 'down'
    ) {
      const result = yield* runner.run(alias, [
        'tmux',
        'split-window',
        direction === 'right' ? '-h' : '-v',
        '-t',
        paneId,
      ]);
      yield* demand(alias, 'split-window', result);
    }),

    closePane: Effect.fnUntraced(function* (alias: string, paneId: string) {
      const result = yield* runner.run(alias, ['tmux', 'kill-pane', '-t', paneId]);
      yield* demand(alias, 'kill-pane', result);
    }),

    /**
     * A terminal that was not there a moment ago.
     *
     * This is the one thing herdr cannot offer and the reason tmux is here at
     * all: a window nobody has to have arranged in advance, in which anything
     * runs -- an editor, a build, a shell. It is a tmux window rather than a
     * bare ssh shell so that it outlives the panel, and so that it appears in
     * the list beside everything else on the machine.
     *
     * A machine with tmux installed but no server running is the ordinary case
     * on a fresh login, so that is not an error: it means starting the first
     * session rather than adding a window to none.
     */
    newPane: Effect.fnUntraced(function* (alias: string) {
      const added = yield* runner.run(alias, ['tmux', 'new-window', '-P', '-F', '#{pane_id}']);
      if (added.ok) return added.stdout.trim();
      if (!/no server running|no sessions|error connecting|no current session/i.test(added.stderr)) {
        return yield* demand(alias, 'new-window', added);
      }
      const started = yield* runner.run(alias, [
        'tmux',
        'new-session',
        '-d',
        '-s',
        'muqun',
        '-P',
        '-F',
        '#{pane_id}',
      ]);
      const id = yield* demand(alias, 'new-session', started);
      return id.trim();
    }),

    /**
     * tmux has no agents, so there is nothing here that ever returns.
     *
     * The caller races this against its own timer, and a watch that never
     * completes simply means the timer decides how often a tmux host is
     * re-read. Answering "never" is more honest than a poll pretending to be
     * a push.
     */
    waitForAgents: () => Effect.never,

    attach: Effect.fnUntraced(function* (
      alias: string,
      paneId: string,
      size: TerminalSize,
      _options?: AttachOptions
    ) {
      const session = yield* runner.session(
        alias,
        ['sh', '-c', attachScript(paneId, size)],
        { pty: true }
      );
      return {
        output: session.output,
        write: session.write,
        complaint: session.complaint,
      } satisfies AttachedPane;
    }),
  };

  return source;
});
