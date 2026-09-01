// Shared between index.ts (which flips this the instant SIGTERM/SIGINT
// arrives) and app.ts's /ready handler. Separating "shutting down" from
// "drained" matters: a load balancer or k8s readiness probe should stop
// routing new traffic the moment shutdown begins, not only once the process
// actually exits - otherwise every request that lands during the drain
// window is one the LB thought was going to a healthy instance.
let shuttingDown = false;

export function markShuttingDown() {
  shuttingDown = true;
}

export function isShuttingDown() {
  return shuttingDown;
}
