// Overpass provider: the multi-mirror failover from Build Guide "Overpass-Resilienz", Stufe 1
// (Commit 4), moved here unchanged from app/api/overpass/route.ts in 5a. Only reached through
// fetchWaysAlongRoute (lib/osm/fetchWaysAlongRoute.ts).
import { endpointHost, keepRelevantTags, log, sleep, type LatLon, type WaysResult } from "./shared";

// Public instances, acceptable for development/early testing (see docs/RouteRider Tire
// Pressure.pdf, Section 41). Not assumed to be permanent production infrastructure. Tried in
// priority order, sequentially — a mirror is only used after the endpoint before it has actually
// failed, never preemptively and never in parallel (that would burn request quota on several at
// once). Overridable via OVERPASS_ENDPOINTS (comma-separated, priority order; see .env.example).
// The first configured endpoint is the "primary": only it gets the same-endpoint retries below.
const DEFAULT_OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function resolveEndpoints(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return DEFAULT_OVERPASS_ENDPOINTS;

  const valid: string[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      console.log(`[overpass] OVERPASS_ENDPOINTS: ignoring invalid URL "${entry}"`);
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      console.log(`[overpass] OVERPASS_ENDPOINTS: ignoring non-http(s) URL "${entry}"`);
      continue;
    }
    if (!valid.includes(url.href)) valid.push(url.href);
  }

  if (valid.length === 0) {
    console.log("[overpass] OVERPASS_ENDPOINTS contained no valid URL, using defaults");
    return DEFAULT_OVERPASS_ENDPOINTS;
  }
  return valid;
}

const OVERPASS_ENDPOINTS = resolveEndpoints(process.env.OVERPASS_ENDPOINTS);
const PRIMARY_ENDPOINT = OVERPASS_ENDPOINTS[0];
console.log(`[overpass] endpoints (priority order): ${OVERPASS_ENDPOINTS.join(", ")}`);

// An endpoint we just failed over from because of load — 429 (on the primary only after its
// retry also failed), 5xx, network error or client timeout — is moved to the back of the order
// for this long, so the next chunk doesn't start on the server that just struggled. A `remark`
// query timeout does NOT trigger it: that means the query was too heavy, not the server unhealthy. Moved
// back, never excluded: if everything ahead of it fails, it is still tried. In-memory and best
// effort — lost on restart/recompile, and not shared between serverless instances (fine for v0.1).
const ENDPOINT_COOLDOWN_MS = 60_000;
const cooldownUntil = new Map<string, number>();

function isCoolingDown(endpoint: string, now: number): boolean {
  return (cooldownUntil.get(endpoint) ?? 0) > now;
}

/** Configured priority order, with endpoints currently in cool-down moved (stably) to the end. */
function endpointsInTryOrder(now: number): string[] {
  const ready = OVERPASS_ENDPOINTS.filter((e) => !isCoolingDown(e, now));
  const coolingDown = OVERPASS_ENDPOINTS.filter((e) => isCoolingDown(e, now));
  return [...ready, ...coolingDown];
}

/** True when every configured Overpass endpoint is in cool-down — then Postpass is tried first. */
export function allOverpassEndpointsCoolingDown(now: number): boolean {
  return OVERPASS_ENDPOINTS.every((e) => isCoolingDown(e, now));
}

function startCooldown(requestId: string, endpoint: string, reason: string): void {
  cooldownUntil.set(endpoint, Date.now() + ENDPOINT_COOLDOWN_MS);
  log(requestId, `${endpointHost(endpoint)} put in ${ENDPOINT_COOLDOWN_MS / 1000}s cool-down (${reason})`);
}

// One attempt per endpoint. 45s because logs showed the public instances taking up to ~70s to
// respond under load while still answering successfully — a shorter client timeout misreports a
// slow-but-working server as a network failure.
const REQUEST_TIMEOUT_MS = 45000;

