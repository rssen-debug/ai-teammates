import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { detectPythonBinary } from '../../src/v5/skill-builder.js';

test('Python resolution returns the actual interpreter behind a launcher before environment scrubbing', () => {
  const executable = path.resolve('isolated-python', 'python.exe');
  const calls = [];
  const result = detectPythonBinary({
    spawn(bin, args) {
      calls.push({ bin, args });
      return { status: 0, stdout: JSON.stringify(executable) };
    },
    exists: (candidate) => candidate === executable,
  });
  assert.equal(result, executable);
  assert.equal(calls[0].bin, 'python3');
  assert.deepEqual(calls[0].args.slice(0, 1), ['-c']);
  assert.match(calls[0].args[1], /sys\.executable/);
});

test('Python resolution rejects version-only shims and missing executables, then tries the next candidate', () => {
  const executable = path.resolve('isolated-python', 'python.exe');
  const attempts = [];
  assert.equal(detectPythonBinary({
    spawn(bin) {
      attempts.push(bin);
      return { status: 0, stdout: bin === 'python3' ? 'Python 3.14.0' : JSON.stringify(executable) };
    },
    exists: () => true,
  }), executable);
  assert.deepEqual(attempts, ['python3', 'python']);
  assert.equal(detectPythonBinary({
    spawn: () => ({ status: 0, stdout: JSON.stringify(executable) }),
    exists: () => false,
  }), null);
  assert.equal(detectPythonBinary({
    spawn: () => ({ status: 0, stdout: JSON.stringify('python') }),
    exists: () => true,
  }), null);
});
