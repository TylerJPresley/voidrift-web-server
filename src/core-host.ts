/**
 * The single `createCore` wiring (web-blueprint.md §1.5 step 2, §11, core §2.1).
 *
 * The backend constructs ONE core per process and routes every user's every
 * conversation through it as a distinct session (§1.2). It injects the durable
 * backends behind the core's ports: the Postgres checkpointer (core §11) built
 * from `apps.web.postgresUrlEnv`, so a session is resumable by id from any
 * instance (core §5.3), and the out_of_band ApprovalHandler (§6.1). The backend
 * owns its own signals, so `installSignalHandlers` stays false (§1.5 step 2).
 *
 * NOTE (CoreAPI gap, see m6-web.md): `CoreOptions` exposes a `checkpointer`
 * injection seam but no `store` seam — the hosted `MemoryStore` (core §6.1, web
 * §11) cannot be injected through `createCore` yet, and `documents` is a core
 * stub (§5.2). The host wires everything the surface allows and names the gap.
 */
import {
  createCore,
  type CoreReady,
  type CoreOptions,
  type ApprovalHandler,
} from "@voidrift/core";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { outOfBandApprovalHandler } from "./approvals.js";
import { registerBuiltinPanels } from "./stream/builtin-panels.js";

export interface CoreHostOptions {
  readonly workspaceRoot: string;
  /** The durable checkpointer: Postgres in production, in-memory/SQLite in tests
   * (web §11). Injected so a hosted deployment resumes by id across instances. */
  readonly checkpointer: BaseCheckpointSaver;
  /** The approval handler; defaults to out_of_band (§6.1). */
  readonly onApproval?: ApprovalHandler;
  readonly output?: (text: string) => void;
  readonly openPanel?: (name: string) => void;
  /** Test seam: an injected session repository (shared across instances in tests
   * to prove resume-across-process, §11). */
  readonly sessionRepository?: import("@voidrift/core").SessionRepository;
  /** Test seam: an injected config store (in-memory in tests for determinism,
   * §13.1, §15.3). The production default is the on-disk filesystem store. */
  readonly configStore?: import("@voidrift/core").ConfigStore;
  /** Test seam: a `fakeModel()` chat-model factory for deterministic offline runs.
   * Typed loosely because the core does not export `ChatModelFactory`; the value
   * is passed straight through to `createCore`'s own typed seam. */
  readonly chatModelFactory?: unknown;
}

/** Construct the backend's single core (§1.5 step 2). */
export async function createCoreHost(opts: CoreHostOptions): Promise<CoreReady> {
  const ready = await createCore({
    workspaceRoot: opts.workspaceRoot,
    checkpointer: opts.checkpointer,
    onApproval: opts.onApproval ?? outOfBandApprovalHandler(),
    installSignalHandlers: false,
    ...(opts.output ? { output: opts.output } : {}),
    ...(opts.openPanel ? { openPanel: opts.openPanel } : {}),
    ...(opts.sessionRepository ? { sessionRepository: opts.sessionRepository } : {}),
    ...(opts.configStore ? { configStore: opts.configStore } : {}),
    ...(opts.chatModelFactory
      ? ({ chatModelFactory: opts.chatModelFactory } as Pick<CoreOptions, "chatModelFactory">)
      : {}),
  });
  // Panels ship WITH the backend (handoff §0.1): register its own built-in
  // declarations through the same `register.panel` seam a plugin uses, right
  // after `createCore`. `/api/panels` then relays `registry.panels()` unchanged.
  registerBuiltinPanels(ready.api);
  return ready;
}
