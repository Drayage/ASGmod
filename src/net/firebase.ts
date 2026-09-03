import { type FirebaseApp, getApps, initializeApp } from "firebase/app";
import { type Database, getDatabase } from "firebase/database";
import { FIREBASE_CONFIG } from "./firebaseConfig";

let cachedApp: FirebaseApp | null = null;
let cachedDb: Database | null = null;

function isConfigured(): boolean {
  return Object.keys(FIREBASE_CONFIG).length > 0;
}

/**
 * Lazily initialises (and reuses) the shared Firebase app + Realtime
 * Database instance. Throws a clear, Korean, in-game-readable error instead
 * of connecting to nothing when `firebaseConfig.ts` still holds the
 * placeholder empty object — every online-mode call site should let this
 * error surface to the player rather than swallow it.
 */
export function getDb(): Database {
  if (!isConfigured()) {
    throw new Error(
      "온라인 대전을 사용하려면 Firebase 설정이 필요합니다. 관리자에게 문의해 주세요.",
    );
  }
  if (!cachedDb) {
    cachedApp = getApps()[0] ?? initializeApp(FIREBASE_CONFIG);
    cachedDb = getDatabase(cachedApp);
  }
  return cachedDb;
}
