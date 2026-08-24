/**
 * The base every refusal in this service is thrown as.
 *
 * `SCHEMA.md` §7 is organised around refusals — "a rule that never refuses
 * anything protects nothing, so the refusals are the specification" — and a
 * refusal has to be distinguishable from a programming mistake at the point
 * something decides what to print and what exit code to use. A thrown
 * `TypeError` is a bug in this service; a thrown `BrokerError` is this
 * service declining to run, and the difference is the whole of the entry
 * point's error handling.
 *
 * Row #10 grows this into the rejection taxonomy every guard draws from.
 * Row #3 ships only the base and the two refusals it actually has, because
 * a taxonomy with no cases is a shape nobody has tested.
 */
export class BrokerError extends Error {
  /**
   * The rule that refused, spelled as `SCHEMA.md` §7 spells it — for
   * example `store.not_on_network_filesystem`. Carried as data rather than
   * baked into the message so a caller can branch on the rule without
   * matching on English.
   */
  readonly rule: string;

  constructor(rule: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BrokerError';
    this.rule = rule;
  }
}

/** A refusal from §7.2 — checked on every spawn, and the service does not run. */
export class StartupRefusal extends BrokerError {
  constructor(rule: string, message: string, options?: { cause?: unknown }) {
    super(rule, message, options);
    this.name = 'StartupRefusal';
  }
}
