/**
 * The session registry (web-blueprint.md §1.3 sessions.ts, §2, §4).
 *
 * The ONE place a session-targeting CoreAPI call is made (invariant §12.1#1).
 * Every operation runs the ownership check FIRST (§4.2): a non-owner is refused
 * before the CoreAPI is touched, mapping to 403 at the HTTP edge and a refused
 * subscribe at the WS edge. `create` records the owner; `list` is filtered to
 * the principal; `delete` forgets ownership. Each action maps to exactly one
 * CoreAPI operation (§2.1 — the frontend never chains calls).
 */
import type {
  CoreAPI,
  Result,
  SessionInfo,
  ResumedSession,
  TurnResult,
  ApprovalResponse,
} from "@voidrift/core";
import type { Authorizer } from "./authz/ownership.js";
import type { Principal } from "./auth/principal.js";

/** A refusal that never reaches the core (§4.2). The HTTP layer maps `status`. */
export interface Refusal {
  readonly refused: true;
  readonly status: 403 | 404 | 429;
  readonly reason: string;
}

export type Authorized<T> = { readonly refused: false; readonly value: T } | Refusal;

function forbidden(): Refusal {
  // A non-owner and a missing record both surface as 403 so an id cannot be
  // probed for existence (§4.3 — ids are not authorization).
  return { refused: true, status: 403, reason: "forbidden" };
}

export class SessionRegistry {
  constructor(
    private readonly api: CoreAPI,
    private readonly authz: Authorizer,
    private readonly maxSessionsPerUser: number,
  ) {}

  /** Create a session owned by the principal (§4.2). Enforces the per-user cap. */
  async create(principal: Principal, name?: string): Promise<Authorized<Result<SessionInfo>>> {
    const owned = await this.authz.countOwned(principal.userId);
    if (owned >= this.maxSessionsPerUser) {
      return { refused: true, status: 429, reason: "session limit reached" };
    }
    const res = await this.api.session.create(name ? { name } : undefined);
    if (res.ok) await this.authz.recordOwner(res.value.id, principal.userId);
    return { refused: false, value: res };
  }

  /** List only the principal's own (and granted) sessions (§4.2 — no enumeration). */
  async list(principal: Principal): Promise<SessionInfo[]> {
    const owned = await this.authz.ownedIds(principal.userId);
    const all = await this.api.session.list();
    return all.filter((s) => owned.has(s.id));
  }

  async resume(principal: Principal, id: string): Promise<Authorized<Result<ResumedSession>>> {
    const ok = await this.guard(principal, id);
    if (ok) return ok;
    return { refused: false, value: await this.api.session.resume(id) };
  }

  async send(
    principal: Principal,
    id: string,
    input: string,
  ): Promise<Authorized<Result<TurnResult>>> {
    const ok = await this.guard(principal, id);
    if (ok) return ok;
    return { refused: false, value: await this.api.session.send(id, { input }) };
  }

  async confirm(
    principal: Principal,
    id: string,
    response: ApprovalResponse,
  ): Promise<Authorized<Result<TurnResult>>> {
    const ok = await this.guard(principal, id);
    if (ok) return ok;
    return { refused: false, value: await this.api.session.confirm(id, response) };
  }

  async cancel(principal: Principal, id: string): Promise<Authorized<Result<void>>> {
    const ok = await this.guard(principal, id);
    if (ok) return ok;
    return { refused: false, value: await this.api.session.cancel(id) };
  }

  async rename(
    principal: Principal,
    id: string,
    name: string,
  ): Promise<Authorized<Result<SessionInfo>>> {
    const ok = await this.guard(principal, id);
    if (ok) return ok;
    return { refused: false, value: await this.api.session.rename(id, name) };
  }

  async remove(
    principal: Principal,
    id: string,
  ): Promise<Authorized<Result<{ reclaimedBytes: number; remainingBranches: string[] }>>> {
    const ok = await this.guard(principal, id);
    if (ok) return ok;
    const res = await this.api.session.delete(id);
    if (res.ok) await this.authz.forget(id);
    return { refused: false, value: res };
  }

  /** Pending approvals for a session the principal owns (§6). */
  async approvals(principal: Principal, id: string): Promise<Authorized<Result<unknown[]>>> {
    const ok = await this.guard(principal, id);
    if (ok) return ok;
    return { refused: false, value: await this.api.permissions.approvals(id) };
  }

  /** Ownership gate shared by every session-targeting op (§4.2, §4.3). Returns a
   * `Refusal` to short-circuit BEFORE any CoreAPI call, or null when allowed. */
  async guard(principal: Principal, id: string): Promise<Refusal | null> {
    const outcome = await this.authz.authorize(principal.userId, id);
    return outcome.allowed ? null : forbidden();
  }
}
