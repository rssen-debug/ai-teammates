/**
 * MAJIN V2 — live GUI QA (the runner lane, finally executable).
 * Boots the REAL Studio server with the full surface family enabled, drives a
 * REAL Chromium (headed on the operator runner, headless anywhere else via
 * GUI_HEADLESS=1) and collects EVIDENCE, not impressions:
 *   - zero outbound asset requests (offline-by-construction, live-proven)
 *   - every OFF surface shows its honest gate sentence in the DOM
 *   - doctor/bundle/consent/goals interactions produce the expected verdicts
 *   - zero page console errors
 *   - a full-page screenshot + results JSON are written for artifact upload
 *
 * Exit discipline: nonzero if ANY evidence step fails — a green run means the
 * assertions above genuinely held in the browser being driven.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HEADLESS = process.env.GUI_HEADLESS !== '0'; // runner sets GUI_HEADLESS=0 for headed proof
// REUSE > download: on the operator machine Microsoft Edge is already installed —
// channel 'msedge' skips the 120MB Chromium download entirely. GUI_CHANNEL=chromium
// forces the explicit download (e.g. in the Linux sandbox where Edge cannot exist).
const CHANNEL = process.env.GUI_CHANNEL || 'msedge';
const OUT_DIR = process.env.GUI_QA_OUT || path.join(process.cwd(), 'docs', 'v2', 'gui-qa');

const steps = [];
const step = (name, ok, detail = '') => { steps.push({ name, ok, detail }); console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); return ok; };

async function main() {
  const { chromium } = await import('playwright');
  const { createStudioServer } = await import('../src/v2/studio/server.js');
  const { EventBus } = await import('../src/v2/runtime/events.js');
  const { Approvals } = await import('../src/v2/safety/approvals.js');
  const { AuditChain } = await import('../src/v2/audit/chain.js');
  const { AuditBind } = await import('../src/v2/audit/bind.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-gui-qa-'));
  const auditDir = path.join(dir, 'audit');
  const telemetryDir = path.join(dir, 'telemetry');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(telemetryDir, { recursive: true });
  const bus = new EventBus();
  const approvals = new Approvals(bus);
  const auditBind = new AuditBind(new AuditChain(auditDir));
  auditBind.attach(bus);
  const studio = createStudioServer({
    bus, telemetryDir, auditDir, approvals,
    enableWrites: true,
    enableGoals: { workspaceDir: path.join(dir, 'run') },
    enableBundle: { dir: path.join(dir, 'dossier') },
    enableDoctor: { studioPort: 0 },
  });
  const bound = await studio.listen({ port: 0 });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let browser;
  let channelUsed = CHANNEL;
  try {
    browser = await chromium.launch({ headless: HEADLESS, channel: CHANNEL });
  } catch (e) {
    if (CHANNEL === 'msedge') {
      channelUsed = 'chromium-default (edge not present on this machine — honest fallback, recorded)';
      // default = playwright's bundled headless build; NO channel field (channel:'chromium'
      // would force the full download — exactly what this lane exists to avoid)
      browser = await chromium.launch({ headless: HEADLESS });
    } else { throw e; }
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  const external = [];
  page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (!/^(127\.0\.0\.1|localhost)$/.test(h)) external.push(r.url()); } catch { /* data: urls */ } });

  let failures = 0;
  try {
    await page.goto(bound.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    step('page loads (offline origin only)', true, bound.url);
    step('browser channel honest', true, channelUsed);

    // every OFF surface shows its honest gate sentence
    const voice = await page.locator('#voice .mode').innerText();
    step('voice OFF sentence honest', /disabled.*disabled means SILENCE/.test(voice), voice.slice(0, 60));
    const bundle = await page.locator('#bundle .mode').innerText();
    step('bundle ON sentence honest', /ENABLED/.test(bundle), bundle.slice(0, 60));
    const doctor = await page.locator('#doctor .mode').innerText();
    step('doctor ON sentence honest', /ENABLED/.test(doctor));

    // consent check-status via UI (scope present in DOM flow)
    await page.fill('#c-status-scope', 'studio:run-goals');
    await page.click('#c-status');
    await page.waitForTimeout(500);
    const cOut = await page.locator('#c-status-out').innerText();
    step('consent status flow answers (gate or state, never a crash)', cOut.length > 2, cOut.slice(0, 80).replace(/\n/g, ' '));

    // goals run WITHOUT grant must surface the consent path, honestly
    await page.fill('#g-objective', 'gui-qa smoke objective');
    await page.click('#g-run');
    await page.waitForTimeout(1200);
    const gOut = await page.locator('#g-out').innerText();
    step('goal run without grant → consent required surfaced', /consent/i.test(gOut), gOut.slice(0, 90).replace(/\n/g, ' '));

    // consent GRANT via the UI (dogfooding the operator flow end-to-end) —
    // this also writes the FIRST chain entries the dossier step will need
    await page.fill('#c-scope', 'studio:run-goals');
    await page.fill('#c-user', 'GUI-QA runner');
    await page.selectOption ? null : null;
    try { await page.selectOption('#c-mode', 'once'); } catch { await page.fill('#c-mode', 'once'); }
    await page.click('#c-grant');
    await page.waitForFunction(() => document.getElementById('c-result').textContent.includes('granted'), null, { timeout: 10000 });
    const grantText = await page.locator('#c-result').innerText();
    step('consent grant via UI (mirrored to audit chain)', /granted studio:run-goals/.test(grantText), grantText.slice(0, 90));


    // now the grant we made above unlocks ONE real run through the UI
    await page.fill('#g-objective', 'gui-qa smoke objective');
    await page.click('#g-run');
    await page.waitForFunction(() => /state:|busy:|consent required/.test(document.getElementById('g-out').textContent), null, { timeout: 30000 });
    const gRun = await page.locator('#g-out').innerText();
    step('goal RUN via UI consumes the grant with an honest state', /state:/.test(gRun) || /busy:/.test(gRun), gRun.split('\n')[0].slice(0, 100));

    // doctor via UI
    await page.click('#d-run');
    await page.waitForFunction(() => document.getElementById('d-out').textContent.includes('VERDICT'), null, { timeout: 10000 });
    const dOut = await page.locator('#d-out').innerText();
    step('doctor verdict rendered', /VERDICT: (READY|READY_WITH_GATES|NOT_READY)/.test(dOut), dOut.split('\n')[0]);

    // dossier export + verify via UI
    await page.click('#b-export');
    await page.waitForFunction(() => /BUNDLE EXPORTED|EXPORT REFUSED/.test(document.getElementById('b-verdict').textContent), null, { timeout: 10000 });
    const bOut = await page.locator('#b-verdict').innerText();
    step('dossier export via UI', /BUNDLE EXPORTED/.test(bOut), bOut.split('\n')[0]);
    await page.click('#b-verify');
    await page.waitForFunction(() => /verdict:/.test(document.getElementById('b-verdict').textContent), null, { timeout: 10000 });
    const bVer = await page.locator('#b-verdict').innerText();
    step('dossier verify via UI', /BUNDLE_OK/.test(bVer), bVer.split('\n')[0]);

    // audit chain really recorded the UI-driven actions (grants-attempts + dossier files)
    const auditFiles = fs.readdirSync(auditDir);
    step('audit dir carries the session (chain.jsonl exists)', auditFiles.includes('chain.jsonl'));
    const chainLen = auditFiles.includes('chain.jsonl') ? fs.readFileSync(path.join(auditDir, 'chain.jsonl'), 'utf8').trim().split('\n').length : 0;
    step('audit chain recorded >=2 real entries (grant + run attempt)', chainLen >= 2, `${chainLen} entries`);

    await page.screenshot({ path: path.join(OUT_DIR, 'gui-qa.png'), fullPage: true });
    step('screenshot captured', fs.existsSync(path.join(OUT_DIR, 'gui-qa.png')), path.join(OUT_DIR, 'gui-qa.png'));

    // expected gate responses (403/409/404/503) log as resource errors in ANY browser —
    // the hard-zero is uncaught JS failures (pageerror), and unknown console errors stay red
    const unexpected = consoleErrors.filter((e) => !/Failed to load resource: the server responded with a status of (400|403|404|409|503)/.test(e));
    step('zero UNEXPECTED console errors (gate statuses are expected traffic)', unexpected.length === 0, unexpected.slice(0, 3).join(' | ') || 'none');
    step('zero external asset requests', external.length === 0, external.slice(0, 3).join(' | ') || 'none (offline-by-construction live)');
  } finally {
    await browser.close();
    await studio.close();
  }

  failures = steps.filter((s) => !s.ok).length;
  const result = {
    schema: 'majin-v2-gui-qa.v1', at: new Date().toISOString(),
    headless: HEADLESS, channel: channelUsed, studioUrl: bound.url,
    consoleErrors, externalRequests: external,
    steps, failures,
    verdict: failures === 0 ? 'GUI_QA_GREEN' : 'GUI_QA_RED',
  };
  fs.writeFileSync(path.join(OUT_DIR, 'gui-qa-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`\nVERDICT: ${result.verdict} (${steps.length - failures}/${steps.length} evidence steps green)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`GUI_QA_HARNESS_ERROR: ${e.stack || e.message}`); process.exit(2); });
