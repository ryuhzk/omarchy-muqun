/**
 * Where a pane's work lives: the repository, the branch, and what is open
 * against it on GitHub.
 *
 * An agent works in a directory, and the directory is usually a checkout with
 * a branch, and the branch usually has a pull request, and the request usually
 * closes an issue or two. Those are the links a person reaching for a browser
 * wants next to the pane, and this is the shape they take.
 *
 * Everything here is parsing. The text comes from git and gh running on the
 * machine the pane is on, and a name or a number is checked before it becomes
 * part of a URL somebody will click.
 */

export interface GitHubRepo {
  readonly owner: string;
  readonly name: string;
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  /** Lower case: `open`, `merged`, `closed`, or whatever gh said. */
  readonly state: string;
}

export interface IssueLink {
  readonly number: number;
  readonly url: string;
}

export interface RepoContext {
  /** The checkout's top directory on the machine. */
  readonly root: string;
  /** The GitHub repository the origin points at, or null for anywhere else. */
  readonly remote: GitHubRepo | null;
  /** The branch checked out, or empty when the head is detached. */
  readonly branch: string;
  readonly pullRequest: PullRequest | null;
  /** Issues the branch is about: named in the branch, or closed by the request. */
  readonly issues: ReadonlyArray<IssueLink>;
  /** Addresses to open. Empty strings where there is nothing to open. */
  readonly links: { readonly repo: string; readonly branch: string };
}

/** What a GitHub owner or repository may be called. */
const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * The repository an origin URL names, when it is on GitHub.
 *
 * git writes the same remote four ways -- scp-like, ssh://, https://, and
 * bare -- and people paste all of them. Anything not on github.com is null:
 * this plugin links to GitHub and nowhere else, and an address it did not
 * build is not one it will open.
 */
export function parseGitHubRemote(url: string): GitHubRepo | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/|github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      trimmed
    );
  if (match === null) return null;
  const owner = match[1] ?? '';
  const name = match[2] ?? '';
  if (!NAME.test(owner) || !NAME.test(name) || owner === '.' || name === '.') return null;
  return { owner, name };
}

/**
 * The issue numbers a branch name carries.
 *
 * The conventions are few: a number leading a segment (`123-fix`, `fix/123`),
 * or after `issue` or `gh` (`issue-123`, `gh-123`). A number inside a word is
 * not one -- `v2`, `2024-redesign` -- and a dotted version is not one either.
 */
export function issuesInBranch(branch: string): ReadonlyArray<number> {
  const found: Array<number> = [];
  for (const segment of branch.split('/')) {
    const match = /^(?:(?:issue|gh)[-_]?)?(\d{1,6})(?:[-_]|$)/i.exec(segment);
    if (match === null) continue;
    const number = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isInteger(number) || number <= 0) continue;
    // A year is not an issue. Nothing on GitHub is numbered like one either.
    if (number >= 1900 && number <= 2100 && /^\d{4}-[a-z]/i.test(segment)) continue;
    if (!found.includes(number)) found.push(number);
  }
  return found;
}

function issueUrl(repo: GitHubRepo, number: number): string {
  return `https://github.com/${repo.owner}/${repo.name}/issues/${number}`;
}

function pullUrl(repo: GitHubRepo, number: number): string {
  return `https://github.com/${repo.owner}/${repo.name}/pull/${number}`;
}

/** The pull request gh described, held to what a link may be made of. */
function pullRequestFrom(raw: string, repo: GitHubRepo | null): {
  request: PullRequest | null;
  closes: ReadonlyArray<number>;
} {
  const text = raw.trim();
  if (text === '') return { request: null, closes: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { request: null, closes: [] };
  }
  if (parsed === null || typeof parsed !== 'object') return { request: null, closes: [] };
  const record = parsed as Record<string, unknown>;
  const number = record.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    return { request: null, closes: [] };
  }

  // The address gh gives is used only when it is the one this plugin would
  // have built anyway; otherwise the built one is used. That is what makes
  // "click it" safe whatever came over the wire.
  const built = repo === null ? '' : pullUrl(repo, number);
  const url = typeof record.url === 'string' && record.url === built ? record.url : built;

  const closes: Array<number> = [];
  if (Array.isArray(record.closingIssuesReferences)) {
    for (const entry of record.closingIssuesReferences) {
      const candidate = (entry as { number?: unknown } | null)?.number;
      if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) {
        closes.push(candidate);
      }
    }
  }

  return {
    request: {
      number,
      url,
      title: typeof record.title === 'string' ? record.title : '',
      state: typeof record.state === 'string' ? record.state.toLowerCase() : '',
    },
    closes,
  };
}

/**
 * Read what the far side printed: one `key<TAB>value` per line.
 *
 * `root` is required, because without it this is not a repository. The rest
 * is optional and absent means unknown, not wrong.
 */
export function repoContextFrom(output: string): RepoContext | null {
  const fields = new Map<string, string>();
  for (const line of output.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    fields.set(line.slice(0, tab), line.slice(tab + 1));
  }

  const root = (fields.get('root') ?? '').trim();
  if (root === '') return null;

  const remote = parseGitHubRemote(fields.get('remote') ?? '');
  const rawBranch = (fields.get('branch') ?? '').trim();
  const branch = rawBranch === 'HEAD' ? '' : rawBranch;

  const { request, closes } = pullRequestFrom(fields.get('pr') ?? '', remote);

  const numbers: Array<number> = [];
  for (const number of [...issuesInBranch(branch), ...closes]) {
    if (!numbers.includes(number)) numbers.push(number);
  }
  const issues =
    remote === null ? [] : numbers.map((number) => ({ number, url: issueUrl(remote, number) }));

  return {
    root,
    remote,
    branch,
    pullRequest: request,
    issues,
    links: {
      repo: remote === null ? '' : `https://github.com/${remote.owner}/${remote.name}`,
      branch:
        remote === null || branch === ''
          ? ''
          : `https://github.com/${remote.owner}/${remote.name}/tree/${encodeURIComponent(branch).replaceAll('%2F', '/')}`,
    },
  };
}
