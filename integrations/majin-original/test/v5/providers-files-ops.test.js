import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  PROVIDER_PRESETS,
  ProviderManager,
  classifyProviderError,
} from '../../src/v5/providers.js';
import { FileAndAccessController } from '../../src/v5/files-access.js';
import { MIC_STATES, VoiceController } from '../../src/v5/voice-controller.js';
import { ExecutionLoopGuard, V5OpsManager } from '../../src/v5/ops.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-pfo-'));
}

test('ProviderManager supports OpenCode Go headers, manual model ID fallback, restart persistence, savedConfig vs connectionVerified, and error classification', async () => {
  const dir = tmpDir();
  let capturedHeaders = null;

  const mockFetch = async (url, init = {}) => {
    capturedHeaders = init.headers || {};
    if (String(url).endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: [
              { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', context_window: 131072 },
              { id: 'grok-4.7', name: 'Grok 4.7', context_window: 131072 },
            ],
          };
        },
      };
    }
    return { ok: false, status: 401, async text() { return 'Unauthorized invalid api key'; } };
  };

  const pm = new ProviderManager({ dataDir: dir, fetchImpl: mockFetch });

  // 1. Configure provider without discovery -> savedConfig is true, but connectionVerified MUST still be false!
  const saved = await pm.configureProvider({
    providerId: 'opencode-go',
    apiKey: 'oc_sk_test_123456',
    discover: false,
  });
  assert.equal(saved.savedConfig, true);
  assert.equal(saved.connectionVerified, false, 'Saved config must never claim verified connection before verification');

  // 2. Discover models & verify OpenCode Go required headers
  const disc = await pm.discoverCatalog('opencode-go');
  assert.equal(disc.ok, true);
  assert.equal(disc.connectionVerified, true);
  assert.equal(capturedHeaders['User-Agent'], PROVIDER_PRESETS['opencode-go'].headers['User-Agent']);

  // 3. Manual model ID fallback works even for an unlisted brand-new model ID
  const manual = pm.selectModel({
    providerId: 'opencode-go',
    modelId: 'custom-future-model-2027',
    allowManualFallback: true,
  });
  assert.equal(manual.activeModelId, 'custom-future-model-2027');
  assert.equal(manual.manualModelFallback, true);
  assert.equal(manual.connectionVerified, false, 'Selecting an unverified model ID resets connectionVerified until a real call succeeds');

  // 4. Persistence across restart
  const pmReloaded = new ProviderManager({ dataDir: dir, fetchImpl: mockFetch });
  assert.equal(pmReloaded.state.activeProvider, 'opencode-go');
  assert.equal(pmReloaded.state.activeModelId, 'custom-future-model-2027');
  assert.equal(pmReloaded.state.providers['opencode-go'].savedConfig, true);

  // 5. Error classification
  assert.equal(classifyProviderError(new Error('Invalid API key'), 401).code, 'AUTH_INVALID');
  assert.equal(classifyProviderError(new Error('Rate limit reached'), 429).code, 'QUOTA_EXCEEDED');
  assert.equal(classifyProviderError(new Error('Model not found'), 404).code, 'MODEL_NOT_FOUND');
  assert.equal(classifyProviderError(new Error('ECONNREFUSED'), 503).code, 'NETWORK_FAILURE');
});

