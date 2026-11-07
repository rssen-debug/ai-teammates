import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('EXE PR builds cancel superseded workflow runs', () => {
 const yaml=fs.readFileSync(new URL('../.github/workflows/build-exe.yml',import.meta.url),'utf8');
 assert.match(yaml,/concurrency:\s*\n\s*group: build-exe-/);
 assert.match(yaml,/cancel-in-progress:.*github\.event_name.*pull_request/);
 assert.match(yaml,/runs-on: ubuntu-latest/);
});
