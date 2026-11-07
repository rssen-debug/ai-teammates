/**
 * MAJIN — acceptance-matrix integrity checker (§12).
 * The matrix carries FOUR representations of the same earned total:
 *   1. header       "**Score so far: E / 100**"
 *   2. phase table  "| N. Name | max | earned |"  → sum(earned)
 *   3. TOTAL row    "| **TOTAL** | **100** | **E** |"
 *   4. detail rows  "| ID | pts | … | PASS | date |" → sum(pts of PASS rows)
 *   5. DEL headers  "## DEL N — … (earned/max)" → sum(earned)
 * All FIVE must agree — drift between them has corrupted the record twice
 * (2026-10-19/20). This checker is imported by BOTH the CI test and the
 * release gate: one parser, one verdict, zero forks of the truth.
 */
import fs from 'node:fs';

const RE_HEADER = /\*\*Score so far: (\d+) \/ (\d+)\*\*/;
const RE_TOTAL = /\| \*\*TOTAL\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \|/;
const RE_PHASEROW = /^\| (\d+)\. [^|]+\| (\d+) \| (\d+) \|\s*$/gm;
const RE_DELHEAD = /^## DEL (\d+) — .+?\((\d+)\/(\d+)\)/gm;
const RE_DETAIL = /^\| ([0-9]+[A-Z]) \| (\d+) \|/gm;

export function checkMatrixText(text) {
  const problems = [];

  const hm = RE_HEADER.exec(text);
  if (!hm) problems.push('header score line missing');
  const headerEarned = hm ? Number(hm[1]) : null;
  const headerMax = hm ? Number(hm[2]) : null;

  const tm = RE_TOTAL.exec(text);
  if (!tm) problems.push('TOTAL row missing or malformed');
  const totalMax = tm ? Number(tm[1]) : null;
  const totalEarned = tm ? Number(tm[2]) : null;

  const phases = [];
  for (const m of text.matchAll(RE_PHASEROW)) phases.push({ n: Number(m[1]), max: Number(m[2]), earned: Number(m[3]) });
  if (!phases.length) problems.push('phase table missing');
  const phaseEarnedSum = phases.reduce((a, p) => a + p.earned, 0);
  const phaseMaxSum = phases.reduce((a, p) => a + p.max, 0);

  const dels = [];
  for (const m of text.matchAll(RE_DELHEAD)) dels.push({ n: Number(m[1]), earned: Number(m[2]), max: Number(m[3]) });
  if (!dels.length) problems.push('DEL section headers missing');
  const delEarnedSum = dels.reduce((a, d) => a + d.earned, 0);
  const delMaxSum = dels.reduce((a, d) => a + d.max, 0);

  /* detail rows: pts column is the second cell; PASS means the status cell
     contains "PASS" anywhere between the last two pipes. Parse directly. */
  let passPts = 0; let rowCount = 0; let passNoEvidence = 0;
  for (const line of text.split('\n')) {
    const dm = /^\| ([0-9]+[A-Z]) \| (\d+) \|(.*)\|\s*$/.exec(line.trim());
    if (!dm) continue;
    rowCount += 1;
    const pts = Number(dm[2]);
    const rest = dm[3];
    const cells = rest.split('|').map((c) => c.trim());
    const status = cells[cells.length - 2] ?? '';
    const evidence = cells[1] ?? '';
    if (/PASS/.test(status)) {
      passPts += pts;
      if (!evidence || evidence === '—') passNoEvidence += 1;
    }
  }
  if (!rowCount) problems.push('no detail rows parsed');

  const totals = {
    header: headerEarned, phaseSum: phaseEarnedSum, totalRow: totalEarned, delSum: delEarnedSum, rowSum: passPts,
    maxHeader: headerMax, maxTotal: totalMax, maxPhaseSum: phaseMaxSum, maxDelSum: delMaxSum,
  };
  const earnedVals = [totals.header, totals.phaseSum, totals.totalRow, totals.delSum, totals.rowSum].filter((v) => v != null);
  if (earnedVals.length && Math.min(...earnedVals) !== Math.max(...earnedVals)) {
    problems.push(`earned-total drift: header=${totals.header} phaseSum=${totals.phaseSum} TOTAL=${totals.totalRow} delSum=${totals.delSum} rowSum=${totals.rowSum}`);
  }
  if (passNoEvidence) problems.push(`${passNoEvidence} PASS row(s) without an evidence cell`);
  const maxVals = [totals.maxHeader, totals.maxTotal, totals.maxPhaseSum, totals.maxDelSum].filter((v) => v != null);
  if (maxVals.length && Math.min(...maxVals) !== Math.max(...maxVals)) {
    problems.push(`max-total drift: header=${totals.maxHeader} TOTAL=${totals.maxTotal} phaseSum=${totals.maxPhaseSum} delSum=${totals.maxDelSum}`);
  }
  return { ok: problems.length === 0, problems, totals, detailRows: rowCount };
}

export function checkMatrixFile(path) {
  return checkMatrixText(fs.readFileSync(path, 'utf8'));
}
