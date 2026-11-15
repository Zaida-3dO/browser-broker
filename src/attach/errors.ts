import { BrokerError } from '../errors.ts';

/**
 * A refusal from the attached layer.
 *
 * Every rule this layer enforces is one of these, so the service layer can
 * branch on {@link BrokerError.rule} — `attached.not_connected` and friends —
 * the same way every other refusal in the service is distinguished from a
 * programming mistake, rather than matching on English.
 */
export class AttachedError extends BrokerError {
  constructor(rule: string, message: string, options?: { cause?: unknown }) {
    super(rule, message, options);
    this.name = 'AttachedError';
  }
}
