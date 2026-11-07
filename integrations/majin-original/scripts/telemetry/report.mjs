#!/usr/bin/env node
/** MAJIN V2 telemetry report CLI: renders markdown/JSON from local shards. */
import { aggregate, renderReport } from '../../src/v2/telemetry/aggregate.js';
const dir = process.argv[2] || process.env.MAJIN_TELEMETRY_DIR || `${process.env.USERPROFILE || '.'}/majin-v2/telemetry`;
const days = Number(process.argv[3]) || 7;
const rep = aggregate(dir, { lastDays: days });
if (process.argv.includes('--json')) console.log(JSON.stringify(rep, null, 2));
else process.stdout.write(renderReport(rep));
