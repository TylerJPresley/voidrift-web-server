/**
 * The out-of-band ApprovalHandler (web-blueprint.md §6.1, core §2.1, §9.5).
 *
 * The hosted deployment runs the core in out_of_band mode by default: a gated
 * `ask` must NOT block the turn. This handler never resolves on its own — it
 * leaves the turn to pause with `waiting_for_approval` and a durable
 * `PendingApproval`, which the `send` HTTP response returns and the browser
 * resolves later with `session.confirm` posted to ANY backend instance (§6.1,
 * core §5.7). Because it never resolves, the engine records the pending approval
 * and returns a non-terminal `TurnResult` rather than calling back in-process.
 *
 * The full action the dialog shows is already masked by the core before the
 * request leaves the process (core §10.10); this handler passes nothing to the
 * client and reconstructs nothing (invariant §12.1#5).
 */
import type { ApprovalHandler } from "@voidrift/core";

/**
 * An approval handler that pauses the turn durably instead of answering. It
 * returns a never-resolving promise so the core treats the ask as unhandled and
 * records a durable `PendingApproval`; the browser confirms out of band (§6.1).
 */
export function outOfBandApprovalHandler(): ApprovalHandler {
  return () =>
    // Never resolves: the engine's out_of_band path records the pending approval
    // and returns `waiting_for_approval` without blocking (§6.1, core §9.5).
    new Promise(() => {
      /* intentionally pending — the turn pauses durably */
    });
}
