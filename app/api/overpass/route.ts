import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

// Diagnostic only, investigating why 504s reproduce for manual testing but not for automated
// browser testing against a long-running dev server: timestamps this route module was loaded
// (proxy for "was this just cold-compiled by Next dev, or has it been warm for a while") and
// when it last handled a request, so a cold/idle hit can be told apart from a warm one.
const MODULE_LOADED_AT = Date.now();
let lastRequestAt: number | null = null;

// Public instances, acceptable for development/early testing (see docs/RouteRider Tire
// Pressure.pdf, Section 41). Not assumed to be permanent production infrastructure. Tried in
// order, sequentially — the mirror is only used after the primary has actually failed, never
// preemptively and never in parallel (that would burn request quota on both at once).
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// One attempt per endpoint. 45s because logs showed the public instances taking up to ~70s to
// respond under load while still answering successfully — a shorter client timeout misreports a
// slow-but-working server as a network failure.
const REQUEST_TIMEOUT_MS = 45000;

// Status-check-confirmed pattern: overpass-api.de (primary) is almost always healthy and fast,
// overpass.kumi.systems (mirror) is almost always heavily overloaded — falling through to the
// mirror on the primary's first hiccup mostly just adds a slow, likely-to-also-fail detour. A
// same-endpoint retry on the primary catches a one-off 5xx blip without paying that cost.
const PRIMARY_RETRY_DELAY_MS = 3000;

// 429 means the per-IP concurrent slots are used up and the server wants a cool-down (Overpass
// fair-use docs), not that it is broken — so it gets its own, much longer backoff on the primary
// instead of an immediate detour to the usually-overloaded mirror.
const RATE_LIMIT_RETRY_DELAY_MS = 18000;

// Exact-query cache: successful responses, keyed by the Overpass query we actually generate (not
// the raw GPX), kept for as long as this route module lives (until the dev server restarts or
// recompiles it). The same route uploaded twice produces the same query and is answered from
// here instead of hitting the public instance again. Errors are never cached. Capped so a
// long-running server can't grow it without bound; oldest entry goes first.
const RESPONSE_CACHE_MAX_ENTRIES = 200;
const responseCache = new Map<string, unknown>();

/**
 * Whitespace-normalized query, hashed. The query itself is built deterministically from the
 * chunk's points and radius, so identical input always yields the same key; hashing just keeps
 * keys short instead of holding multi-KB query strings as Map keys.
 */
function cacheKey(query: string): string {
  const normalized = query.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

function cacheResponse(key: string, data: unknown): void {
  responseCache.set(key, data);
  if (responseCache.size > RESPONSE_CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey !== undefined) responseCache.delete(oldestKey);
  }
}

// Tags passed on to the client — what D7 surface inference and matching need (Build Guide,
// Phase 3, "Finale v0.1-Spezifikation"). Overpass's `out geom` always returns every tag, so the
// rest is dropped here, before caching and sending. Which *ways* are fetched is unaffected: the
// query still selects every way[highway], without excluding any highway value.
const RELEVANT_TAGS = [
  "highway",
  "surface",
  "tracktype",
  "smoothness",
  "bicycle",
  "cycleway",
  "mtb:scale",
];

function keepRelevantTags(data: unknown): unknown {
  const elements = (data as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(elements)) return data;

  return {
    ...(data as object),
    elements: elements.map((el: { tags?: Record<string, string> }) => {
      if (!el.tags) return el;
      const tags: Record<string, string> = {};
      for (const key of RELEVANT_TAGS) {
        if (key in el.tags) tags[key] = el.tags[key];
      }
      return { ...el, tags };
    }),
  };
}

