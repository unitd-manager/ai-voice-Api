import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../../core/config/env.js';

const useS3 = !!(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
const s3 = useS3 ? new S3Client({ region: 'auto', endpoint: env.S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } }) : null;
const safeKey = (k) => { const n = path.posix.normalize(k); if (n.startsWith('..') || path.isAbsolute(n)) throw new Error('Bad storage key'); return n; };

// S3-compatible when configured; local-disk fallback is for development only.
export const storage = {
  driver: useS3 ? 's3' : 'local',
  async put(key, body, contentType) {
    key = safeKey(key);
    if (s3) return void await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
    const f = path.join(env.STORAGE_LOCAL_DIR, key); await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, body);
  },
  async get(key) {
    key = safeKey(key);
    if (s3) return Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))).Body.transformToByteArray());
    return readFile(path.join(env.STORAGE_LOCAL_DIR, key));
  },
  async delete(key) {
    key = safeKey(key);
    if (s3) return void await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    await rm(path.join(env.STORAGE_LOCAL_DIR, key), { force: true });
  },
};
