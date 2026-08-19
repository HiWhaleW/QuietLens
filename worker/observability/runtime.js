const ALLOWED_SEVERITIES = new Set(["info", "warn", "error"]);

export async function emitOperationalEvent(env, {
  severity = "info",
  code,
  requestId = null,
  route = null,
  status = null,
}) {
  const event = {
    type: "quietlens_operational",
    severity: ALLOWED_SEVERITIES.has(severity) ? severity : "error",
    code,
    request_id: requestId,
    route,
    status,
    server_at: new Date().toISOString(),
  };
  const logger = event.severity === "error" ? console.error : event.severity === "warn" ? console.warn : console.log;
  logger(JSON.stringify(event));
  if (event.severity === "error" && env.QUIETLENS_ALERT_SINK?.write) {
    try {
      await env.QUIETLENS_ALERT_SINK.write(event);
    } catch {
      console.error(JSON.stringify({
        type: "quietlens_operational",
        severity: "error",
        code: "ALERT_DELIVERY_FAILED",
        request_id: requestId,
        server_at: new Date().toISOString(),
      }));
    }
  }
}
