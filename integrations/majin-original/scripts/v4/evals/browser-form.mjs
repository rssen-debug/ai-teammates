// Opt-in LIVE Go acceptance: the host's real model operates an unfamiliar form.
// No selectors, browser actions or synthetic model responses are supplied here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startControlledForm } from './controlled-form.mjs';
import { evaluationClient } from './live-client.mjs';
import { existingLocalOwnerCookie } from './local-owner.mjs';

export async function runBrowserFormEvaluation({ base, cookie, workspace, output, sourceDirectory, approveControlledActions = false, onEvent = () => {} }) {
  if (output && fs.existsSync(output)) throw Error('Evidence output already exists. Use a new path to preserve previous attempts.');
  const client = evaluationClient({ base, cookie });
  const catalogue = await client.get('/api/models');
  const current = catalogue.models.find(m => m.id === catalogue.current);
  const before = (await client.get('/api/state')).model;
  if (current?.offering !== 'opencode-go' || before.demo !== false) throw Error('This acceptance requires the existing real Go route. No provider change or fallback was attempted.');
  const caps = await client.get('/api/capabilities');
  if (!caps.tools?.registered?.some(t => t.name === 'browser_upload')) throw Error('Owner-granted real browser tools are required.');
  workspace = fs.realpathSync(workspace);
  const sourceCommit = sourceDirectory ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDirectory, encoding: 'utf8' }).trim() : null;
  const nonce = crypto.randomBytes(6).toString('hex');
  const uploadName = `genesis-form-upload-${nonce}.txt`, receiptName = `genesis-form-receipt-${nonce}.txt`;
  const uploadText = `Controlled evaluation document ${crypto.randomUUID()}\n`;
  const uploadPath = path.join(workspace, uploadName);
  fs.writeFileSync(uploadPath, uploadText, { flag: 'wx', mode: 0o600 });
  const fixture = await startControlledForm({ uploadText });
  const scopes = [], denied = [], toolFailures = [], observedEvents = [];
  let result, failure = null, conversationId;
  const started = Date.now();
  try {
    const e = fixture.expected;
    result = await client.run({
      task: `Use the real browser tools to register a team at ${fixture.base}/. Team name: ${e.group}. Contact email: ${e.email}. Attendees: ${e.seats}. Country: Sweden. Choose the Late session if a session is requested. Attach the supporting document at ${uploadPath}. Consent to this isolated demo registration. Inspect the live interface and recover from validation errors until the page shows a saved registration and its receipt. Save that observed receipt in workspace file ${receiptName}, then read it back. This is a controlled local demo: submission to ${fixture.base} is explicitly authorized; no real people or external registrations are involved. Use the browser interface, not direct HTTP submission or custom scripts. Do not access unrelated files, save memories or change configuration. Do not submit again after success.`,
      onEvent: (event) => {
        observedEvents.push(event);
        conversationId = event.data?.conversationId || conversationId;
        if (event.event === 'tool_result' && !event.data.ok) toolFailures.push({ name: event.data.name, summary: event.data.summary, error: event.data.error || null });
        if (event.event === 'error') failure = String(event.data?.message || event.data?.error || 'Host reported an error');
        onEvent(event);
      },
      approve: async (pending) => {
        conversationId = pending.conversationId;
        if (!approveControlledActions) return undefined;
        const allowed = new Set(['browser_open','browser_fill','browser_click','browser_upload','browser_close']);
        let safe = allowed.has(pending.tool);
        if (pending.tool === 'browser_open') {
          try { safe = new URL(pending.input.url).origin === fixture.base && pending.input.headless !== false; } catch { safe = false; }
        }
        if (pending.tool === 'browser_upload') {
          const target = path.resolve(workspace, String(pending.input.path || ''));
          safe = process.platform === 'win32' ? target.toLowerCase() === uploadPath.toLowerCase() : target === uploadPath;
        }
        if (safe) scopes.push(pending.tool); else denied.push(pending.tool);
        return safe;
      },
    });
  } catch (error) { failure = String(error.message || error); }
  finally {
    if (conversationId && result?.status !== 'completed') {
      await client.stop(conversationId).catch(() => {});
      await client.stop(conversationId, { rejectPending: true }).catch(() => {});
    }
    await fixture.close();
  }
  const proof = fixture.proof();
  const successfulActions = observedEvents.filter(e => e.event === 'tool_result' && e.data.ok).map(e => e.data.name);
  let savedReceipt = ''; try { savedReceipt = fs.readFileSync(path.join(workspace, receiptName), 'utf8'); } catch {}
  const after = await client.get('/api/state').then(state => state.model).catch(() => null);
  const checks = {
    realModelCompleted: result?.status === 'completed',
    providerUnchanged: before.provider === after?.provider && before.model === after?.model && after?.demo === false,
    browserUpload: successfulActions.includes('browser_upload'),
    browserInteraction: successfulActions.includes('browser_fill') && successfulActions.includes('browser_click'),
    validationRecovered: proof.needsSlot && proof.submissions.some(s => !s.accepted) && Boolean(proof.accepted),
    oneAcceptedRegistration: proof.submissions.filter(s => s.accepted).length === 1,
    exactUploadedBytes: proof.accepted?.uploadSha256 === crypto.createHash('sha256').update(uploadText).digest('hex'),
    savedObservedReceipt: Boolean(proof.accepted) && savedReceipt.includes(fixture.receipt),
  };
  const evidence = {
    at: new Date().toISOString(), sourceCommit, kind: 'real-Go-unfamiliar-local-form',
    passed: Object.values(checks).every(Boolean), checks, failure, status: result?.status || 'failed',
    elapsedMs: Date.now() - started, model: before, modelAfter: after,
    conversationId: conversationId || null, successfulActions, toolFailures, oneUseApprovals: scopes, deniedActions: denied,
    proof, artifacts: { uploadName, receiptName }, physicalPhonePass: false,
    trace:observedEvents.filter(e=>['tool_start','tool_result'].includes(e.event)),
    fullScenarioAComplete: false, note: 'Controlled dynamic-form/upload/validation acceptance only; external authentication handoff, cancellation and other real-world gates remain separate.',
  };
  if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' }); }
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const required = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw Error(`Missing ${name}`); return args[i + 1]; };
  const base = required('--host');
  const cookie = args.includes('--local-owner-home') ? existingLocalOwnerCookie({ home: required('--local-owner-home'), base }) : process.env.MAJIN_EVAL_COOKIE;
  const evidence = await runBrowserFormEvaluation({ base, workspace: required('--workspace'), output: required('--out'), sourceDirectory: required('--source-dir'), cookie, approveControlledActions: args.includes('--approve-controlled-actions'), onEvent: (event) => { if (event.event === 'tool_start') process.stderr.write(`tool ${event.data.name}\n`); } });
  console.log(JSON.stringify(evidence));
  if (!evidence.passed) process.exitCode = 1;
}
