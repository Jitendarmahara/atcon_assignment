import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

// Reconnects periodically, comfortably inside the access token's 15-minute
// TTL (server/.env.example JWT_ACCESS_TTL). The browser's native EventSource
// can't attach an Authorization header or refresh a token mid-stream (see
// modules/realtime/stream.ts), so once the token used to open a connection
// expires, a browser-initiated reconnect attempt gets a 401 and EventSource
// gives up for good - per spec, a non-200 response to a reconnect attempt
// closes it permanently rather than retrying. Tearing down and reopening
// with a fresh token well before that keeps live updates working for a
// whole recruiter session instead of silently going dark partway through one.
const RECONNECT_MS = 10 * 60 * 1000;

// Backs live updates for the kanban board (JobDetail's `["applications",
// jobId]` query) and the notification bell (`["notifications", "unread"]`) -
// see docs/ASSUMPTIONS.md, this used to be poll-only. Mounted once in
// Layout.tsx, which wraps every authenticated route, so one connection
// covers the whole session; TanStack Query's cache is shared app-wide, so
// invalidating here updates whichever page happens to be mounted.
export function useRealtime(enabled: boolean) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    function handleApplicationEvent(e: MessageEvent) {
      try {
        const { jobId } = JSON.parse(e.data as string) as { jobId?: string };
        if (jobId) queryClient.invalidateQueries({ queryKey: ["applications", jobId] });
      } catch {
        /* ignore a malformed event payload - the next poll/action will still catch up */
      }
    }

    function connect() {
      const tokens = api.getTokens();
      if (!tokens?.accessToken) return;

      source = new EventSource(`/api/v1/realtime/stream?token=${encodeURIComponent(tokens.accessToken)}`);
      source.addEventListener("application.created", handleApplicationEvent);
      source.addEventListener("application.stage_changed", handleApplicationEvent);
      source.addEventListener("notification.created", () => {
        queryClient.invalidateQueries({ queryKey: ["notifications", "unread"] });
      });

      reconnectTimer = setTimeout(() => {
        source?.close();
        connect();
      }, RECONNECT_MS);
    }

    connect();

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [enabled, queryClient]);
}
