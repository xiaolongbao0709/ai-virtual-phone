// 兜底预约 payload 的静态加密（含用户 LLM API Key，不能明文落库）。
// AES-256-GCM，密钥由 Supabase service key 派生——Next 路由（加密）和
// Netlify Function（解密）从同一个环境变量各自推导，无需额外配置。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type EncryptedPayload = {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
};

export function derivePushJobKey(serviceKey: string): Buffer {
  return createHash("sha256").update(`${serviceKey}:push-job-v1`).digest();
}

export function encryptPushJobPayload(plainJson: string, serviceKey: string): EncryptedPayload {
  const key = derivePushJobKey(serviceKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plainJson, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function decryptPushJobPayload(payload: EncryptedPayload, serviceKey: string): string {
  const key = derivePushJobKey(serviceKey);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(payload.ct, "base64")), decipher.final()]);
  return plain.toString("utf8");
}