// Status-check-confirmed pattern: overpass-api.de (primary) is almost always healthy and fast,
// overpass.kumi.systems (mirror) is almost always heavily overloaded — falling through to the
// mirror on the primary's first hiccup mostly just adds a slow, likely-to-also-fail detour. A
// same-endpoint retry on the primary catches a one-off 500/502/504 blip without paying that cost.
// Mirrors get no same-endpoint retry; 503 and network errors go straight to the next endpoint.
const PRIMARY_RETRY_DELAY_MS = 3000;

// 429 means the per-IP concurrent slots are used up and the server wants a cool-down (Overpass
// fair-use docs), not that it is broken — so it gets its own, much longer backoff on the primary
// instead of an immediate detour to the usually-overloaded mirror. Primary only, and only when it
// isn't already in cool-down (then it was just rate-limited and waiting again is unlikely to help).
const RATE_LIMIT_RETRY_DELAY_MS = 18000;

// Worst case for one request: every endpoint runs into REQUEST_TIMEOUT_MS, plus the primary's
// backoff and retry — well over 2 minutes with 3 endpoints. Fine locally; before deploying to
// Vercel, this route's maxDuration has to be checked (Build Guide, "Overpass-Resilienz").

function isRetryableServerError(status: number): boolean {
  return status === 500 || status === 502 || status === 504;
}

class EndpointError extends Error {
  constructor(
    public host: string,
    public status: number,
    message: string,
    /** Overpass's own query-time budget ran out (the `remark` case) — the query was too heavy. */
    public queryTimedOut = false
  ) {
    super(message);
  }
}

interface ErrorDetails {
  name: string;
  message: string;
  code?: string;
  cause?: string;
}

/** Unwraps the raw error (and any nested `cause`, e.g. undici's connect-error details) for logging. */
function describeError(err: unknown): ErrorDetails {
  if (!(err instanceof Error)) {
    return { name: "UnknownError", message: String(err) };
  }

  const code = (err as NodeJS.ErrnoException).code;
  const cause = (err as { cause?: unknown }).cause;

  let causeStr: string | undefined;
  if (cause instanceof Error) {
    const causeCode = (cause as NodeJS.ErrnoException).code;
    causeStr = `${cause.name}: ${cause.message}${causeCode ? ` (code=${causeCode})` : ""}`;
  } else if (cause !== undefined) {
    try {
      causeStr = JSON.stringify(cause);
    } catch {
      causeStr = String(cause);
    }
  }

  return { name: err.name, message: err.message, code, cause: causeStr };
}

async function queryEndpointOnce(
  requestId: string,
  endpoint: string,
  query: string
): Promise<unknown> {
  const host = endpointHost(endpoint);
  const start = Date.now();
  log(requestId, `→ ${endpoint} started (timeout ${REQUEST_TIMEOUT_MS}ms)`);

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Without an explicit Accept/User-Agent, Overpass servers reject Node's default fetch
        // headers with 406 Not Acceptable.
        Accept: "*/*",
        "User-Agent": "RouteRider/0.1 (dev)",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    const info = describeError(err);
    const isClientTimeout = info.name === "TimeoutError" || info.name === "AbortError";

    if (isClientTimeout) {
      log(
        requestId,
        `← ${host} CLIENT-SIDE TIMEOUT after ${durationMs}ms (limit ${REQUEST_TIMEOUT_MS}ms) — name=${info.name}`
      );
    } else {
      log(
        requestId,
        `← ${host} network error after ${durationMs}ms — name=${info.name} message="${info.message}"` +
          `${info.code ? ` code=${info.code}` : ""}${info.cause ? ` cause=${info.cause}` : ""}`
      );
    }

    throw new EndpointError(
      host,
      0,
      isClientTimeout
        ? `client-side timeout after ${durationMs}ms`
        : `${info.name}: ${info.message}${info.cause ? ` (cause: ${info.cause})` : ""}`
    );
  }

  const durationMs = Date.now() - start;

  if (!response.ok) {
    const body = await response.text();
    // Full body goes to the server console (diagnostics); the thrown message stays short —
    // it ends up in the user-facing error text, where a raw Overpass HTML page isn't useful.
    log(requestId, `← ${host} status=${response.status} (${durationMs}ms) FAILED body="${body.slice(0, 300)}"`);
    throw new EndpointError(host, response.status, `HTTP ${response.status}`);
  }

  let data: unknown;

  try {
    data = await response.json();
  } catch (err) {
    const info = describeError(err);
    log(requestId, `← ${host} status=${response.status} (${durationMs}ms) unparseable body: ${info.message}`);
    throw new EndpointError(host, 502, `Unparseable response: ${info.message}`);
  }

  // Overpass's own [timeout:...] budget inside the query is separate from — and here, much
  // shorter than — our client-side REQUEST_TIMEOUT_MS. When the query itself runs out of time
  // server-side, Overpass still answers HTTP 200 with an empty `elements` array and this
  // `remark` field, rather than a non-2xx status. Left unchecked, that reads as "genuinely no
  // roads found here" — 0 candidate ways, every segment Unmatched, no error shown anywhere —
  // instead of the query having silently failed to run to completion.
  const remark = (data as { remark?: unknown } | null)?.remark;

  if (typeof remark === "string" && remark.length > 0) {
    log(requestId, `← ${host} status=${response.status} (${durationMs}ms) Overpass runtime error: "${remark}"`);
    throw new EndpointError(host, 504, `Overpass query did not complete: ${remark}`, true);
  }

  log(requestId, `← ${host} status=${response.status} (${durationMs}ms) OK`);
  return keepRelevantTags(data);
}

