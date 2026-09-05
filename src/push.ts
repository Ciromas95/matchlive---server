import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

let enabled = false;

function configuredCredential() {
  for (const rawValue of [
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    process.env.FIREBASE_KEY,
  ]) {
    const raw = rawValue?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.project_id && parsed?.client_email && parsed?.private_key) {
        return cert(parsed);
      }
    } catch {
      // Continue: Railway may still contain an obsolete malformed variable.
    }
  }
  return applicationDefault();
}

try {
  if (!getApps().length) {
    initializeApp({ credential: configuredCredential() });
  }
  enabled = true;
  console.info("[push] Firebase Admin attivo");
} catch (error: any) {
  console.warn("[push] Firebase Admin non configurato:", error?.message ?? error);
}

export function pushEnabled() {
  return enabled;
}

/** Notifica manuale protetta: usata soltanto dal pannello amministratore. */
export async function sendAdminPushTest() {
  if (!enabled) return false;
  try {
    await getMessaging().send({
      topic: "brainlive_admin_push_test",
      notification: {
        title: "BrainLive è collegata",
        body: "Le notifiche push funzionano correttamente.",
      },
      data: { type: "admin_push_test" },
      apns: {
        payload: { aps: { sound: "default" } },
        headers: { "apns-priority": "10" },
      },
    });
    return true;
  } catch (error: any) {
    console.error("[push] invio test amministratore non riuscito:", error?.message ?? error);
    return false;
  }
}

export async function sendBrainLivePush(
  fixtureId: number,
  homeName: string,
  awayName: string,
) {
  if (!enabled) return;
  try {
    await getMessaging().send({
      topic: "brainlive_brain_live",
      notification: {
        title: "Il Cervello ha trovato un match LIVE",
        body: `${homeName} – ${awayName}`,
      },
      data: { fixtureId: String(fixtureId), type: "brain_live_found" },
      android: {
        priority: "high",
        notification: { channelId: "brainlive_match_events", sound: "default" },
      },
      apns: {
        payload: { aps: { sound: "default" } },
        headers: { "apns-priority": "10" },
      },
    });
  } catch (error: any) {
    console.error("[push] invio Cervello Live fallito:", error?.message ?? error);
  }
}

export async function sendBrainPrematchPush(count: number) {
  if (!enabled || count <= 0) return;
  try {
    await getMessaging().send({
      topic: "brainlive_brain_prematch",
      notification: {
        title: "Il Cervello ha completato le analisi",
        body: count === 1
          ? "È disponibile un nuovo pronostico pre-match."
          : `Sono disponibili ${count} nuovi pronostici pre-match.`,
      },
      data: { type: "brain_prematch_found", destination: "home" },
      android: {
        priority: "high",
        notification: { channelId: "brainlive_match_events", sound: "default" },
      },
      apns: {
        payload: { aps: { sound: "default" } },
        headers: { "apns-priority": "10" },
      },
    });
  } catch (error: any) {
    console.error("[push] invio Cervello Prematch fallito:", error?.message ?? error);
  }
}

export async function sendFixturePush(
  fixtureId: number,
  type: "kickoff" | "finished" | "red" | "goal",
  title: string,
  body: string,
  extra: Record<string, string> = {},
) {
  if (!enabled) return;
  const topic = `brainlive_fixture_${fixtureId}_${type}`;
  const imageUrl = extra.imageUrl?.trim();
  const richImage = extra.matchupImageUrl?.trim() || imageUrl;
  try {
    await getMessaging().send({
      topic,
      notification: { title, body },
      data: { fixtureId: String(fixtureId), type, ...extra },
      android: {
        priority: "high",
        notification: {
          channelId: "brainlive_match_events",
          sound: "default",
          ...(richImage ? { imageUrl: richImage } : {}),
        },
      },
      apns: {
        payload: { aps: { sound: "default", mutableContent: Boolean(richImage || extra.homeLogo || extra.awayLogo) } },
        headers: { "apns-priority": "10" },
        ...(richImage ? { fcmOptions: { imageUrl: richImage } } : {}),
      },
    });
  } catch (error: any) {
    console.error(`[push] invio ${topic} fallito:`, error?.message ?? error);
  }
}
