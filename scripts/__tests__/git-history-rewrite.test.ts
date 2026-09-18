import { describe, expect, it } from 'vitest';

import { resolveRewrittenCommit } from '../git-history-rewrite.mjs';

describe('historical rewritten-commit resolution', () => {
  it('resolves exact and unique abbreviated historical IDs', () => {
    expect(resolveRewrittenCommit('8cef99cb07daf130c38f93968e5ba24845af49e3'))
      .toMatch(/^[0-9a-f]{40}$/u);
    expect(resolveRewrittenCommit('8cef99c')).toEqual(
      resolveRewrittenCommit('8cef99cb07daf130c38f93968e5ba24845af49e3'),
    );
  });

  it('leaves current and non-commit values unchanged', () => {
    expect(resolveRewrittenCommit('fda732012eeeb634544456ee74888c728748025a'))
      .toBe('fda732012eeeb634544456ee74888c728748025a');
    expect(resolveRewrittenCommit('not-a-commit')).toBe('not-a-commit');
  });
});
