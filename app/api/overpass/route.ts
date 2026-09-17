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
    message: string
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
    throw new EndpointError(host, 504, `Overpass query did not complete: ${remark}`);
  }

  log(requestId, `← ${host} status=${response.status} (${durationMs}ms) OK`);
  return data;
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
      return NextResponse.json(data);
    } catch (err) {
      if (err instanceof EndpointError) errors.push(err);

      if (isPrimary && err instanceof EndpointError && isRetryableServerError(err.status)) {
        log(
          requestId,
          `${endpointHost(endpoint)} returned ${err.status}, retrying same endpoint once after ${PRIMARY_RETRY_DELAY_MS}ms`
        );
        await sleep(PRIMARY_RETRY_DELAY_MS);

        try {
          const data = await queryEndpointOnce(requestId, endpoint, query);
          log(
            requestId,
            `request succeeded via ${endpointHost(endpoint)} (retry) after ${Date.now() - requestStart}ms total`
          );
          return NextResponse.json(data);
        } catch (retryErr) {
          if (retryErr instanceof EndpointError) errors.push(retryErr);
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
  log(requestId, `request failed after ${totalMs}ms, all ${OVERPASS_ENDPOINTS.length} endpoints failed: ${details}`);

  const worstStatus = errors.find((e) => e.status === 429 || e.status === 504)?.status;
  const reason =
    worstStatus === 429
      ? "Overpass rate-limits requests (429 Too Many Requests)."
      : worstStatus === 504
        ? "Overpass timed out under load (504 Gateway Timeout)."
        : "All Overpass endpoints failed or timed out.";

  return NextResponse.json(
    {
      error: `${reason} Tried: ${details || "no endpoint responded"}.`,
      upstreamStatus: errors[0]?.status ?? 502,
    },
    { status: 502 }
  );
}
