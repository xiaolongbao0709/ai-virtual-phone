import { createSign } from "node:crypto";

export type FirebaseCredentials = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

type CachedToken = {
  value: string;
  expiresAt: number;
};

const cachedTokens = new Map<string, CachedToken>();

function base64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function getFirebaseCredentials(): FirebaseCredentials | null {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

export async function getGoogleAccessToken(
  credentials: FirebaseCredentials,
  scopes: string[],
): Promise<string> {
  const normalizedScopes = [...new Set(scopes)].sort().join(" ");
  const now = Date.now();
  const cached = cachedTokens.get(normalizedScopes);
  if (cached && cached.expiresAt - 60_000 > now) return cached.value;

  const issuedAt = Math.floor(now / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: credentials.clientEmail,
    scope: normalizedScopes,
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsignedJwt = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedJwt);
  signer.end();
  const assertion = `${unsignedJwt}.${base64Url(signer.sign(credentials.privateKey))}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Google OAuth ${response.status}`);
  }

  const token = {
    value: data.access_token,
    expiresAt: now + Math.max(300, Number(data.expires_in) || 3600) * 1000,
  };
  cachedTokens.set(normalizedScopes, token);
  return token.value;
}
