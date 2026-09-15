/**
 * `RepoInspector` over git and gh, run where the pane is.
 *
 * The pane's directory is on another machine, and so are its checkout, its
 * remote, and the gh login that can see a private repository's pull requests.
 * So the questions are asked there, in one round trip, and the answers come
 * back as lines for `repoContextFrom` to read.
 *
 * gh is optional. Without it there is still the repository, the branch and the
 * issues the branch names; with it there is also the pull request and what it
 * closes. Nothing here changes anything: two git reads and one gh read.
 */

import { Effect, Layer } from 'effect';
import { repoContextFrom } from '../domain/repo-context';
import { CommandRunner, RepoInspector } from '../application/ports';

/** The exit status the script uses for "not a repository", as opposed to failure. */
const NOT_A_REPO = 3;

/**
 * What runs on the far side. The directory arrives as `$1`, quoted by the
 * runner, so nothing about it is read as shell.
 *
 * `gh pr view` asks GitHub, so it is the one slow line; it is also the one that
 * may not be there, or may not be logged in, and either of those prints
 * nothing rather than failing the whole read. The two gh environment
 * variables keep it from prompting or nagging on a terminal nobody is
 * watching.
 */
export const CONTEXT_SCRIPT = [
  'cd -- "$1" 2>/dev/null || exit 3',
  'root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 3',
  `printf 'root\\t%s\\n' "$root"`,
  `printf 'remote\\t%s\\n' "$(git remote get-url origin 2>/dev/null)"`,
  `printf 'branch\\t%s\\n' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"`,
  'if command -v gh >/dev/null 2>&1; then',
  `  printf 'pr\\t%s\\n' "$(GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 gh pr view --json number,url,title,state,closingIssuesReferences 2>/dev/null | tr -d '\\n')"`,
  'fi',
].join('\n');

export const GitContextLayer = Layer.effect(
  RepoInspector,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    return RepoInspector.of({
      inspect: (alias, cwd) =>
        cwd.trim() === ''
          ? Effect.succeed(null)
          : runner
              .run(alias, ['sh', '-c', CONTEXT_SCRIPT, 'sh', cwd])
              .pipe(
                Effect.map((result) =>
                  result.code === NOT_A_REPO || !result.ok ? null : repoContextFrom(result.stdout)
                )
              ),
    });
  })
);
