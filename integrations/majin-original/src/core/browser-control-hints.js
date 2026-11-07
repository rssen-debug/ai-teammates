/**
 * Browser control hints based on LIVE DOM, not model-generated selectors.
 * Never return values, hidden inputs, passwords, tokens, or page text unrelated
 * to interactive controls. browser.elements remains the full grounding option.
 */
export const VISIBLE_CONTROLS_JS = String.raw`(() => {
  const nodes = [...document.querySelectorAll('input, textarea, select, button')];
  const safeId = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
  const output = [];
  for (const el of nodes) {
    if (output.length >= 20) break;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || (tag === 'button' ? 'button' : 'text')).toLowerCase();
    if (['hidden','password','file'].includes(type)) continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || !el.getClientRects().length) continue;
    const id = el.getAttribute('id') || '';
    const name = el.getAttribute('name') || '';
    let selector = '';
    if (safeId.test(id)) selector = '#' + id;
    else if (safeId.test(name)) selector = tag + '[name="' + name + '"]';
    if (!selector) continue; // never invent an ungrounded nth-child guess
    const label = el.labels?.[0]?.textContent || el.getAttribute('aria-label') ||
      (tag === 'button' ? el.textContent : '') || '';
    output.push({
      selector, tag, type,
      label: String(label).replace(/\s+/g, ' ').trim().slice(0, 70),
      checked: type === 'checkbox' ? Boolean(el.checked) : undefined,
    });
  }
  return output;
})()`;

export function formatControlHints(controls) {
  if (!Array.isArray(controls) || !controls.length) return '';
  const rows = [];
  for (const c of controls.slice(0,20)) {
    const selector = String(c?.selector || '');
    // Only CSS ID and simple input names, both produced by the DOM walker.
    if (!/^#[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(selector) &&
        !/^(?:input|textarea|select|button)\[name="[A-Za-z][A-Za-z0-9_-]{0,62}"\]$/.test(selector)) continue;
    const type = String(c.type || '').toLowerCase();
    if (['password','hidden','file'].includes(type)) continue;
    const label = String(c.label || '').replace(/[\r\n|]/g, ' ').trim().slice(0,70);
    const checked = type === 'checkbox' ? (c.checked ? ', checked' : ', unchecked') : '';
    rows.push('- ' + selector + ' (' + String(c.tag || 'input').slice(0,12) +
      ', ' + type.slice(0,20) + checked + ')' + (label ? ' — ' + label : ''));
  }
  return rows.length
    ? '\n\nInteractive fields found on THIS page (real CSS selectors; no field values shown):\n' +
      rows.join('\n') +
      '\nFor unlisted or dynamic controls use browser.elements for live numbered references.'
    : '';
}
