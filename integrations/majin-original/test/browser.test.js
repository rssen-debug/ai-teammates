/**
 * MAJIN — browser-use hardening tests. The CDP wire itself needs a real browser
 * (covered on the CI Windows box with Edge/Chrome headless — TODO label) but every
 * DETERMINISTIC piece is proven here: the loop guard, the slot pool, the
 * discovery tables, and the evidence rules in the tool wiring.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { LoopJournal, createBrowserPool, browserCandidates, findBrowser, isOpen, closeFor, _resetBrowser } = await import('../src/core/browser.js');

test('loop guard: three identical consecutive actions stop the agent cold, in its own words', () => {
  const j = new LoopJournal();
  j.guard('t1', 'browser.click:#next');
  j.guard('t1', 'browser.click:#next');
  assert.throws(() => j.guard('t1', 'browser.click:#next'), /browser loop detected/);
  // a different action between resent attempts resets the counter
  const k = new LoopJournal();
  k.guard('t2', 'browser.click:#next');
  k.guard('t2', 'browser.fill:#name');
  assert.doesNotThrow(() => k.guard('t2', 'browser.click:#next'), 'an intervening action is not a loop');
  // different sessions never contaminate each other
  const m = new LoopJournal();
  m.guard('t3', 'browser.click:#next');
  m.guard('t3', 'browser.click:#next');
  assert.doesNotThrow(() => m.guard('t4', 'browser.click:#next'), 'sessions are isolated (autopilot G)');
  assert.ok(m.acts('t3').length >= 2 && m.acts('t4').length === 1, 'journal is readable per session');
});

test('slot pool: the fleet cap queues an extra session, release opens the gate', async () => {
  const held = new Map();
  const fakeLocks = {
    async acquire(key, owner) {
      if (held.has(key)) throw new Error('busy');
      held.set(key, owner);
      return () => held.delete(key);
    },
  };
  const pool = createBrowserPool({ locks: fakeLocks, max: 2 });
  assert.equal(await pool.claim('a'), 1, 'first session takes slot 1');
  assert.equal(await pool.claim('b'), 2, 'second takes slot 2');
  const err = await pool.claim('c').then(() => null, (e) => e);
  assert.ok(err, 'a third session must wait');
  assert.match(err.message, /all 2 browser instances are busy/, 'waiting is honest about why');
  pool.release('a');
  assert.equal(await pool.claim('c'), 1, 'the freed slot is handed to the waiter in order');
  assert.equal(pool.count(), 2);
  pool.release('b');
  pool.release('c');
  assert.equal(pool.count(), 0, 'every slot returns to the fleet');
  assert.equal(await pool.claim('a'), 1, 'pool fully resets');
});

test('re-claim by the same session is idempotent (never double-spawns its own window)', async () => {
  const held = new Map();
  const fakeLocks = {
    async acquire(key, owner) {
      if (held.has(key)) throw new Error('busy');
      held.set(key, owner);
      return () => held.delete(key);
    },
  };
  const pool = createBrowserPool({ locks: fakeLocks, max: 3 });
  const first = await pool.claim('s');
  const again = await pool.claim('s');
  assert.equal(first, again, 'same session keeps its own window');
  assert.equal(pool.count(), 1, 'no phantom instance');
});

test('browser discovery: candidates exist for every platform; findBrowser is honest when nothing is installed', () => {
  for (const [p, min] of [['win32', 5], ['darwin', 3], ['linux', 5]]) {
    const list = browserCandidates(p, { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\L' });
    assert.ok(list.length >= min, `${p}: at least ${min} candidates (got ${list.length})`);
  }
  const win = browserCandidates('win32', { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF' });
  assert.ok(win[0].includes('Edge'), 'Edge first on Windows — it ships with the OS');
  assert.equal(findBrowser(['C:\\definitely\\not\\installed\\msedge.exe']), null, 'nothing installed says nothing installed');
});

test('process-wide session helpers stay truthful without a browser', () => {
  _resetBrowser();
  assert.equal(isOpen('nothing-here'), false);
  assert.equal(closeFor('nothing-here'), false, 'closing nothing reports nothing closed');
});

test('click follows a spawned tab, and the recovery cookbook lives in the system prompt', async () => {
  const web = (await import('node:fs')).readFileSync(new URL('../src/core/tools/web.js', import.meta.url), 'utf8');
  assert.match(web, /snapshotTargets/, 'capture current tab ids before the click');
  assert.match(web, /physicalClick = el\.tagName === 'A'/, 'links use trusted pointer input so browser default navigation is not suppressed');
  assert.match(web, /Input\.dispatchMouseEvent/, 'dispatch a real pointer press/release for links');
  assert.match(web, /followNewTarget\(\{ windowMs: 1500, beforeTargets: targetsBeforeClick \}\)/, 'click follows only a target created by that action even when Edge omits openerId');
  assert.match(web, /new tab followed/, 'the agent is told what actually happened');
  const agent = (await import('node:fs')).readFileSync(new URL('../src/core/agent.js', import.meta.url), 'utf8');
  assert.match(agent, /browser\.read the page, try a narrower selector/, 'the recovery path is taught, deterministic order');
  assert.match(agent, /never click the same failing element more than twice/, 'the loop guard is explained to the model');
});

test('the browser tools are registered with guard-approved risks and loop-journal wiring', async () => {
  const { webTools } = await import('../src/core/tools/web.js');
  const names = webTools.map((t) => t.name);
  for (const want of ['browser.open', 'browser.read', 'browser.click', 'browser.fill', 'browser.upload', 'browser.shot', 'browser.close']) {
    assert.ok(names.includes(want), `${want} registered`);
  }
  const acts = Object.fromEntries(webTools.filter((t) => t.name.startsWith('browser.')).map((t) => [t.name, t]));
  assert.equal(acts['browser.open'].risk, 'exec', 'opening a browser is an act on the machine — approvable');
  assert.equal(acts['browser.click'].risk, 'exec');
  assert.equal(acts['browser.fill'].risk, 'exec');
  assert.equal(acts['browser.upload'].risk, 'exec', 'uploading a file is an outward act too');
  assert.equal(acts['browser.read'].risk, 'read');
  assert.equal(acts['browser.shot'].risk, 'read');
  /* a closed fleet answers with a sentence, not a stack trace */
  const r = await acts['browser.read'].run({ selector: '' }, { session: 'never-opened-anywhere', cfg: { get: () => 0 } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'browser_closed');
});

