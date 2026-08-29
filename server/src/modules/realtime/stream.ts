import type { Request, Response } from "express";
import { verifyAccessToken } from "../../lib/jwt.js";
import { subscribeOrgEvents } from "../../lib/pubsub.js";

const HEARTBEAT_MS = 25_000;

// An SSE response never "completes" on its own - the connection is held
// open until the client disconnects. index.ts's graceful shutdown waits for
// exactly that (http.Server.close() only calls back once every connection
// has ended), so without this, shutdown would stall for the full
// SHUTDOWN_TIMEOUT_MS on any single open browser tab rather than draining
// promptly. Tracked here so shutdown can end every open stream up front.
const openConnections = new Set<Response>();

export function closeAllStreams(): void {
  for (const res of openConnections) res.end();
  openConnections.clear();
}

// Server-Sent Events, not WebSockets: one-directional (server -> browser) is
// all the kanban board and notification bell need, and SSE runs over plain
// HTTP - no separate upgrade handshake, no extra library, and it rides the
// same auth/CORS/proxy setup as every other route.
//
// The browser's native EventSource API can't attach an Authorization header,
// so the access token travels as a query parameter on this one GET request
// instead - the same tradeoff any browser-native SSE client faces. It's
// still verified exactly like a bearer token (same secret, same expiry, same
// `type: "access"` check); this endpoint only ever pushes org-scoped event
// *notifications* (ids and types), never sensitive payloads, so a token
// that leaked via a proxy access log here is no more exposed than one that
// leaked via any other query-stringed GET.
export function realtimeStreamHandler(req: Request, res: Response) {
  const token = req.query.token;
  if (typeof token !== "string") {
    res.status(401).type("application/problem+json").json({ type: "unauthorized", title: "Missing token", status: 401 });
    return;
  }

  let auth;
  try {
    auth = verifyAccessToken(token);
  } catch {
    res.status(401).type("application/problem+json").json({ type: "unauthorized", title: "Invalid or expired token", status: 401 });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disables nginx response buffering for SSE, if ever fronted by one
  });
  res.write(":ok\n\n");
  openConnections.add(res);

  const unsubscribe = subscribeOrgEvents(auth.orgId, (event) => {
    // Two kinds of events flow over one org-wide channel: broadcasts
    // (payload has no userId - stage changes, new applications: anything
    // looking at that org's kanban board should react) and per-user ones
    // (notification.created - only the addressed user's bell should react).
    const targetUserId = event.payload.userId;
    if (targetUserId != null && targetUserId !== auth.sub) return;
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
  });

  const heartbeat = setInterval(() => res.write(":hb\n\n"), HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    openConnections.delete(res);
  });
}
