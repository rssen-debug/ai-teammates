import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runCli } from '@studdy/cli';

let dir: string;
let out: string[];
let err: string[];
const io = (stdin?: NodeJS.ReadableStream) => ({ out: (t: string) => out.push(t), err: (t: string) => err.push(t), color: false, ...(stdin ? { stdin } : {}) });

function completion(content: unknown): Response {
  return new Response(JSON.stringify({
    model: 'mock', usage: { prompt_tokens: 10, completion_tokens: 10 },
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'studdy-cli-provider-')); out = []; err = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CLI provider protocol with local mock', () => {
  it('setup -> key stdin -> ask uses the real router and returns a grounded answer', async () => {
    const fetchImpl = (async () => completion({
      directAnswer: 'Subnetting delar ett nät i mindre delar.', simpleExplanation: 'Som att dela en tårta i bitar.',
      example: '', nextAction: '', deeperExplanation: '', evidence: ['Frågan nämner subnetting'], confidence: 'medium',
    })) as unknown as typeof fetch;
    expect(await runCli(['setup'], io(), { dataDir: dir })).toBe(0);
    out = [];
    expect(await runCli(['provider', 'set', 'kilo', '--key-stdin', '--json'], io(Readable.from(['mock-key'])), { dataDir: dir, fetchImpl })).toBe(0);
    out = [];
    const code = await runCli(['ask', 'vad är subnetting?', '--json'], io(), { dataDir: dir, fetchImpl });
    expect(code).toBe(0);
    const result = JSON.parse(out[0]!);
    expect(result.degraded).toBe(false);
    expect(result.message.text).toContain('Subnetting');
    expect(out.join('') + err.join('')).not.toContain('mock-key');
  });

  it('deterministic access question does not call the provider', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return completion('nope'); }) as unknown as typeof fetch;
    await runCli(['setup'], io(), { dataDir: dir });
    out = [];
    const code = await runCli(['ask', 'har du full åtkomst?', '--json'], io(), { dataDir: dir, fetchImpl });
    expect(code).toBe(0);
    expect(calls).toBe(0);
    expect(JSON.parse(out[0]!).message.text).toContain('verkliga åtkomst');
  });

  it('provider test reports mock health honestly', async () => {
    const fetchImpl = (async () => completion({ directAnswer: 'ok', simpleExplanation: '', example: '', nextAction: '', deeperExplanation: '', evidence: [], confidence: 'low' })) as unknown as typeof fetch;
    await runCli(['provider', 'set', 'kilo', '--key-stdin'], io(Readable.from(['mock-key'])), { dataDir: dir, fetchImpl });
    out = [];
    const code = await runCli(['provider', 'test', '--json'], io(), { dataDir: dir, fetchImpl });
    const result = JSON.parse(out[0]!);
    expect(result.ok).toBe(true);
    expect(result.data.ok).toBe(true);
    expect(code).toBe(0);
  });
});
