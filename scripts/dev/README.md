# BEAN Folio — Local Development Helpers

Small utilities that only make sense on a developer machine (local services,
fixtures, sandboxes). Nothing here runs in CI or production.

| Tool | Purpose |
|---|---|
| `create-local-test-bucket.ts` | Creates the `bean-media-test` bucket on a locally started MinIO (127.0.0.1:9000, dummy credentials) so the S3 media-storage driver can be exercised locally. Production storage never uses this file. |
