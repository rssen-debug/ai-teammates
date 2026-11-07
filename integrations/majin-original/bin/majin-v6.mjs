#!/usr/bin/env node
/**
 * MAJIN V6 entry point. No GUI, no EXE, no separate chat. OpenCode remains the
 * interactive CLI; this binary provides MCP, the worker and diagnostics.
 */
import { main } from '../src/v6/cli.js';

const code = await main(process.argv.slice(2));
process.exitCode = typeof code === 'number' ? code : 0;