test('openFor reuse never navigates the page away (the eval-vs-goto coin flip)', async () => {
  /* the flake that ate two CI runs: reuse called goto('about:blank') on every
     subsequent tool call; whether read returned h1 or void was a race. Source
     pin: the reuse branch may only goto for an explicit, non-blank url. */
  const src = (await import('node:fs')).readFileSync(new URL('../src/core/browser.js', import.meta.url), 'utf8');
  const reuse = src.slice(src.indexOf('const existing = sess.get(session)'), src.indexOf('const thePool'));
  assert.match(reuse, /url && url !== 'about:blank' && current !== String\(url\)/, 'reuse navigates only on a different explicit URL');
  assert.match(reuse, /await existing\.goto\(url, \{ signal \}\)/, 'navigation retains cancellation');
  assert.match(reuse, /existing\.eval\('location\.href'/, 'read live URL before deciding whether to navigate');
  assert.doesNotMatch(reuse, /url = 'about:blank'/, 'no silent default navigation target');
  assert.match(src, /return waitForNavigation\(navigation/, 'goto waits for the new document before asking questions');
});

test('navigation rejects a ready old document and waits for the committed loader', async () => {
  const { waitForNavigation } = await import('../src/core/browser.js');
  const documents = [
    { loaderId: 'old', readyState: 'complete', url: 'about:blank' },
    { loaderId: 'new', readyState: 'loading' },
    { loaderId: 'new', readyState: 'complete', url: 'http://fixture/form' },
  ];
  const result = await waitForNavigation({ loaderId: 'new' }, async () => documents.shift(), { wait: async () => {} });
  assert.equal(result.url, 'http://fixture/form');
  assert.equal(documents.length, 0);
  await assert.rejects(waitForNavigation({ loaderId: 'new' }, async () => ({ loaderId: 'old', readyState: 'complete' }), { attempts: 2, wait: async () => {} }), /timeout/);
  await assert.rejects(waitForNavigation({ errorText: 'net::ERR_CONNECTION_REFUSED' }, async () => ({})), /CONNECTION_REFUSED/);
  assert.equal((await waitForNavigation({}, async () => ({ readyState: 'interactive' }))).readyState, 'interactive', 'same-document navigation has no new loader ID');
});

test('followNewTarget never follows the stale initial tab (the about:blank wire)', async () => {
  /* CI evidence 2026-10-18: every click rewired the session to the initial
     blank tab, and reads came back from a void — urlAfter 'about:blank' while
     the server had already seen the real submit. Rule: tabs born after spawn. */
  const src = (await import('node:fs')).readFileSync(new URL('../src/core/browser.js', import.meta.url), 'utf8');
  assert.match(src, /knownTabs\s*:\s*new Set\(bornTabs/, 'birth tabs are remembered');
  const { isChildTarget } = await import('../src/core/browser.js');
  const browser = { targetId: 'our-page', knownTabs: new Set(['initial-blank', 'our-page']) };
  assert.equal(isChildTarget({ type: 'page', targetId: 'initial-blank' }, browser), false);
  assert.equal(isChildTarget({ type: 'page', targetId: 'edge-sync-dialog' }, browser), false, 'an unrelated browser-owned page must never receive the agent actions');
  assert.equal(isChildTarget({ type: 'page', targetId: 'other-popup', openerId: 'other-page' }, browser), false);
  assert.equal(isChildTarget({ type: 'page', targetId: 'our-popup', openerId: 'our-page' }, browser), true);
  const beforeClick = new Set(['our-page', 'initial-blank']);
  assert.equal(isChildTarget({ type: 'page', targetId: 'noopener-popup', url: 'https://fixture/new', openerId: null }, browser, beforeClick), true,
    'a target created by this click is followed even if Edge omits openerId');
  const afterUnrelated = new Set(['our-page', 'initial-blank', 'edge-sync-dialog']);
  assert.equal(isChildTarget({ type: 'page', targetId: 'edge-sync-dialog', url: 'https://edge/sync' }, browser, afterUnrelated), false,
    'an unrelated target already present before the click is not followed');
  browser.targetId = 'our-popup'; browser.knownTabs.add('our-popup');
  assert.equal(isChildTarget({ type: 'page', targetId: 'nested-popup', openerId: 'our-popup' }, browser), true, 'following a tab updates the opener for subsequent clicks');
});


test('visible Edge browser uses the startup blank tab rather than spawning two pages', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/core/browser.js', import.meta.url), 'utf8');
  assert.match(src, /initialTabs\.find\(t => t\.type === 'page' && t\.url === 'about:blank' && !t\.attached\)/);
  assert.match(src, /existingPage\?\.targetId \|\| startupTab\?\.targetId \|\|/, 'prioritize populated tabs over blank startup tab');
  assert.match(src, /Target\.createTarget/, 'fallback still works if no startup tab exists');
});

test('V4 browser session is stable across follow-up turns in one conversation', async () => {
  const { hostSessionId } = await import('../src/v4/turn-state.js');
  const first = hostSessionId('v4', { conversationId: 'conversation-A', goal: { id: 'goal-1' } });
  const next = hostSessionId('v4', { conversationId: 'conversation-A', goal: { id: 'goal-2' } });
  const other = hostSessionId('v4', { conversationId: 'conversation-B', goal: { id: 'goal-3' } });
  assert.equal(first, next, 'continuation reuses the same Chrome profile/window');
  assert.notEqual(first, other, 'distinct conversations do not share browsing state');
  assert.equal(hostSessionId('v4', { goal: { id: 'solo' } }), 'v4:solo', 'standalone goal fallback remains');
});

test('semantic form: select one observed radio option by group and verify DOM state', async () => {
  const { observeForm, describeForm, fillForm } = await import('../src/core/browser-form.js');
  let selected = '';
  const fields = [
    { ref: 'f1', selector: '[data-majin-form-ref="f1"]', label: 'Malmö', type: 'radio', tag: 'input', name: 'city', group: 'city', option: 'Malmö', value: 'malmo', form: '', sensitive: false },
    { ref: 'f2', selector: '[data-majin-form-ref="f2"]', label: 'Helsingborg', type: 'radio', tag: 'input', name: 'city', group: 'city', option: 'Helsingborg', value: 'helsingborg', form: '', sensitive: false },
  ];
  const snapshot = () => ({
    document: 'doc1', url: 'https://example.test/apply', title: 'Application',
    fields: fields.map(f => ({ ...f, filled: selected === f.value })),
    buttons: [], alerts: [], barriers: [],
  });
  const browser = {
    eval: async expression => expression.includes('window.__majinFormDocument')
      ? snapshot()
      : expression.includes('?.checked') ? selected === 'helsingborg' : null,
  };
  const first = await observeForm(browser, 'radio-test');
  assert.match(describeForm(first), /"group":"city"/);
  assert.match(describeForm(first), /Helsingborg/);
  const applied = await fillForm({
    browser, session: 'radio-test', values: { city: 'Helsingborg' },
    run: async (name, input) => {
      assert.equal(name, 'browser.click');
      assert.equal(input.selector, '[data-majin-form-ref="f2"]');
      selected = 'helsingborg';
      return { ok: true };
    },
  });
  assert.equal(applied.ok, true);
  assert.equal(selected, 'helsingborg');
  const invalid = await fillForm({
    browser, session: 'radio-test', values: { city: 'Uppsala' },
    run: async () => { throw Error('must not click an unobserved option'); },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'radio_option_not_grounded');
});

test('V4 unreadable PDF recovery uses installed alternate extractor without a shell', async () => {
  const { extractPdfWithInstalledPython } = await import('../src/v4/tools.js');
  const documentText = ('Kristjan Kristinsson IT consultant Microsoft Intune Entra ID. ').repeat(6);
  let attempts = 0;
  const result = extractPdfWithInstalledPython('C:\\CV Test\\cv.pdf', {
    runner: (_bin, args, opts) => {
      attempts += 1;
      assert.equal(opts.shell, false);
      assert.ok(opts.timeout <= 10000);
      assert.equal(args.at(-1), 'C:\\CV Test\\cv.pdf');
      assert.ok(args.includes('-c'));
      return { status: 0, stdout: documentText };
    },
  });
  assert.equal(attempts, 1);
  assert.equal(result.confidence, 'text');
  assert.match(result.text, /Microsoft Intune/);
  assert.equal(extractPdfWithInstalledPython('/tmp/bad.pdf', {
    runner: () => ({ status: 0, stdout: '??' }),
  }), null, 'nonsense text must not be treated as a successful recovery');
  assert.equal(extractPdfWithInstalledPython('/tmp/no-pdfminer.pdf', {
    runner: () => ({ status: 1, stdout: '', stderr: 'ImportError' }),
  }), null, 'missing optional parser must remain a truthful failure');
});

test('native textarea fallback types in chunks and verifies persisted value', async () => {
 const { typeWithNativeEvents } = await import('../src/core/browser-form.js');
 const desired='Verifiable IT experience. '.repeat(30);
 let value='old draft';
 const events=[];
 const browser={
  eval:async script=>{
   if(script.includes('el.focus();el.select()'))return true;
   if(script.includes('?.blur()'))return undefined;
   return {exists:true,value,disabled:false};
  },
  send:async (method,params)=>{
   events.push([method,params]);
   if(method==='Input.dispatchKeyEvent' && params.type==='keyDown')value='';
   if(method==='Input.insertText')value+=params.text;
  },
 };
 const result=await typeWithNativeEvents({browser,selector:'[data-majin-form-ref="f10"]',value:desired,chunkSize:120});
 assert.equal(result.ok,true);
 assert.equal(value,desired);
 assert.ok(events.filter(([type])=>type==='Input.insertText').length>2);
 assert.ok(events.every(([type,params])=>type!=='Input.insertText'||params.text.length<=120));
});

test('native textarea fallback stops on reactive framework reverting field value',async()=>{
 const { typeWithNativeEvents } = await import('../src/core/browser-form.js');
 let value='',writes=0;
 const browser={
  eval:async script=>{
   if(script.includes('el.focus();el.select()'))return true;
   return {exists:true,value};
  },
  send:async (method,params)=>{
   if(method==='Input.insertText'){writes++;value='';}
  },
 };
 const result=await typeWithNativeEvents({browser,selector:'textarea',value:'a'.repeat(400)});
 assert.equal(result.ok,false);
 assert.equal(result.code,'framework_reverted');
 assert.equal(writes,1,'do not repeatedly overwrite a reactive field');
});

test('browser never navigates null/about:blank during attach and cleans only surplus blanks', async () => {
 const src=(await import('node:fs')).readFileSync(new URL('../src/core/browser.js', import.meta.url),'utf8');
 assert.match(src, /if \(url && url !== 'about:blank'\) \{/);
 assert.match(src, /currentUrl !== String\(url\)/);
 assert.match(src, /tab\.targetId === b\.targetId \|\| tab\.url !== 'about:blank'/);
 assert.match(src, /Target\.closeTarget/);
 assert.doesNotMatch(src, /--disable-popup-blocking/, 'agent must not disable Chrome popup protection');
 const {isChildTarget}=await import('../src/core/browser.js');
 const browser={targetId:'job',knownTabs:new Set(['job'])};
 assert.equal(isChildTarget({type:'page',targetId:'blank',openerId:'job',url:'about:blank'},browser),false);
 assert.equal(isChildTarget({type:'page',targetId:'application',openerId:'job',url:'https://apply.example/'},browser),true);
});

test('V4 Chrome launch gets its own bounded startup timeout, ordinary tools unchanged',async()=>{
 const src=(await import('node:fs')).readFileSync(new URL('../src/v4/agent.js',import.meta.url),'utf8');
 assert.match(src,/toolName === 'browser_open'/);
 assert.match(src,/Math\.max\(config\.limits\.toolTimeoutMs, 45_000\)/);
 assert.match(src,/registryForCall\(signal, toolTimeoutMs\)/);
 assert.match(src,/timeoutMs: toolTimeoutMs/);
});

test('visible Chrome startup cannot forward about:blank into an existing profile repeatedly', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/core/browser.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /args\.push\('about:blank'\)/, 'explicit blank URL creates tabs through Chrome single-instance handoff');
  assert.match(src, /maxLaunchAttempts = binaries.length > 1 \? 2 : headless === false \? 1 : 2/, 'visible browser tries only distinct installed browser families');
  assert.match(src, /proc\.exitCode !== null \|\| proc\.signalCode !== null/, 'detect early child exit rather than retrying a locked profile');
  assert.match(src, /Chrome\/Edge exited before CDP was available|the browser debug port never came up/, 'report the launch or CDP failure, never blame the form');
  assert.match(src, /--remote-debugging-port=\$\{port\}/, 'retain MAJIN-owned CDP control');
});

test('failed browser launch activates cooldown and never starts another Chrome immediately', async () => {
 const {openFor,browserLaunchState,_resetBrowser}=await import('../src/core/browser.js');
 _resetBrowser();
 const session='cooldown-test';
 const pool={claim:async()=>1,release:()=>true};
 const first=await openFor({session,exe:'/definitely/not/a/browser',pool}).then(()=>null,e=>e);
 assert.ok(first instanceof Error);
 assert.ok(browserLaunchState(session).retryAfterMs>0);
 const second=await openFor({session,exe:'/definitely/not/a/browser',pool}).then(()=>null,e=>e);
 assert.match(String(second.message),/cooldown/);
 _resetBrowser();
 assert.equal(browserLaunchState(session).retryAfterMs,0);
});
test('MAJIN Chrome browser requires exclusive ephemeral profile and single-flight open', async () => {
 const fs=await import('node:fs');
 const src=fs.readFileSync(new URL('../src/core/browser.js',import.meta.url),'utf8');
 assert.match(src,/fs\.mkdtempSync\(path\.join\(dirs\.cache, 'browser-run-'\)\)/);
 assert.match(src,/const pending = launches\.get\(session\)/);
 assert.match(src,/launches\.set\(session, launching\)/);
 assert.match(src,/failedLaunches\.set\(session, Date\.now\(\) \+ BROWSER_START_COOLDOWN_MS\)/);
 assert.doesNotMatch(src,/const profile = profileFor\(\x60\$\{session\}-s\$\{slot\}\x60\)/);
});

test('visible browser is the default and Chrome flags are never exposed as shell instructions', async () => {
 const fs = await import('node:fs');
 const web = fs.readFileSync(new URL('../src/core/tools/web.js', import.meta.url), 'utf8');
 const browser = fs.readFileSync(new URL('../src/core/browser.js', import.meta.url), 'utf8');
 assert.match(web, /async run\(\{ url, headless = false \}, ctx\)/);
 assert.match(web, /NEVER invoke --remote-debugging-port/);
 assert.match(browser, /const families = new Set\(\)/);
 assert.match(browser, /profile = fs\.mkdtempSync/);
 assert.match(browser, /const launchBin = binaries\[Math\.min\(attempt - 1, binaries\.length - 1\)\]/);
});
