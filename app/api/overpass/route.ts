import { NextResponse } from "next/server";

// Public instance, acceptable for development/early testing (see docs/RouteRider Tire Pressure.pdf, Section 41).
// Not assumed to be permanent production infrastructure.
const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

// The public instance rate-limits (429) or times out under load (504) after just a couple of
// requests in quick succession — retry those with backoff instead of failing the whole match.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: Request) {
  const { south, west, north, east } = await request.json();

  if (
    ![south, west, north, east].every(
      (v) => typeof v === "number" && Number.isFinite(v)
    )
  ) {
    return NextResponse.json(
      { error: "south, west, north, east must be finite numbers." },
      { status: 400 }
    );
  }

  const query = `[out:json][timeout:25];way[highway](${south},${west},${north},${east});out geom;`;

  let lastStatus = 502;
  let lastBody = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(OVERPASS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Without an explicit Accept/User-Agent, the Overpass server rejects Node's default
        // fetch headers with 406 Not Acceptable.
        Accept: "*/*",
        "User-Agent": "RouteRider/0.1 (dev)",
      },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (response.ok) {
      const data = await response.json();
      return NextResponse.json(data);
    }

    lastStatus = response.status;
    lastBody = await response.text();

    const canRetry = RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS;
    if (!canRetry) break;

    const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    await sleep(backoffMs);
  }

  const reason =
    lastStatus === 429
      ? "Overpass rate-limits requests (429 Too Many Requests)."
      : lastStatus === 504
        ? "Overpass timed out under load (504 Gateway Timeout)."
        : `Overpass request failed with status ${lastStatus}.`;

  return NextResponse.json(
    { error: reason, upstreamStatus: lastStatus, upstreamBody: lastBody.slice(0, 500) },
    { status: 502 }
  );
}