/**
 * The Overpass query for one chunk. Also the source of the exact-query cache key (lib/osm/cache.ts),
 * whichever provider ends up answering.
 */
export function buildOverpassQuery(points: LatLon[], radiusMeters: number): string {
  // `around` returns only ways within radiusMeters of one of these route points — a narrow
  // corridor — instead of a bounding box, which in dense areas (e.g. Berlin) pulls in huge
  // amounts of irrelevant street data for a route that only passes through a thin sliver of it.
  const coordList = points.map((p) => `${p.lat},${p.lon}`).join(",");
  return `[out:json][timeout:25];way[highway](around:${radiusMeters},${coordList});out geom;`;
}

/** Tries the Overpass endpoints sequentially, with the Commit 4 retry/cool-down rules. */
export async function fetchFromOverpass(
  requestId: string,
  requestStart: number,
  query: string
): Promise<WaysResult> {
  const errors: EndpointError[] = [];
  const tryOrder = endpointsInTryOrder(Date.now());
  const coolingDownAtStart = new Set(tryOrder.filter((e) => isCoolingDown(e, Date.now())));
  if (coolingDownAtStart.size > 0) {
    log(
      requestId,
      `in cool-down, moved to the end: ${[...coolingDownAtStart].map(endpointHost).join(", ")} — ` +
        `try order: ${tryOrder.map(endpointHost).join(" → ")}`
    );
  }


  /** Success path: log which host answered after how many failed attempts. */
  const succeed = (endpoint: string, data: unknown, viaRetry: boolean): WaysResult => {
    cooldownUntil.delete(endpoint);
    log(
      requestId,
      `request succeeded via ${endpointHost(endpoint)}${viaRetry ? " (retry)" : ""} after ` +
        `${errors.length} failed attempt(s), ${Date.now() - requestStart}ms total`
    );
    return { ok: true, data, source: endpointHost(endpoint) };
  };

  /**
   * Records a failed attempt. Returns true when the whole request must stop here: a `remark`
   * query timeout means the query is too heavy for Overpass's own [timeout:25] budget, and the
   * same query won't get lighter on another mirror — report straight back so the client halves
   * just this chunk (lib/mapMatching.ts).
   */
  // No cool-down here: a remark timeout says the query was too heavy, not that the server is
  // unhealthy — the halved chunk may go to the same endpoint again right away.
  const recordFailure = (endpoint: string, err: unknown): boolean => {
    if (err instanceof EndpointError) errors.push(err);

    if (err instanceof EndpointError && err.queryTimedOut) {
      log(requestId, `${endpointHost(endpoint)} query timed out (remark), skipping retry/mirrors so the client can split the chunk`);
      return true;
    }
    return false;
  };

  /**
   * Called once we give up on an endpoint for this request (after the primary's retry, if any)
   * and fail over: load-type failures — 429, 5xx, network errors / client timeouts (status 0) —
   * move it to the back of the order for the next requests. Other statuses (e.g. 4xx) don't.
   */
  const cooldownAfterFailover = (endpoint: string, err: unknown) => {
    const status = err instanceof EndpointError ? err.status : 0;
    if (status === 429) startCooldown(requestId, endpoint, "429 rate limit");
    else if (status >= 500) startCooldown(requestId, endpoint, `HTTP ${status}`);
    else if (status === 0) startCooldown(requestId, endpoint, "network error / client timeout");
  };

  let stoppedOnQueryTimeout = false;

  for (let i = 0; i < tryOrder.length && !stoppedOnQueryTimeout; i++) {
    const endpoint = tryOrder[i];
    const isPrimary = endpoint === PRIMARY_ENDPOINT;
    const wasCoolingDown = coolingDownAtStart.has(endpoint);

    try {
      return succeed(endpoint, await queryEndpointOnce(requestId, endpoint, query), false);
    } catch (err) {
      if (recordFailure(endpoint, err)) {
        stoppedOnQueryTimeout = true;
        break;
      }

      let finalErr: unknown = err;
      const status = err instanceof EndpointError ? err.status : 0;
      const retryOnRateLimit = isPrimary && status === 429 && !wasCoolingDown;
      const retryOnServerError = isPrimary && isRetryableServerError(status);

      if (retryOnRateLimit || retryOnServerError) {
        const delayMs = retryOnRateLimit ? RATE_LIMIT_RETRY_DELAY_MS : PRIMARY_RETRY_DELAY_MS;
        log(
          requestId,
          retryOnRateLimit
            ? `${endpointHost(endpoint)} rate-limited (429), backing off ${delayMs}ms before retrying same endpoint once`
            : `${endpointHost(endpoint)} returned ${status}, retrying same endpoint once after ${delayMs}ms`
        );
        await sleep(delayMs);

        try {
          return succeed(endpoint, await queryEndpointOnce(requestId, endpoint, query), true);
        } catch (retryErr) {
          if (recordFailure(endpoint, retryErr)) {
            stoppedOnQueryTimeout = true;
            break;
          }
          finalErr = retryErr;
        }
      } else if (isPrimary && status === 429 && wasCoolingDown) {
        log(requestId, `${endpointHost(endpoint)} rate-limited (429) while already in cool-down, no backoff, moving on`);
      }

      cooldownAfterFailover(endpoint, finalErr);

      const next = tryOrder[i + 1];
      if (next) {
        log(requestId, `${endpointHost(endpoint)} failed, trying next endpoint: ${endpointHost(next)}`);
      }
    }
  }

  const totalMs = Date.now() - requestStart;
  const details = errors.map((e) => `${e.host}: ${e.message}`).join(" | ");
  const queryTimedOut = stoppedOnQueryTimeout;
  log(
    requestId,
    queryTimedOut
      ? `request failed after ${totalMs}ms, query too heavy (remark timeout): ${details}`
      : `request failed after ${totalMs}ms, all ${OVERPASS_ENDPOINTS.length} endpoints failed: ${details}`
  );

  const worstStatus = errors.find((e) => e.status === 429 || e.status === 504)?.status;
  const reason = queryTimedOut
    ? "Overpass query exceeded its own time limit (query too heavy)."
    : worstStatus === 429
      ? "Overpass rate-limits requests (429 Too Many Requests)."
      : worstStatus === 504
        ? "Overpass timed out under load (504 Gateway Timeout)."
        : "All Overpass endpoints failed or timed out.";


  return {
    ok: false,
    error: `${reason} Tried: ${details || "no endpoint responded"}.`,
    upstreamStatus: errors[0]?.status ?? 502,
    queryTimedOut,
    failedAttempts: errors.length,
  };
}
