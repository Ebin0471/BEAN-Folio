/// <reference types="bun-types" />
/**
 * M21 test fixture — a minimal but REAL S3-compatible API server.
 *
 * Implements the exact HTTP surface the backup/restore tooling exercises
 * through the production AWS SDK client (@aws-sdk/client-s3, SigV4 signed,
 * path-style addressing):
 *
 *   GET    /<bucket>?list-type=2&prefix=…&continuation-token=…   ListObjectsV2
 *   GET    /<bucket>/<key>                                       GetObject
 *   HEAD   /<bucket>/<key>                                       HeadObject
 *   PUT    /<bucket>/<key>                                       PutObject
 *
 * This is NOT a mock of the client — the client is the real one; only the
 * server side is a fixture. ListObjectsV2 pagination can be FORCED with
 * `maxKeysPerPage` so the client's ContinuationToken loop is genuinely
 * exercised. Every request is recorded for assertions.
 *
 * Used only by tests — never imported by application code.
 */

export interface S3FixtureRequest {
  method: string;
  path: string;
  bucket: string | null;
  key: string | null;
  query: Record<string, string>;
}

export interface S3Fixture {
  port: number;
  endpoint: string;
  requests: S3FixtureRequest[];
  bucket: Map<string, Buffer>; // live view — tests may inspect/mutate between phases
  puts: Map<string, Buffer>; // every PUT received
  stop: () => void;
}

export interface S3FixtureOptions {
  bucket: string;
  /** Initial objects (key → body). */
  objects?: Record<string, Buffer | string>;
  /** Force ListObjectsV2 pagination (default: unlimited page). */
  maxKeysPerPage?: number;
  /**
   * Optional hook to corrupt GetObject responses (e.g. return a truncated
   * body) — used to verify the backup tool's honest-failure behavior.
   * Return a Buffer to override the served body, or null to serve 404.
   */
  getObjectOverride?: (key: string, body: Buffer) => Buffer | null | undefined;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function startS3CompatServer(opts: S3FixtureOptions): Promise<S3Fixture> {
  const bucketName = opts.bucket;
  const bucket = new Map<string, Buffer>(
    Object.entries(opts.objects ?? {}).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)]),
  );
  const puts = new Map<string, Buffer>();
  const requests: S3FixtureRequest[] = [];
  const maxKeysPerPage = opts.maxKeysPerPage;

  const server = Bun.serve({
    port: 0, // random free port
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));

      // Path-style: /<bucket>[/<key>]
      const parts = url.pathname.replace(/^\/+/, "").split("/");
      const bucketPart = parts[0] ?? "";
      const keyPart = parts.slice(1).join("/");
      const isBucketOp = bucketPart === bucketName && keyPart === "";

      requests.push({
        method,
        path: url.pathname,
        bucket: bucketPart === bucketName ? bucketName : null,
        key: keyPart || null,
        query,
      });

      // ---- ListObjectsV2 ----
      if (method === "GET" && isBucketOp && query["list-type"] === "2") {
        const prefix = query["prefix"] ?? "";
        const all = [...bucket.keys()].filter((k) => k.startsWith(prefix)).sort();
        const perPage = maxKeysPerPage ?? Number(query["max-keys"] ?? 1000);
        const startToken = query["continuation-token"];
        const start = startToken ? Number(startToken) : 0;
        const page = all.slice(start, start + perPage);
        const truncated = start + perPage < all.length;

        const contents = page
          .map(
            (key) => `  <Contents>
    <Key>${xmlEscape(key)}</Key>
    <LastModified>2026-11-14T00:00:00.000Z</LastModified>
    <ETag>&quot;fixture&quot;</ETag>
    <Size>${bucket.get(key)!.length}</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>`,
          )
          .join("\n");
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${xmlEscape(bucketName)}</Name>
  <Prefix>${xmlEscape(prefix)}</Prefix>
  <KeyCount>${page.length}</KeyCount>
  <MaxKeys>${perPage}</MaxKeys>
  <IsTruncated>${truncated}</IsTruncated>
${truncated ? `  <NextContinuationToken>${start + perPage}</NextContinuationToken>\n` : ""}${contents}
</ListBucketResult>`;
        return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
      }

      // ---- GetObject ----
      if (method === "GET" && bucketPart === bucketName && keyPart) {
        const body = bucket.get(keyPart);
        if (!body) {
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>${xmlEscape(keyPart)}</Key></Error>`,
            { status: 404, headers: { "content-type": "application/xml" } },
          );
        }
        const override = opts.getObjectOverride?.(keyPart, body);
        if (override === null) {
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`,
            { status: 404, headers: { "content-type": "application/xml" } },
          );
        }
        const served = override ?? body;
        return new Response(new Uint8Array(served), {
          status: 200,
          headers: { "content-length": String(served.length), "content-type": "application/octet-stream" },
        });
      }

      // ---- HeadObject ----
      if (method === "HEAD" && bucketPart === bucketName && keyPart) {
        const body = bucket.get(keyPart);
        if (!body) return new Response(null, { status: 404 });
        return new Response(null, { status: 200, headers: { "content-length": String(body.length) } });
      }

      // ---- PutObject ----
      if (method === "PUT" && bucketPart === bucketName && keyPart) {
        const body = Buffer.from(await req.arrayBuffer());
        puts.set(keyPart, body);
        bucket.set(keyPart, body);
        return new Response(null, { status: 200, headers: { etag: '"fixture-put"' } });
      }

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NotImplemented</Code><Message>fixture: unhandled ${method} ${url.pathname}</Message></Error>`,
        { status: 501, headers: { "content-type": "application/xml" } },
      );
    },
  });

  return {
    port: server.port ?? 0, // Bun types mark it optional; a bound server always has one
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    bucket,
    puts,
    stop: () => server.stop(true),
  };
}
