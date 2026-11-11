import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
const client = new S3Client({ endpoint: "http://127.0.0.1:9000", region: "us-east-1", credentials: { accessKeyId: "bean-test", secretAccessKey: "bean-test-secret" }, forcePathStyle: true });
try { await client.send(new HeadBucketCommand({ Bucket: "bean-media-test" })); console.log("bucket exists"); }
catch {
  await client.send(new CreateBucketCommand({ Bucket: "bean-media-test" }));
  console.log("bucket created");
}
