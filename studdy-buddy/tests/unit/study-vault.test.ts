import { describe, expect, it } from 'vitest';
import { noteId, renderVault } from '../../apps/desktop/electron/study-vault.js';

describe('Obsidian-compatible study memory', () => {
  it('exports demonstrated concepts and labels uncertainty', () => {
    const result = renderVault({
      courseName: 'NetAcad', lastTopic: 'OSI', updatedAt: '2026-11-06T00:00:00Z',
      concepts: [
        { id: 'arp', label: 'ARP', state: 'DEVELOPING', probability: 0.6, confidence: 0.4, evidenceCount: 3, independentCorrect: 1, lastEvidenceAt: '2026-11-06', reviewDueAt: null },
        { id: 'unseen', label: 'Unseen topic', state: 'NOT_SEEN', probability: 0, confidence: 0, evidenceCount: 0, independentCorrect: 0, lastEvidenceAt: null, reviewDueAt: null },
      ],
    });
    expect(result.notes).toHaveLength(1);
    expect(result.index).toContain('Concepts/' + noteId('arp') + '|ARP');
    expect(result.index).not.toContain('Unseen topic');
    expect(result.index).toContain('modellestimat');
  });

  it('keeps note names safe and strips Markdown delimiters from labels', () => {
    const result = renderVault({
      courseName: 'Cisco', lastTopic: 'IP <script> test', updatedAt: '2026-11-06T00:00:00Z',
      concepts: [{ id: '../foo', label: 'Bit | values', state: 'PRACTICING', probability: 0.4, confidence: 0.3, evidenceCount: 1, independentCorrect: 0, lastEvidenceAt: null, reviewDueAt: null }],
    });
    expect(result.notes[0]!.name).toBe(noteId('../foo') + '.md');
    expect(result.notes[0]!.text).not.toContain('Bit | values');
    expect(result.index).not.toContain('<script>');
  });
});
