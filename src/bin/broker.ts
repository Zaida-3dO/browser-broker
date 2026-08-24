#!/usr/bin/env node
import { run } from '../cli/index.ts';

/**
 * The executable entry point. Argument vector in, exit code out, and nothing
 * else — every decision belongs to the dispatcher, which stays importable so
 * the command line can be driven in process (`MILESTONES.md`).
 */
process.exitCode = await run(process.argv.slice(2));
