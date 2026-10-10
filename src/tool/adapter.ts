import type { Adapter, OperationWaiver } from '../adapter/contract.ts';
import type { OperationName } from '../adapter/operations.ts';
import type { BrokerService, OperationOutcome } from '../adapter/service-seam.ts';
import { TOOLS_BY_NAME, TOOL_OPERATIONS } from './tools.ts';

/**
 * The tool surface as an adapter: a thin shell over one service call.
 *
 * ── This is the primary route ───────────────────────────────────────────
 *
 * `MILESTONES.md` #27: the service is **spawned by its caller**, serves that
 * session, and exits with it. No port, no daemon, no container. This is the
 * route real callers use, and the command line exists mainly as the second
 * route that makes the parity claim assertable (§5.1).
 *
 * ── What this file may and may not do ───────────────────────────────────
 *
 * It resolves a tool call into arguments, calls **one** service operation,
 * and shapes the outcome for the wire. It reaches no database and no guard:
 * it is handed a {@link BrokerService} rather than finding one, so there is no
 * store handle in scope to be tempted by. Every rule that decides whether an
 * operation is allowed lives behind that seam, or it holds on this route and
 * not the others (`CLAUDE.md`).
 *
 * **Stated honestly, because the seam cannot enforce it:** nothing structural
 * stops a future edit adding a check here. `db.import_isolated` (§7.3) is a
 * build rule precisely because a type cannot express "and you did not
 * reimplement this". What this file does is keep the correct path the easy
 * one — one call in, one outcome out, no branch between them that could
 * decide anything.
 */

/**
 * Every operation this route offers, from the tool table (a folded tool offers one per action).
 *
 * Read from the table rather than written out again, so the tools a caller
 * can see and the operations the parity suite drives cannot drift.
 */
export const TOOL_SURFACE_OPERATIONS: readonly OperationName[] = TOOL_OPERATIONS;

/**
 * Operations this route does not offer, with the reason each is absent.
 *
 * **One, and it is the `browser_feedback` tool, retired.** §3.16 built that
 * tool to be removed once callers had gone quiet: its per-turn description
 * cost is the thing being stopped. The *operation* and its store stay, reached
 * by `broker feedback` on the command line, so the waiver names that route in
 * `coveredBy` — which is what lets a route exposing write operations waive
 * one (the runner checks the cover really offers it). Everything else is on
 * both routes; the two sign-in operations are one folded tool here, not a gap.
 *
 * Note what a waiver could *not* buy here: this route declares `readOnly:
 * false`, and the runner refuses a write waiver from a route that is not
 * read-only unless another route covers it. Declaring it read-only to buy
 * waivers would be the loophole, so the declaration is made honestly.
 */
export const TOOL_OPERATION_WAIVERS: readonly OperationWaiver[] = [
  {
    operation: 'feedback',
    reason:
      'The browser_feedback tool was retired once callers stopped using it (SCHEMA 3.16 exit condition); the command line still records and reads feedback.',
    coveredBy: 'cli',
  },
];

/**
 * The tool-surface adapter.
 *
 * Its `id` is `tool-stdio`, which is also the value §1.6 names for the
 * ledger's `adapter` column — the column that turns "the same rules apply on
 * every route" from a claim into a query. One spelling, used by the registry,
 * the ledger and the conformance report alike.
 */
export const toolStdioAdapter: Adapter = {
  id: 'tool-stdio',
  description:
    'The tool surface over standard input and output. Spawned by its caller, serves that session, exits with it.',
  readOnly: false,
  operations: TOOL_SURFACE_OPERATIONS,
  waivers: TOOL_OPERATION_WAIVERS,
  invoke: async (
    service: BrokerService,
    operation: OperationName,
    input: unknown,
  ): Promise<OperationOutcome> => {
    // The route's own vocabulary is a tool-call object: a name and an
    // arguments record. Anything else is a caller reaching past the
    // transport, so it is refused rather than coerced.
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('the tool-surface adapter takes a tool-call object');
    }
    const call = input as { name?: unknown; arguments?: unknown };
    if (typeof call.name !== 'string') {
      throw new TypeError('a tool call names the tool it is calling');
    }

    const tool = TOOLS_BY_NAME.get(call.name);
    if (tool === undefined) {
      throw new TypeError(`no tool named "${call.name}"`);
    }
    // A tool maps to one operation (a folded tool, one per action), so a call
    // naming a tool that does not perform the operation asked for is a wiring bug in the caller rather
    // than something to reconcile silently.
    const performed = tool.actions === undefined ? [tool.operation] : Object.values(tool.actions);
    if (!performed.includes(operation)) {
      throw new TypeError(
        `${call.name} performs "${performed.join('" or "')}", not "${String(operation)}"`,
      );
    }

    const args =
      call.arguments === null || typeof call.arguments !== 'object' || Array.isArray(call.arguments)
        ? {}
        : (call.arguments as Record<string, unknown>);

    return service.perform({ operation, adapter: 'tool-stdio', arguments: args });
  },
};
