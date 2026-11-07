import test from 'node:test';
import assert from 'node:assert/strict';
import { startControlledForm } from '../../scripts/v4/evals/controlled-form.mjs';

test('controlled form requires actual upload, recovers a dynamic validation step and rejects duplicate submission', async () => {
  const text = 'Synthetic document for the controlled fixture only.';
  const fixture = await startControlledForm({ uploadText: text });
  try {
    const html = await (await fetch(fixture.base)).text();
    assert.match(html, /Participation/);
    assert.match(html, /generation\+\+/);
    const submit = async (slot, upload = text) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(fixture.expected)) if (key !== 'slot' || slot) form.set(key, key === 'slot' ? slot : value);
      form.set('participation', 'Team'); form.set('consent', 'on');
      form.set('document', new File([upload], 'fixture.txt', { type: 'text/plain' }));
      return fetch(fixture.base + '/submit', { method: 'POST', body: form });
    };
    assert.equal((await submit(undefined, 'wrong document')).status, 400);
    assert.equal(fixture.proof().accepted, null);
    const validation = await submit();
    assert.equal(validation.status, 422);
    assert.equal((await validation.json()).needsSlot, true);
    const accepted = await submit('Late');
    assert.equal(accepted.status, 201);
    assert.equal((await accepted.json()).receipt, fixture.receipt);
    assert.equal(fixture.proof().accepted.group, fixture.expected.group);
    assert.equal(fixture.proof().submissions.filter((s) => s.accepted).length, 1);
    assert.equal((await submit('Late')).status, 409);
  } finally { await fixture.close(); }
});
