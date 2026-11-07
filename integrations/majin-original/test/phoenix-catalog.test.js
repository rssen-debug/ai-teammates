import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatalog, filterCatalog } from '../src/ui/catalog.js';

test('free catalog pricing rejects missing, malformed, negative and additional charges', () => {
  const data = normalizeCatalog({ data: [
    { id: 'actual:free', pricing: { prompt: '0', completion: '0', request: '0' } },
    { id: 'not-free', pricing: { prompt: '0', completion: '0', request: '0.01' } },
    { id: 'unknown:free' }, { id: 'missing', pricing: { prompt: '0' } },
    { id: 'bad', pricing: { prompt: 'oops', completion: '0' } },
    { id: 'negative', pricing: { prompt: '-1', completion: '0' } },
  ] });
  assert.deepEqual(filterCatalog(data, { free: true }).map(m => m.id), ['actual:free']);
});
test('full 1200-model catalog preserves vendor IDs, filters and sorts', () => {
  const models = normalizeCatalog({ data: Array.from({ length: 1200 }, (_, i) => ({
    id: `vendor/model-${i}:free`, name: `Model ${String(i).padStart(4, '0')}`,
    pricing: { prompt: '0', completion: '0' }, context_length: i * 1000,
    supported_parameters: ['tools'], architecture: { input_modalities: ['image', 'text'] },
  })) });
  assert.equal(models.length, 1200);
  assert.equal(filterCatalog(models, { query: 'model-1199', free: true })[0].id, 'vendor/model-1199:free');
  assert.equal(filterCatalog(models, { sort: 'context' })[0].context, 1199000);
  assert.ok(models[0].tools && models[0].vision);
});
test('catalog USD per million conversion and unknown sorting', () => {
  const models = normalizeCatalog({ data: [{ id: 'unknown' },
    { id: 'paid', pricing: { prompt: '0.000002', completion: '0.000008' } }] });
  assert.equal(models[1].input, 2); assert.equal(models[1].output, 8);
  assert.equal(filterCatalog(models, { sort: 'price' })[0].id, 'paid');
});


test('capability filters intersect at the 128k boundary; unknown capabilities stay excluded', () => {
  const models = normalizeCatalog({ data: [null, { id: 'all', context_length: 128000, supported_parameters: ['tools'], architecture: { input_modalities: ['image'] } },
    { id: 'short', context_length: 127999, supported_parameters: ['tools'], architecture: { input_modalities: ['image'] } },
    { id: 'text', context_length: 200000, supported_parameters: ['tools'] },
    { id: 'malformed', supported_parameters: {}, pricing: { prompt: false, completion: false } }] });
  assert.deepEqual(filterCatalog(models, { tools: true, vision: true, longContext: true }).map(m => m.id), ['all']);
  assert.equal(models.find(m => m.id === 'malformed').free, false);
});
