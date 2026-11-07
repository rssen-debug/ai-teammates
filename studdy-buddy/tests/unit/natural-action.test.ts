import { describe, it, expect } from 'vitest';
import { naturalDesktopGoal } from '../../packages/cli/src/natural-action.js';

describe('natural desktop task intent', () => {
  it('routes explicit user desktop requests without a slash', () => {
    expect(naturalDesktopGoal('Buddy, do inspect my Chrome tabs')).toBe('inspect my Chrome tabs');
    expect(naturalDesktopGoal('click the button in Chrome')).toBe('click the button in Chrome');
    expect(naturalDesktopGoal('kan du klicka på knappen i fönstret')).toBe('kan du klicka på knappen i fönstret');
  });
  it('does not mistake normal questions, creative writing or high-level discussion for tool actions', () => {
    expect(naturalDesktopGoal('Explain how Chrome works')).toBeNull();
    expect(naturalDesktopGoal('Write me a poem about my computer')).toBeNull();
    expect(naturalDesktopGoal('What should I study today?')).toBeNull();
    expect(naturalDesktopGoal('/do inspect Chrome')).toBeNull();
  });
});