function isRetryableServerError(status: number): boolean {
  return status === 500 || status === 502 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(requestId: string, message: string): void {
  console.log(`[overpass ${requestId}] ${new Date().toISOString()} ${message}`);
}

function endpointHost(url: string): string {
  return new URL(url).hostname;
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

interface AroundPoint {
  lat: number;
  lon: number;
}

function isValidPoint(p: unknown): p is AroundPoint {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof (p as AroundPoint).lat === "number" &&
    typeof (p as AroundPoint).lon === "number" &&
    Number.isFinite((p as AroundPoint).lat) &&
    Number.isFinite((p as AroundPoint).lon)
  );
}

export async function POST(request: Request) {
  const requestId = Math.random().toString(36).slice(2, 8);
  const requestStart = Date.now();

  // Diagnostic only, first thing in the handler (before request.json() or anything else that
  // could itself be delayed) — see MODULE_LOADED_AT comment above.
  const sinceModuleLoadMs = requestStart - MODULE_LOADED_AT;
  const sinceLastRequestMs = lastRequestAt === null ? null : requestStart - lastRequestAt;
  log(
    requestId,
    `handler entered: ${sinceModuleLoadMs}ms since this route module was loaded, ` +
      `${sinceLastRequestMs === null ? "no prior request this module instance" : `${sinceLastRequestMs}ms since last request`}`
  );
  lastRequestAt = requestStart;

  const { points, radiusMeters } = await request.json();

  if (!Array.isArray(points) || points.length === 0 || !points.every(isValidPoint)) {
    return NextResponse.json(
      { error: "points must be a non-empty array of { lat, lon }." },
      { status: 400 }
    );
  }

  if (typeof radiusMeters !== "number" || !Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    return NextResponse.json(
      { error: "radiusMeters must be a positive number." },
      { status: 400 }
    );
  }

  // `around` returns only ways within radiusMeters of one of these route points — a narrow
  // corridor — instead of a bounding box, which in dense areas (e.g. Berlin) pulls in huge
  // amounts of irrelevant street data for a route that only passes through a thin sliver of it.
  const coordList = (points as AroundPoint[]).map((p) => `${p.lat},${p.lon}`).join(",");
  const query = `[out:json][timeout:25];way[highway](around:${radiusMeters},${coordList});out geom;`;

  log(
    requestId,
    `new request: ${points.length} points, radius=${radiusMeters}m, query length=${query.length} chars`
  );

  const key = cacheKey(query);
  const cached = responseCache.get(key);
  if (cached !== undefined) {
    log(requestId, `cache hit (key ${key.slice(0, 12)}…, ${responseCache.size} cached queries), no Overpass request sent`);
    return NextResponse.json(cached);
  }

  const errors: EndpointError[] = [];

  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const endpoint = OVERPASS_ENDPOINTS[i];
    const isPrimary = i === 0;

    try {
      const data = await queryEndpointOnce(requestId, endpoint, query);
      log(
        requestId,
        `request succeeded via ${endpointHost(endpoint)} after ${Date.now() - requestStart}ms total`
      );
      cacheResponse(key, data);
      return NextResponse.json(data);
    } catch (err) {
      if (err instanceof EndpointError) errors.push(err);

      // Query too heavy for Overpass's own [timeout:25] budget: no retry on the same endpoint
      // and no mirror attempt — the same query won't get lighter elsewhere. Report straight back
      // so the client halves just this chunk (lib/mapMatching.ts). Load-type failures (429,
      // HTTP 504, client timeouts) keep the retry/fallback path below, since those may pass later.
      if (err instanceof EndpointError && err.queryTimedOut) {
        log(requestId, `${endpointHost(endpoint)} query timed out (remark), skipping retry/mirror so the client can split the chunk`);
        break;
      }

      const isRateLimited = err instanceof EndpointError && err.status === 429;
      const isServerError = err instanceof EndpointError && isRetryableServerError(err.status);

      if (isPrimary && (isRateLimited || isServerError)) {
        const delayMs = isRateLimited ? RATE_LIMIT_RETRY_DELAY_MS : PRIMARY_RETRY_DELAY_MS;
        log(
          requestId,
          isRateLimited
            ? `${endpointHost(endpoint)} rate-limited (429), backing off ${delayMs}ms before retrying same endpoint once`
            : `${endpointHost(endpoint)} returned ${(err as EndpointError).status}, retrying same endpoint once after ${delayMs}ms`
        );
        await sleep(delayMs);

        try {
          const data = await queryEndpointOnce(requestId, endpoint, query);
          log(
            requestId,
            `request succeeded via ${endpointHost(endpoint)} (retry) after ${Date.now() - requestStart}ms total`
          );
          cacheResponse(key, data);
          return NextResponse.json(data);
        } catch (retryErr) {
          if (retryErr instanceof EndpointError) errors.push(retryErr);

          if (retryErr instanceof EndpointError && retryErr.queryTimedOut) {
            log(requestId, `${endpointHost(endpoint)} query timed out (remark) on retry, skipping mirror so the client can split the chunk`);
            break;
          }
        }
      }

      const hasNext = i < OVERPASS_ENDPOINTS.length - 1;
      if (hasNext) {
        log(
          requestId,
          `${endpointHost(endpoint)} failed, trying next endpoint: ${endpointHost(OVERPASS_ENDPOINTS[i + 1])}`
        );
      }
    }
  }

  const totalMs = Date.now() - requestStart;
  const details = errors.map((e) => `${e.host}: ${e.message}`).join(" | ");
  const queryTimedOut = errors.some((e) => e.queryTimedOut);
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

  return NextResponse.json(
    {
      error: `${reason} Tried: ${details || "no endpoint responded"}.`,
      upstreamStatus: errors[0]?.status ?? 502,
      // Lets the client halve just this chunk and retry (lib/mapMatching.ts) instead of giving
      // up on the whole route, when the attempt failed on query weight, not on load.
      queryTimedOut,
    },
    { status: 502 }
  );
}
