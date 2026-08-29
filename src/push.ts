import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

let enabled = false;

try {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    initializeApp({
      credential: raw ? cert(JSON.parse(raw)) : applicationDefault(),
    });
  }
  enabled = true;
} catch (error: any) {
  console.warn("[push] Firebase Admin non configurato:", error?.message ?? error);
}

export function pushEnabled() {
  return enabled;
}

export async function sendFixturePush(
  fixtureId: number,
  type: "kickoff" | "finished" | "red" | "goal" | "scorer" | "goal_scorer",
  title: string,
  body: string,
  extra: Record<string, string> = {},
) {
  if (!enabled) return;
  const topic = `brainlive_fixture_${fixtureId}_${type}`;
  try {
    await getMessaging().send({
      topic,
      notification: { title, body },
      data: { fixtureId: String(fixtureId), type, ...extra },
      android: {
        priority: "high",
        notification: { channelId: "brainlive_match_events", sound: "default" },
      },
      apns: {
        payload: { aps: { sound: "default", badge: 1 } },
        headers: { "apns-priority": "10" },
      },
    });
  } catch (error: any) {
    console.error(`[push] invio ${topic} fallito:`, error?.message ?? error);
  }
}
