import { describe, expect, it } from 'vitest';
import { addGoal, completeGoal, goals, goalSummary, slashCompletions, slashMatches, modelChoices, type GoalStore } from '../../packages/cli/src/slash-ui.js';

function store(): GoalStore {
  const data = new Map<string, unknown>();
  return { get: <T>(key: string) => data.get(key) as T | undefined, set: (key, value) => { data.set(key, value); } };
}

describe('Interactive CLI commands and durable goals', () => {
  it('offers slash completion instead of generic unknown-command output', () => {
    expect(slashMatches('/mo').map(item => item.command)).toEqual(['/model', '/models']);
    expect(slashCompletions('/go')[0]).toEqual(['/goal']);
    expect(slashCompletions('/nomatch')).toEqual([['/nomatch'], '/nomatch']);
  });
  it('retains completed and active goals in the persistent store', () => {
    const saved = store();
    const first = addGoal(saved, 'Klart med körkortet');
    const second = addGoal(saved, 'Behärska nätverk');
    expect(first?.id).toBe('1');
    expect(second?.id).toBe('2');
    expect(goals(saved)).toHaveLength(2);
    expect(completeGoal(saved, '1')).toBe(true);
    expect(completeGoal(saved, '1')).toBe(false);
    expect(goalSummary(saved)).toContain('✓ #1');
    expect(goalSummary(saved)).toContain('○ #2');
    expect(addGoal(saved, 'api_key=secret')).toBeNull();
    expect(goals(saved)).toHaveLength(2);
  });
  it('keeps the active provider model in the visible model picker', () => {
    expect(modelChoices('kilo', 'my-custom-model')).toEqual(['my-custom-model', 'kilo-auto/free']);
    expect(modelChoices('kilo', 'kilo-auto/free')).toEqual(['kilo-auto/free']);
  });
});
