/**
 * Firebase project config.
 *
 * This is shared across every game in this hub: one Firebase project, one
 * Realtime Database, with each game's online rooms namespaced under
 * `games/<id>/rooms/<code>` (see src/net/rooms.ts) so they don't collide
 * with another game's data in the same database. The client config below is
 * not a secret — Firebase's security model is enforced by the database's
 * security rules, not by hiding this object — so it is safe to check in.
 *
 * If this project is ever replaced, paste the new config object here —
 * Firebase console → Project settings → General → Your apps → SDK setup
 * and configuration → Config — and online play works with no other
 * changes. src/net/firebase.ts throws a clear error instead of silently
 * connecting to nothing if this is ever emptied out.
 */
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyByKyy7PYBIMi2K1jxH6KmzfWbE2_SsB5A",
  authDomain: "deadline-38cdb.firebaseapp.com",
  databaseURL: "https://deadline-38cdb-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "deadline-38cdb",
  storageBucket: "deadline-38cdb.firebasestorage.app",
  messagingSenderId: "768255871086",
  appId: "1:768255871086:web:ad7713b5a3b8e01f9cbe7f",
};
