/**
 * What a pane's working directory says about where its work lives.
 *
 * A remote, a branch, the pull request for that branch and the issues it
 * closes, read out of what git and gh print on the machine the pane is on.
 * Everything here is parsing: the script that runs over there is somebody
 * else's output, and every number and name in it is checked before it turns
 * into a link someone will click.
 */

import { describe, expect, test } from 'bun:test';
import {
  issuesInBranch,
  parseGitHubRemote,
  repoContextFrom,
} from '../backend/domain/repo-context';

describe('a GitHub remote', () => {
  test('is read from every way git writes one', () => {
    const expected = { owner: 'ryuhzk', name: 'omarchy-muqun' };
    expect(parseGitHubRemote('git@github.com:ryuhzk/omarchy-muqun.git')).toEqual(expected);
    expect(parseGitHubRemote('ssh://git@github.com/ryuhzk/omarchy-muqun.git')).toEqual(expected);
    expect(parseGitHubRemote('https://github.com/ryuhzk/omarchy-muqun.git')).toEqual(expected);
    expect(parseGitHubRemote('https://github.com/ryuhzk/omarchy-muqun')).toEqual(expected);
    expect(parseGitHubRemote('https://github.com/ryuhzk/omarchy-muqun/')).toEqual(expected);
  });

  test('anything that is not GitHub, or not a name, is nothing', () => {
    expect(parseGitHubRemote('git@gitlab.com:a/b.git')).toBeNull();
    expect(parseGitHubRemote('https://github.com/only-owner')).toBeNull();
    expect(parseGitHubRemote('https://github.com/a/b/c')).toBeNull();
    expect(parseGitHubRemote('https://github.com/a/<script>')).toBeNull();
    expect(parseGitHubRemote('')).toBeNull();
  });
});

describe('issue numbers in a branch name', () => {
  test('a number that leads a segment is an issue', () => {
    expect(issuesInBranch('123-splash-screen')).toEqual([123]);
    expect(issuesInBranch('fix/45-crash-on-start')).toEqual([45]);
    expect(issuesInBranch('feature/issue-7')).toEqual([7]);
    expect(issuesInBranch('gh-88/retry')).toEqual([88]);
  });

  test('a number inside a word, or a year, is not', () => {
    expect(issuesInBranch('feature/2024-redesign')).toEqual([]);
    expect(issuesInBranch('v2-migration')).toEqual([]);
    expect(issuesInBranch('main')).toEqual([]);
    expect(issuesInBranch('release/1.4.2')).toEqual([]);
  });

  test('the same number twice is one issue', () => {
    expect(issuesInBranch('12/issue-12-fix')).toEqual([12]);
  });
});

describe('the context read from the far side', () => {
  const pr = JSON.stringify({
    number: 42,
    url: 'https://github.com/ryuhzk/omarchy-muqun/pull/42',
    title: 'Splash with Nitro',
    state: 'OPEN',
    closingIssuesReferences: [{ number: 17 }, { number: 18 }],
  });

  test('a repo with a pull request has the request and the issues it closes', () => {
    const context = repoContextFrom(
      [
        'root\t/Users/me/.repos/omarchy-muqun',
        'remote\tgit@github.com:ryuhzk/omarchy-muqun.git',
        'branch\tfix/17-splash',
        `pr\t${pr}`,
      ].join('\n')
    );
    expect(context).not.toBeNull();
    expect(context?.root).toBe('/Users/me/.repos/omarchy-muqun');
    expect(context?.remote).toEqual({ owner: 'ryuhzk', name: 'omarchy-muqun' });
    expect(context?.branch).toBe('fix/17-splash');
    expect(context?.pullRequest).toEqual({
      number: 42,
      url: 'https://github.com/ryuhzk/omarchy-muqun/pull/42',
      title: 'Splash with Nitro',
      state: 'open',
    });
    // 17 from the branch and the request both, once; 18 from the request.
    expect(context?.issues.map((issue) => issue.number)).toEqual([17, 18]);
    expect(context?.issues[0]?.url).toBe('https://github.com/ryuhzk/omarchy-muqun/issues/17');
  });

  test('without gh there is still the repo, the branch and what the branch says', () => {
    const context = repoContextFrom(
      [
        'root\t/work/app',
        'remote\thttps://github.com/acme/app.git',
        'branch\t123-login',
        'pr\t',
      ].join('\n')
    );
    expect(context?.pullRequest).toBeNull();
    expect(context?.issues).toEqual([
      { number: 123, url: 'https://github.com/acme/app/issues/123' },
    ]);
    expect(context?.links.repo).toBe('https://github.com/acme/app');
    expect(context?.links.branch).toBe('https://github.com/acme/app/tree/123-login');
  });

  test('a repo that is not on GitHub has a branch and no links', () => {
    const context = repoContextFrom(
      ['root\t/work/app', 'remote\tgit@gitlab.com:acme/app.git', 'branch\tmain'].join('\n')
    );
    expect(context?.remote).toBeNull();
    expect(context?.branch).toBe('main');
    expect(context?.issues).toEqual([]);
    expect(context?.links.repo).toBe('');
  });

  test('a pull request url that is not on GitHub is not used', () => {
    const odd = JSON.stringify({ number: 1, url: 'javascript:alert(1)', title: 'x', state: 'OPEN' });
    const context = repoContextFrom(
      ['root\t/r', 'remote\tgit@github.com:a/b.git', 'branch\tmain', `pr\t${odd}`].join('\n')
    );
    expect(context?.pullRequest?.url).toBe('https://github.com/a/b/pull/1');
  });

  test('not a repository is nothing at all', () => {
    expect(repoContextFrom('')).toBeNull();
    expect(repoContextFrom('remote\tgit@github.com:a/b.git')).toBeNull();
  });

  test('a detached head has no branch to link', () => {
    const context = repoContextFrom(
      ['root\t/r', 'remote\tgit@github.com:a/b.git', 'branch\tHEAD'].join('\n')
    );
    expect(context?.branch).toBe('');
    expect(context?.links.branch).toBe('');
  });
});
