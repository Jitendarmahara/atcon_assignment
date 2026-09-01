import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

// Standard singleton pattern to survive tsx watch's module reloads in dev
// without exhausting the Postgres connection pool.
const globalForPrisma = globalThis as unknown as {
  basePrisma?: PrismaClient;
  scopedPrisma?: PrismaClient;
};

// Unrestricted - whatever role docker-compose's Postgres was initialized
// with (a superuser in the local dev image, so it always bypasses Row-Level
// Security regardless of ENABLE/FORCE). Used directly for pre-auth flows
// (register/login/refresh - there's no org to scope by yet), the public
// unauthenticated careers site, the worker/relay, and the seed script; also
// the fallback identity of the exported `prisma` below whenever there's no
// active per-request org scope.
const basePrisma =
  globalForPrisma.basePrisma ??
  new PrismaClient({
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

// Connects as `ats_app` (migration 20260829213000_row_level_security) -
// unprivileged, RLS-enforced. Every query issued against it only sees rows
// for whichever org `app.org_id` is SET LOCAL to for that specific
// transaction; see the Proxy below, which is where every authenticated
// request actually establishes that scope, one operation at a time.
const scopedPrisma =
  globalForPrisma.scopedPrisma ??
  new PrismaClient({
    datasourceUrl: env.SCOPED_DATABASE_URL,
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (env.NODE_ENV !== "production") {
  globalForPrisma.basePrisma = basePrisma;
  globalForPrisma.scopedPrisma = scopedPrisma;
}

type TxClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

// requestOrgId: which org the CURRENT request belongs to (set once, for the
// request's whole lifetime, by lib/asyncHandler.ts).
// requestTx: the actual open transaction client, but ONLY for the duration
// of one already-open transaction (either one top-level operation's own
// short-lived mini-transaction, or an explicit service-level
// `prisma.$transaction(...)` call) - NOT held for the whole request.
//
// This distinction matters: an earlier version of this scoped one
// transaction to the entire request, which seemed simpler, but it silently
// changed the timing semantics of every service function that reads before
// conditionally writing (e.g. transitionApplication's optimistic-concurrency
// check) - folding "read" and "write" into one long-lived transaction
// removed the gap between them that the whole mechanism depends on. Scoping
// per-operation instead (mirroring exactly which calls already used
// `prisma.$transaction(...)` before RLS existed at all) preserves the
// original timing/isolation characteristics of every service function
// untouched, while every operation still gets `app.org_id` set correctly.
const requestOrgId = new AsyncLocalStorage<string>();
const requestTx = new AsyncLocalStorage<TxClient>();

async function resolveOnClient(client: PrismaClient | TxClient, path: (string | symbol)[], args: unknown[]): Promise<unknown> {
  let obj = client as unknown as Record<string | symbol, unknown>;
  for (const key of path.slice(0, -1)) obj = obj[key] as Record<string | symbol, unknown>;
  const fn = obj[path[path.length - 1]!] as (...a: unknown[]) => unknown;
  return fn.apply(obj, args);
}

async function invoke(path: (string | symbol)[], args: unknown[]): Promise<unknown> {
  const tx = requestTx.getStore();
  if (tx) {
    // Already inside a transaction (a mini-transaction wrapping the
    // top-level call currently in progress, or an explicit
    // prisma.$transaction(...) callback) - never open a nested one, just
    // run directly against it. `app.org_id` was already set once at the
    // start of whichever transaction this is.
    return resolveOnClient(tx, path, args);
  }

  if (path.length === 1 && path[0] === "$transaction") {
    const orgId = requestOrgId.getStore();
    if (!orgId) return (basePrisma.$transaction as (...a: unknown[]) => unknown)(...args);
    // An explicit, multi-statement atomic operation, exactly as authored in
    // the service layer - one real transaction for the whole callback,
    // preserving this codebase's existing atomicity boundaries.
    const [arg] = args;
    if (typeof arg !== "function") {
      // The array form (`prisma.$transaction([p1, p2, ...])`) cannot be
      // supported here: each element is a `prisma.x.y(...)` call made
      // through this same Proxy, which - unlike a real PrismaClient's lazy,
      // deferred PrismaPromise - runs eagerly in its own independent
      // mini-transaction the instant it's called, i.e. while the array
      // literal is still being built, before $transaction is ever invoked.
      // Every "batched" call would already have committed independently by
      // the time this code runs, with no atomicity and no ordering
      // guarantee between them (this is exactly how reorderStages in
      // jobs/service.ts silently corrupted stage ordering - see its
      // comment). Fail loudly instead of quietly returning a result that
      // looks like a successful atomic batch: rewrite the call site to use
      // the callback form (`prisma.$transaction(async (tx) => { ... })`),
      // issuing every statement against the provided `tx`.
      throw new Error(
        "prisma.$transaction(array) is not supported by the RLS-scoping proxy (lib/prisma.ts) - use the callback form: prisma.$transaction(async (tx) => { ... }).",
      );
    }
    return scopedPrisma.$transaction(async (innerTx) => {
      await innerTx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, true)`;
      return requestTx.run(innerTx as unknown as TxClient, () => arg(innerTx));
    });
  }

  const orgId = requestOrgId.getStore();
  if (!orgId) return resolveOnClient(basePrisma, path, args);

  // A standalone top-level call (no explicit $transaction wrapping it, e.g.
  // a plain findFirst/create) - give it its own short-lived mini-transaction
  // so app.org_id still applies, without holding a transaction open for
  // longer than that one call.
  return scopedPrisma.$transaction(async (innerTx) => {
    await innerTx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, true)`;
    return requestTx.run(innerTx as unknown as TxClient, () => resolveOnClient(innerTx, path, args));
  });
}

// A Proxy over a callable, built by accumulating the property-access path
// (`prisma.candidate.findFirst` -> ["candidate", "findFirst"]) until it's
// actually CALLED, at which point `invoke()` decides how to run it against
// whichever client is appropriate. Generic over every model delegate and
// top-level method (`$queryRaw`, `$transaction`, etc.) without needing to
// enumerate them, and - crucially - never wraps a real PrismaClient/
// transaction-client instance itself, so nothing here can corrupt either
// client's own internal state.
function makeProxy(path: (string | symbol)[]): unknown {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      return makeProxy([...path, prop]);
    },
    apply(_target, _thisArg, args) {
      return invoke(path, args);
    },
  });
}

export const prisma = makeProxy([]) as PrismaClient;

// Called once per authenticated request (lib/asyncHandler.ts) - establishes
// which org every Prisma call made during this request's async continuation
// should be scoped to. A request with no org context (public routes,
// register/login/refresh) never touches this at all, and `prisma` behaves
// exactly as it did before RLS existed.
export function runWithOrgScope<T>(orgId: string, fn: () => T): T {
  return requestOrgId.run(orgId, fn);
}

// index.ts/worker.ts call this on graceful shutdown. `prisma.$disconnect()`
// through the Proxy above would only ever reach `basePrisma` - outside a
// request/transaction context, `invoke()`'s `$disconnect` call falls through
// to `resolveOnClient(basePrisma, ...)` the same way any other unscoped
// top-level call does, since there's no `requestOrgId` to resolve it against
// `scopedPrisma` instead. That left `scopedPrisma`'s connection pool (every
// authenticated request's actual RLS-scoped connection to `ats_app`) to be
// torn down only by the process exiting, rather than a clean disconnect.
export async function disconnectPrisma(): Promise<void> {
  await Promise.all([basePrisma.$disconnect(), scopedPrisma.$disconnect()]);
}
