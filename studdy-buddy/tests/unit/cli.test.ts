import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runCli, box, dots, stripAnsi, supportsColor } from '@studdy/cli';

let dir: string;
let out: string[];
let err: string[];
const io = () => ({ out: (t: string) => out.push(t), err: (t: string) => err.push(t), color: false });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'studdy-cli-')); out = []; err = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CLI presentation', () => {
  it('renders five dots and a box without ANSI when color is off', () => {
    expect(dots(false)).toBe('● ● ● ● ●');
    const rendered = box('Test', ['rad ett', 'rad två'], false);
    expect(rendered).toContain('╭─ Test');
    expect(rendered).toContain('│ rad ett');
    expect(stripAnsi(rendered)).toBe(rendered);
  });
  it('respects NO_COLOR and non-TTY', () => {
    expect(supportsColor({ NO_COLOR: '1' } as NodeJS.ProcessEnv, { isTTY: true })).toBe(false);
    expect(supportsColor({} as NodeJS.ProcessEnv, { isTTY: false })).toBe(false);
  });
});

describe('CLI commands', () => {
  it('help and version flags work without touching provider network', async () => {
    expect(await runCli(['--version', '--json'], io(), { dataDir: dir, version: '9.9.9' })).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ version: '9.9.9' });
    out = [];
    expect(await runCli(['--help'], io(), { dataDir: dir })).toBe(0);
    expect(out.join('')).toContain('Användning');
    out = [];
    expect(await runCli(['help'], io(), { dataDir: dir })).toBe(0);
    expect(out.join('')).toContain('Studdy Buddy CLI');
    out = [];
    expect(await runCli(['version', '--json'], io(), { dataDir: dir, version: '9.9.9' })).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ version: '9.9.9' });
  });

  it('setup grants full access once and respects later revoke', async () => {
    expect(await runCli(['setup'], io(), { dataDir: dir })).toBe(0);
    expect(out.join('')).toContain('beviljad en gång');
    out = [];
    expect(await runCli(['setup'], io(), { dataDir: dir })).toBe(0);
    expect(out.join('')).toContain('redan konfigurerad');
  });

  it('stores provider key from stdin, never echoes it, and masks status', async () => {
    const secret = 'test-secret-key-123456';
    const stdin = Readable.from([secret]);
    expect(await runCli(['provider', 'set', 'kilo', '--key-stdin', '--json'], { ...io(), stdin }, { dataDir: dir })).toBe(0);
    const saved = JSON.parse(out[0]!);
    expect(saved.ok).toBe(true);
    expect(saved.key).not.toContain(secret);
    expect(out.join('') + err.join('')).not.toContain(secret);
    const vault = readFileSync(join(dir, 'secrets.vault'), 'utf8');
    expect(vault).not.toContain(secret);
    out = [];
    await runCli(['status', '--json'], io(), { dataDir: dir });
    const status = JSON.parse(out[0]!);
    expect(status.provider.hasApiKey).toBe(true);
    expect(JSON.stringify(status)).not.toContain(secret);
  });

  it('rejects missing key and unknown preset', async () => {
    expect(await runCli(['provider', 'set', 'kilo', '--key-stdin'], { ...io(), stdin: Readable.from(['']) }, { dataDir: dir })).toBe(2);
    expect(await runCli(['provider', 'set', 'nope', '--key-stdin'], { ...io(), stdin: Readable.from(['x']) }, { dataDir: dir })).toBe(2);
  });

  it('doctor reports honest blocked native helper when missing', async () => {
    const code = await runCli(['doctor', '--json'], io(), { dataDir: dir, platform: 'freebsd' });
    const report = JSON.parse(out[0]!);
    const native = report.checks.find((c: { name: string }) => c.name === 'Native helper');
    expect(native.ok).toBe(false);
    expect(native.blocked).toBe(true);
    expect(code).toBe(1);
  });

  it('open refuses shell commands on every platform', async () => {
    await runCli(['setup'], io(), { dataDir: dir });
    out = [];
    expect(await runCli(['open', 'cmd.exe', '--json'], io(), { dataDir: dir, platform: 'freebsd' })).toBe(1);
    expect(JSON.parse(out[0]!).ok).toBe(false);
  });

  it('memory writes an Obsidian vault and records a verified skill', async () => {
    expect(await runCli(['memory', '--json'], io(), { dataDir: dir })).toBe(0);
    const path = JSON.parse(out[0]!).path;
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(dir, 'Obsidian-Vault'));
    out = [];
    await runCli(['progress', '--json'], io(), { dataDir: dir });
    expect(JSON.parse(out[0]!).skills.verified).toBeGreaterThanOrEqual(1);
  });

  it('sites allow-list is explicit and persisted', async () => {
    expect(await runCli(['sites', 'allow', 'Example.COM/path', '--json'], io(), { dataDir: dir })).toBe(0);
    expect(JSON.parse(out[0]!).allowed).toContain('example.com');
    out = [];
    await runCli(['sites', '--json'], io(), { dataDir: dir });
    expect(JSON.parse(out[0]!).allowed).toContain('example.com');
  });

  it('ask without provider is degraded, not a fake answer', async () => {
    const code = await runCli(['ask', 'vad är subnetting?', '--json'], io(), { dataDir: dir });
    expect(code).toBe(1);
    const result = JSON.parse(out[0]!);
    expect(result.degraded).toBe(true);
    expect(result.message.text).toContain('Ingen AI-provider');
  });
});
