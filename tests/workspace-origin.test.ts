import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  candidatePublicHostsFromHeaders,
  resolveShareOriginForRequest,
  resetWorkspaceOriginCacheForTests,
} from "@/lib/workspace-origin";
import { PROOF_NONCE_QUERY } from "./helpers/origin-proof-mock";

/**
 * Tests for the verified workspace-origin layer (lib/workspace-origin):
 * candidate host extraction from edge headers, active origin-proof
 * verification (nonce echo over mocked fetch), kind precedence
 * (production config > workspace host), and negative-result honesty.
 * All network access is mocked — no real fetches happen in tests.
 */

function headersOf(init: Record<string, string>): Headers {
  return new Headers(init);
}

let fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

function mockProofFetch(impl: (url: string) => { status: number; body: unknown } | "network-error") {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    const outcome = impl(url);
    if (outcome === "network-error") throw new TypeError("simulated network failure");
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const VALID_HOST = "ws-abc123.space-z.ai";

function proofBodyFromUrl(url: string, marker = "beanfolio-origin-proof") {
  const nonce = new URL(url).searchParams.get("nonce") ?? "";
  return { status: 200, body: { nonce, marker } };
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.VERCEL_URL;
  resetWorkspaceOriginCacheForTests();
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.VERCEL_URL;
});

describe("candidatePublicHostsFromHeaders", () => {
  test("rejects local, IP-literal and single-label hosts", () => {
    expect(candidatePublicHostsFromHeaders(headersOf({ host: "localhost:3000" }))).toEqual([]);
    expect(candidatePublicHostsFromHeaders(headersOf({ host: "127.0.0.1:3000" }))).toEqual([]);
    expect(candidatePublicHostsFromHeaders(headersOf({ host: "10.0.0.4" }))).toEqual([]);
    expect(candidatePublicHostsFromHeaders(headersOf({ host: "ws-abc" }))).toEqual([]);
    expect(candidatePublicHostsFromHeaders(headersOf({}))).toEqual([]);
  });

  test("rejects internal-suffix and malformed names (minimal fail-closed set)", () => {
    expect(candidatePublicHostsFromHeaders(headersOf({ host: "gw.example.internal" }))).toEqual([]);
    expect(candidatePublicHostsFromHeaders(headersOf({ host: "lan-host.home.arpa" }))).toEqual([]);
    expect(candidatePublicHostsFromHeaders(headersOf({ host: "not a host" }))).toEqual([]);
    expect(candidatePublicHostsFromHeaders(headersOf({ host: "-bad-.example.com" }))).toEqual([]);
  });

  test("does NOT judge by name-shape heuristics — the real edge host passes shape", () => {
    // The actual workspace edge host carries ws-/−vpc labels yet is the
    // address the platform's plumbing uses; shape must not condemn it —
    // the active origin-proof decides.
    expect(
      candidatePublicHostsFromHeaders(headersOf({ host: "ws-ccfae-efeebd-nxnnitkleb.cn-hongkong-vpc.fcapp.run" }))
    ).toEqual(["ws-ccfae-efeebd-nxnnitkleb.cn-hongkong-vpc.fcapp.run"]);
    expect(candidatePublicHostsFromHeaders(headersOf({ host: "ws-1.cn-hongkong-vpc.example" }))).toEqual([
      "ws-1.cn-hongkong-vpc.example",
    ]);
    expect(candidatePublicHostsFromHeaders(headersOf({ host: "preview-gw.example.com" }))).toEqual([
      "preview-gw.example.com",
    ]);
  });

  test("collects edge host, Origin and Referer candidates in order, de-duplicated", () => {
    expect(
      candidatePublicHostsFromHeaders(
        headersOf({
          host: "internal.example:3000",
          origin: "https://silver-fox.space-z.ai",
          referer: "https://silver-fox.space-z.ai/some/path?x=1",
        })
      )
    ).toEqual(["internal.example", "silver-fox.space-z.ai"]);
  });

  test("strips ports and honours x-forwarded-host first-value", () => {
    expect(candidatePublicHostsFromHeaders(headersOf({ host: "example.com:443" }))).toEqual(["example.com"]);
    expect(
      candidatePublicHostsFromHeaders(
        headersOf({ host: "internal:3000", "x-forwarded-host": "a.example.com, b.example.com" })
      )
    ).toEqual(["a.example.com"]);
  });

  test("tolerates garbage Origin/Referer and 'null' origins", () => {
    expect(
      candidatePublicHostsFromHeaders(headersOf({ host: "ok.example", origin: "null", referer: "::::not-a-url" }))
    ).toEqual(["ok.example"]);
  });

  test("allows multi-label delegated ws- hosts (proof decides, not the shape)", () => {
    expect(candidatePublicHostsFromHeaders(headersOf({ host: `${VALID_HOST}:443` }))).toEqual([VALID_HOST]);
  });
});

