/**
 * Local development helper — create the MinIO test bucket used when
 * exercising the S3 media-storage driver on a developer machine.
 *
 * IMPORTANT: the credentials below are DUMMY LOCAL-ONLY credentials for a
 * MinIO instance you start yourself on 127.0.0.1:9000 (e.g. `minio server
 * ./data`). They are NOT production credentials and must never be replaced
 * with real ones. Production media storage is configured exclusively through
 * the S3_* environment variables (see docs/deployment.md).
 *
 * Usage: bun scripts/dev/create-local-test-bucket.ts
 */
import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
const client = new S3Client({ endpoint: "http://127.0.0.1:9000", region: "us-east-1", credentials: { accessKeyId: "bean-test", secretAccessKey: "bean-test-secret" }, forcePathStyle: true });
try { await client.send(new HeadBucketCommand({ Bucket: "bean-media-test" })); console.log("bucket exists"); }
catch {
  await client.send(new CreateBucketCommand({ Bucket: "bean-media-test" }));
  console.log("bucket created");
}
