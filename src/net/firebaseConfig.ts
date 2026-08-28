/**
 * Firebase project config.
 *
 * This is shared across all "abstract games" sibling repos: one Firebase
 * project, one Realtime Database, with each game's online rooms namespaced
 * under `games/<repo-id>/rooms/<code>` (see src/net/rooms.ts) so they never
 * collide with another game's data in the same database.
 *
 * No real project has been created yet. Paste the real config object here
 * — Firebase console → Project settings → General → Your apps → SDK setup
 * and configuration → Config — and online play works with no other changes.
 * Until then this stays an empty object on purpose (never fabricate keys),
 * and src/net/firebase.ts throws a clear error the moment anything tries to
 * use the database instead of silently connecting to nothing.
 */
export const FIREBASE_CONFIG = {
  // apiKey: "",
  // authDomain: "",
  // databaseURL: "",
  // projectId: "",
  // storageBucket: "",
  // messagingSenderId: "",
  // appId: "",
};