test('ProviderManager streams only for an event consumer and signals when a retry discards partial output', async () => {
  const dir = tmpDir();
  const calls = [];
  const completeImpl = async (request) => {
    calls.push({ stream: request.stream, hasOnEvent: typeof request.onEvent === 'function' });
    if (calls.length === 1) {
      request.onEvent?.({ type: 'delta', text: 'partial ' });
      throw Object.assign(new Error('503 Service unavailable - temporary upstream failure'), { status: 503 });
    }
    request.onEvent?.({ type: 'delta', text: 'final' });
    request.onEvent?.({ type: 'tool', name: 'fs_read' });
    return {
      text: 'final',
      reasoning: null,
      toolCalls: [{ id: 'read-1', name: 'fs_read', argsJson: '{"path":"proof.txt"}' }],
      usage: { input: 12, output: 4, reported: true },
      stopReason: 'tool_calls',
    };
  };
  const pm = new ProviderManager({ dataDir: dir, completeImpl });
  await pm.configureProvider({ providerId: 'opencode-go', apiKey: 'stream-test-key', discover: false });
  pm.selectModel({ providerId: 'opencode-go', modelId: 'stream-model', allowManualFallback: true });

  const events = [];
  const streamed = await pm.complete({
    messages: [{ role: 'user', content: 'Stream a tool call' }],
    onEvent: (event) => events.push(event),
    maxRetries: 1,
  });
  assert.equal(streamed.ok, true, JSON.stringify(streamed));
  assert.deepEqual(calls.slice(0, 2), [
    { stream: true, hasOnEvent: true },
    { stream: true, hasOnEvent: true },
  ]);
  assert.deepEqual(events, [
    { type: 'delta', text: 'partial ' },
    { type: 'retry', attempt: 2 },
    { type: 'delta', text: 'final' },
    { type: 'tool', name: 'fs_read' },
  ]);
  assert.equal(streamed.capabilitiesUsed.streamingRequested, true);
  assert.equal(streamed.capabilitiesUsed.streamingEnabled, true);

  const plain = await pm.complete({ messages: [{ role: 'user', content: 'No streaming consumer' }] });
  assert.equal(plain.ok, true);
  assert.deepEqual(calls.at(-1), { stream: false, hasOnEvent: false });
  assert.equal(plain.capabilitiesUsed.streamingRequested, false);
  assert.equal(plain.capabilitiesUsed.streamingEnabled, false);
});

test('FileAndAccessController handles >6 MB streaming uploads, verifies external portal uploads, enforces revocable Owner Mode, and blocks untrusted prompt-injection escalation', async () => {
  const dir = tmpDir();
  const fac = new FileAndAccessController({ dataDir: dir });

  // 1. Streaming upload > 6 MB (e.g. 7 MB PDF stream with %PDF-1.7 magic header) works cleanly without OOM
  const header = Buffer.from('%PDF-1.7\n');
  const body = Buffer.alloc(7 * 1024 * 1024 - header.length, 0x41);
  const stream = Readable.from([header, body.subarray(0, 3_500_000), body.subarray(3_500_000)]);
  const streamedUpload = await fac.saveStreamUpload({
    readableStream: stream,
    name: 'large-portfolio.pdf',
    type: 'application/pdf',
  });
  assert.equal(streamedUpload.bytes, 7 * 1024 * 1024);
  assert.equal(streamedUpload.streamed, true);
  assert.equal(fs.existsSync(streamedUpload.path), true);

  // 2. External portal upload distinguishes local file read from verified server receipt
  const unconfirmedPortalFac = new FileAndAccessController({
    dataDir: dir,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { ok: true, receivedBytes: 0, receivedSha256: 'wrong' };
      },
    }),
  });
  const unconfirmedPortal = await unconfirmedPortalFac.uploadToPortal({
    filePath: streamedUpload.path,
    portalUrl: 'https://portal.example.com/upload',
  });
  assert.equal(unconfirmedPortal.ok, false);
  assert.equal(unconfirmedPortal.verifiedReceipt.verified, false);

  const confirmedPortalFac = new FileAndAccessController({
    dataDir: dir,
    fetchImpl: async (_url, init) => {
      const sent = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            receivedBytes: sent.bytes,
            receivedSha256: sent.sha256,
            receiptId: `rcpt-portal-${sent.sha256.slice(0, 8)}`,
          };
        },
      };
    },
  });
  const confirmedPortal = await confirmedPortalFac.uploadToPortal({
    filePath: streamedUpload.path,
    portalUrl: 'https://portal.example.com/upload',
  });
  assert.equal(confirmedPortal.ok, true);
  assert.equal(confirmedPortal.verifiedReceipt.verified, true);

  // 3. Persistent Owner Mode across restarts, immediate revocation & OS Admin separation
  fac.enableOwnerMode({
    lanes: ['files', 'browser'],
    folders: [dir],
  });
  const facReloaded = new FileAndAccessController({ dataDir: dir });
  const stateAfterReload = facReloaded.describeAccessState();
  assert.deepEqual(stateAfterReload.grantedLanes, ['files', 'browser']);
  if (process.platform === 'win32') {
    assert.equal(stateAfterReload.osAdminElevated, false);
  }
  assert.match(stateAfterReload.adminSeparationNote, /distinct from OS Administrator/i);

  // Immediate revocation and emergency stop
  const afterRevoke = facReloaded.revokePermissions({ lanes: ['browser'] });
  assert.equal(afterRevoke.grantedLanes.includes('browser'), false);
  const stopped = facReloaded.triggerEmergencyStop();
  assert.equal(stopped.stopped, true);

  // 4. Untrusted external data (job ad / PDF / web page) can NEVER escalate permissions
  assert.throws(() => {
    facReloaded.assertUntrustedDataCannotEscalate({
      sourceKind: 'job_ad',
      enableOwnerMode: true,
      requestedLanes: ['files', 'terminal'],
    });
  }, /Untrusted data source/i);
});

