import { createHash } from "node:crypto";

import { getFirebaseCredentials, getGoogleAccessToken } from "./google-service-account";

export type FcmDevice = {
  id: string;
  token: string;
  userId: string;
  deviceId?: string;
  appName?: string;
};

type FirestoreDocument = {
  name?: string;
  fields?: Record<string, { stringValue?: string }>;
};

const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";

function documentIdForToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function fieldString(doc: FirestoreDocument, key: string): string {
  return doc.fields?.[key]?.stringValue?.trim() || "";
}

function baseUrl(projectId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}

async function firestoreRequest(path: string, init?: RequestInit): Promise<Response> {
  const credentials = getFirebaseCredentials();
  if (!credentials) {
    throw new Error("Firebase 未配置：缺少 FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY。");
  }
  const accessToken = await getGoogleAccessToken(credentials, [FIRESTORE_SCOPE]);
  return fetch(`${baseUrl(credentials.projectId)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
}

export async function upsertFcmDevice(input: {
  token: string;
  userId: string;
  deviceId?: string;
  appName?: string;
}): Promise<FcmDevice> {
  const id = documentIdForToken(input.token);
  const response = await firestoreRequest(`/fcm_devices/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      fields: {
        token: { stringValue: input.token },
        userId: { stringValue: input.userId },
        deviceId: { stringValue: input.deviceId || "" },
        appName: { stringValue: input.appName || "" },
        updatedAt: { stringValue: new Date().toISOString() },
      },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Firestore ${response.status}: ${JSON.stringify(payload).slice(0, 600)}`);
  }
  return { id, ...input };
}

export async function listFcmDevices(userId: string): Promise<FcmDevice[]> {
  const response = await firestoreRequest(`/fcm_devices?pageSize=100`, { method: "GET" });
  const payload = await response.json().catch(() => ({})) as { documents?: FirestoreDocument[] };
  if (!response.ok) {
    throw new Error(`Firestore ${response.status}: ${JSON.stringify(payload).slice(0, 600)}`);
  }

  return (payload.documents || []).map((doc) => {
    const id = doc.name?.split("/").pop() || "";
    return {
      id,
      token: fieldString(doc, "token"),
      userId: fieldString(doc, "userId"),
      deviceId: fieldString(doc, "deviceId") || undefined,
      appName: fieldString(doc, "appName") || undefined,
    };
  }).filter((device) => device.id && device.token && device.userId === userId);
}

export async function deleteFcmDevice(id: string): Promise<void> {
  if (!id) return;
  const response = await firestoreRequest(`/fcm_devices/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (response.ok || response.status === 404) return;
  const payload = await response.text().catch(() => "");
  throw new Error(`Firestore ${response.status}: ${payload.slice(0, 600)}`);
}
