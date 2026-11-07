// Expense report summarizer — dependency-free Node.js CLI.
// Exported: summarize(rows) -> { totalCents, byCategory }
// CLI: reads a JSON array of rows from stdin, writes the JSON summary to stdout.

/**
 * Parse a signed decimal amount with at most two decimal places into integer cents.
 * Throws TypeError on invalid input. Avoids binary floating-point error by
 * working on the string representation, never on a float.
 */
export function toCents(value) {
  if (typeof value === 'number') {
    // Reject non-finite numbers; convert finite ones to their canonical string.
    if (!Number.isFinite(value)) {
      throw new TypeError(`invalid amount: ${value}`);
    }
    value = String(value);
  }
  if (typeof value !== 'string') {
    throw new TypeError(`invalid amount: ${JSON.stringify(value)}`);
  }
  // Optional sign, digits, optional fraction of at most 2 digits.
  const m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) {
    throw new TypeError(`invalid amount: ${JSON.stringify(value)}`);
  }
  const sign = m[1] === '-' ? -1 : 1;
  const whole = m[2];
  const frac = (m[3] || '').padEnd(2, '0');
  const cents = Number(whole) * 100 + Number(frac);
  return sign * cents;
}

/**
 * Summarize expense rows: { category: string, amount: number|string }.
 * Returns { totalCents: number, byCategory: { [category]: cents } }.
 * Throws TypeError on missing/empty category or invalid amount.
 */
export function summarize(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }
  // Map for accumulation so category names like "__proto__" and "constructor"
  // never collide with Object.prototype keys.
  const totals = new Map();
  let totalCents = 0;
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError('each row must be an object');
    }
    const category = row.category;
    if (typeof category !== 'string' || category.trim() === '') {
      throw new TypeError(`missing or invalid category: ${JSON.stringify(category)}`);
    }
    const cents = toCents(row.amount);
    totals.set(category, (totals.get(category) || 0) + cents);
    totalCents += cents;
  }
  // Plain object with defineProperty (DefineOwnProperty semantics), so
  // "__proto__" stays an own data key instead of mutating the prototype.
  const byCategory = {};
  for (const [key, cents] of totals) {
    Object.defineProperty(byCategory, key, {
      value: cents,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { totalCents, byCategory };
}

// ---- CLI ----
const isMain = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());

if (isMain) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const rows = JSON.parse(raw);
      process.stdout.write(JSON.stringify(summarize(rows)) + '\n');
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(1);
    }
  });
  process.stdin.on('error', (err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
}