test('VoiceController enforces opt-in microphone, measures barge-in latency, and V5OpsManager enforces loop limits and automatic update rollback', async () => {
  // 1. VoiceController opt-in and barge-in
  let clock = 1000;
  const voice = new VoiceController({ now: () => clock });
  const autoAttempt = voice.activateMicrophone({ userInitiated: false });
  assert.equal(autoAttempt.ok, false);
  assert.equal(voice.micState, MIC_STATES.IDLE);

  const userAttempt = voice.activateMicrophone({ userInitiated: true });
  assert.equal(userAttempt.ok, true);
  assert.equal(voice.micState, MIC_STATES.LISTENING);

  voice.startSpeaking({ sessionId: 'tts-1' });
  assert.equal(voice.micState, MIC_STATES.SPEAKING);
  clock += 12.5;
  const barge = voice.interruptSpeech({ reason: 'user_barge_in', requestedAt: 1005 });
  assert.equal(barge.interrupted, true);
  assert.equal(barge.interruptionLatencyMs, 7.5);
  assert.equal(voice.describeStatus().hardwareVerification.acousticEchoVerifiedOnDevice, false);

  // 2. ExecutionLoopGuard blocks repeated identical calls and stagnation
  const guard = new ExecutionLoopGuard({ maxSameToolRepeats: 2, maxConsecutiveFailures: 2 });
  assert.equal(guard.checkBeforeStep({ tool: 'web.fetch', args: { url: 'https://a.com' } }).allowed, true);
  guard.recordStepOutcome({ tool: 'web.fetch', args: { url: 'https://a.com' }, ok: true, verifiedProgress: true });
  guard.recordStepOutcome({ tool: 'web.fetch', args: { url: 'https://a.com' }, ok: true, verifiedProgress: true });
  const thirdSame = guard.checkBeforeStep({ tool: 'web.fetch', args: { url: 'https://a.com' } });
  assert.equal(thirdSame.allowed, false);
  assert.equal(thirdSame.code, 'LOOP_IDENTICAL_CALL_BLOCKED');

  // 3. V5OpsManager backup, restore & automatic rollback on failed update health check
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'sample-state.json'), JSON.stringify({ important: 'preserved' }), 'utf8');
  const ops = new V5OpsManager({ dataDir: dir });

  const verInfo = ops.getVersionInfo();
  assert.equal(verInfo.version, '5.0.0');
  assert.ok(verInfo.buildSha.length >= 7);

  // Simulate an update where post-update health check FAILS -> must rollback automatically!
  const failedUpdate = await ops.applyUpdateWithRollback({
    newVersion: '5.0.1-broken',
    newSha: 'badsha000',
    verifyHealth: async () => {
      // Corrupt state during failed update attempt
      fs.writeFileSync(path.join(dir, 'sample-state.json'), JSON.stringify({ important: 'corrupted' }), 'utf8');
      return false;
    },
  });
  assert.equal(failedUpdate.ok, false);
  assert.equal(failedUpdate.rolledBack, true);
  assert.equal(failedUpdate.activeVersion, '5.0.0');
  const restoredContent = JSON.parse(fs.readFileSync(path.join(dir, 'sample-state.json'), 'utf8'));
  assert.equal(restoredContent.important, 'preserved', 'Rollback must restore pre-update state');
});