describe("resolveShareOriginForRequest", () => {
  test("production configuration wins over the workspace host", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://beanfolio.com";
    const r = await resolveShareOriginForRequest(headersOf({ host: VALID_HOST }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("production");
      expect(r.origin).toBe("https://beanfolio.com");
    }
    expect(fetchCalls).toHaveLength(0); // config path needs no proof
  });

  test("invalid configuration is reported verbatim", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://ws-1.cn-hongkong-vpc.example.internal";
    const r = await resolveShareOriginForRequest(headersOf({ host: VALID_HOST }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-config");
  });

  test("no configuration + no candidate → not-configured", async () => {
    const r = await resolveShareOriginForRequest(headersOf({ host: "localhost:3000" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-configured");
    expect(fetchCalls).toHaveLength(0);
  });

  test("proof round trip: nonce echo over the candidate host verifies as workspace", async () => {
    mockProofFetch((url) => proofBodyFromUrl(url));
    const r = await resolveShareOriginForRequest(headersOf({ host: VALID_HOST }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("workspace");
      expect(r.origin).toBe(`https://${VALID_HOST}`);
    }
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain(`https://${VALID_HOST}/api/origin-proof?`);
    expect(fetchCalls[0]).toMatch(PROOF_NONCE_QUERY);
  });

  test("tries the next candidate when the edge host fails proof — Origin wins", async () => {
    mockProofFetch((url) => {
      if (url.includes("edge-unroutable.example")) return { status: 410, body: { error: "Recycled" } };
      return proofBodyFromUrl(url);
    });
    const r = await resolveShareOriginForRequest(
      headersOf({ host: "edge-unroutable.example", origin: `https://${VALID_HOST}` })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("workspace");
      expect(r.origin).toBe(`https://${VALID_HOST}`);
    }
    expect(fetchCalls).toHaveLength(2); // edge host failed, then origin host proved
  });

  test("edge 410 / nonce mismatch / network error / wrong marker → unverified-host", async () => {
    mockProofFetch(() => ({ status: 410, body: { error: "Recycled" } }));
    const recycled = await resolveShareOriginForRequest(headersOf({ host: VALID_HOST }));
    expect(recycled.ok).toBe(false);
    if (!recycled.ok) expect(recycled.reason).toBe("unverified-host");

    resetWorkspaceOriginCacheForTests();
    mockProofFetch((url) => ({ status: 200, body: { nonce: "tampered", marker: "beanfolio-origin-proof" } }));
    const tampered = await resolveShareOriginForRequest(headersOf({ host: VALID_HOST }));
    expect(tampered.ok).toBe(false);

    resetWorkspaceOriginCacheForTests();
    mockProofFetch((url) => proofBodyFromUrl(url, "someone-elses-marker"));
    const foreign = await resolveShareOriginForRequest(headersOf({ host: VALID_HOST }));
    expect(foreign.ok).toBe(false);

    resetWorkspaceOriginCacheForTests();
    mockProofFetch(() => "network-error");
    const offline = await resolveShareOriginForRequest(headersOf({ host: VALID_HOST }));
    expect(offline.ok).toBe(false);
    if (!offline.ok) expect(offline.reason).toBe("unverified-host");
  });

  test("verified origin is cached (no refetch inside TTL); failures are negatively cached", async () => {
    mockProofFetch((url) => proofBodyFromUrl(url));
    const first = await resolveShareOriginForRequest(headersOf({ host: VALID_HOST }));
    expect(first.ok).toBe(true);
    const second = await resolveShareOriginForRequest(headersOf({ host: VALID_HOST }));
    expect(second.ok).toBe(true);
    expect(fetchCalls).toHaveLength(1); // cache hit

    resetWorkspaceOriginCacheForTests();
    mockProofFetch(() => ({ status: 410, body: {} }));
    await resolveShareOriginForRequest(headersOf({ host: VALID_HOST }));
    expect(fetchCalls).toHaveLength(2);
    await resolveShareOriginForRequest(headersOf({ host: VALID_HOST }));
    expect(fetchCalls).toHaveLength(2); // negative cache — no second attempt
  });

  test("concurrent verifications are single-flight per host", async () => {
    mockProofFetch((url) => proofBodyFromUrl(url));
    const [a, b] = await Promise.all([
      resolveShareOriginForRequest(headersOf({ host: VALID_HOST })),
      resolveShareOriginForRequest(headersOf({ host: VALID_HOST })),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(fetchCalls).toHaveLength(1);
  });
});
