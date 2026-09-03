import {
  type DatabaseReference,
  get,
  onDisconnect,
  onValue,
  ref,
  runTransaction,
  serverTimestamp,
  set,
} from "firebase/database";
import { getDb } from "./firebase";

/**
 * Generic two-seat online room over Firebase Realtime Database, shared by
 * every game in this hub. A room lives at `games/<gameId>/rooms/<code>` and
 * holds two presence seats ("host" and "guest") plus a move list keyed by
 * turn number. Games with no hidden information and no gameplay RNG (true
 * of every deterministic-reducer game here so far) can relay their whole
 * move list this way and let each client replay it through its own pure
 * rules functions — no server-side game logic needed.
 */

export type Side = "host" | "guest";

export interface PresenceInfo {
  online: boolean;
  /** `serverTimestamp()` sentinel while a write is in flight, a number once
   * it round-trips through the database. */
  lastSeen: number | object;
}

export interface RoomSnapshot<TMove> {
  host: PresenceInfo | null;
  guest: PresenceInfo | null;
  /** Every recorded move, ordered by turn number ascending. */
  moves: TMove[];
}

// Excludes visually ambiguous characters (0/O, 1/I) so a code read aloud or
// hand-copied is not a guessing game.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;
const CODE_COLLISION_RETRIES = 5;

function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function roomPath(gameId: string, code: string): string {
  return `games/${gameId}/rooms/${code}`;
}

function roomRef(gameId: string, code: string): DatabaseReference {
  return ref(getDb(), roomPath(gameId, code));
}

function seatRef(gameId: string, code: string, side: Side): DatabaseReference {
  return ref(getDb(), `${roomPath(gameId, code)}/${side}`);
}

/** Marks this client's seat online now, and — the moment its connection
 * drops, with no further action from this client — offline. This is the
 * whole presence mechanism: the opponent's client learns about a disconnect
 * by watching this field change, not by polling. */
function claimPresence(gameId: string, code: string, side: Side): void {
  const presence = seatRef(gameId, code, side);
  onDisconnect(presence).update({ online: false, lastSeen: serverTimestamp() });
}

/** Creates a fresh room and claims the "host" seat. Retries on the
 * astronomically unlikely event of a code collision with an existing room. */
export async function createRoom(gameId: string): Promise<{ code: string; side: Side }> {
  for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt++) {
    const code = generateRoomCode();
    const existing = await get(roomRef(gameId, code));
    if (existing.exists()) continue;

    await set(roomRef(gameId, code), {
      createdAt: serverTimestamp(),
      host: { online: true, lastSeen: serverTimestamp() },
    });
    claimPresence(gameId, code, "host");
    return { code, side: "host" };
  }
  throw new Error("방을 만들지 못했습니다. 다시 시도해 주세요.");
}

/** Joins an existing room as the "guest" seat. Rejects a code that matches
 * no room, and one whose guest seat is already occupied by someone else who
 * is currently connected — a disconnected former guest's seat is free to
 * reclaim, since nothing here relies on the guest being the same person
 * twice. */
export async function joinRoom(gameId: string, rawCode: string): Promise<{ code: string; side: Side }> {
  const code = rawCode.trim().toUpperCase();
  const snapshot = await get(roomRef(gameId, code));
  if (!snapshot.exists()) {
    throw new Error("방을 찾을 수 없습니다. 코드를 확인해 주세요.");
  }
  const room = snapshot.val() as { guest?: PresenceInfo };
  if (room.guest?.online) {
    throw new Error("이미 상대가 입장한 방입니다.");
  }

  await set(seatRef(gameId, code, "guest"), { online: true, lastSeen: serverTimestamp() });
  claimPresence(gameId, code, "guest");
  return { code, side: "guest" };
}

/**
 * Appends a move, keyed by its own turn number rather than pushed onto a
 * list. A transaction that only writes when that turn's slot is still empty
 * is what makes this safe against double-submission (a retried click, a
 * flaky connection resending the same request) without a separate dedupe
 * pass on read — the second attempt just finds the slot already filled and
 * aborts having changed nothing. Resolves to whether *this* call was the one
 * that committed the move.
 */
export async function sendMove<TMove extends { turn: number }>(
  gameId: string,
  code: string,
  move: TMove,
): Promise<boolean> {
  const moveRef = ref(getDb(), `${roomPath(gameId, code)}/moves/${move.turn}`);
  const result = await runTransaction(moveRef, (current: TMove | null) => {
    if (current !== null) return; // already recorded — abort, leave it untouched
    return move;
  });
  return result.committed;
}

/**
 * Subscribes to a room's full state — its ordered move list and both seats'
 * presence — firing once immediately with whatever is there now and again
 * on every subsequent change. Returns an unsubscribe function.
 */
export function subscribeRoom<TMove>(
  gameId: string,
  code: string,
  onSnapshot: (snapshot: RoomSnapshot<TMove>) => void,
): () => void {
  return onValue(roomRef(gameId, code), (snapshot) => {
    const value = (snapshot.val() ?? {}) as {
      host?: PresenceInfo;
      guest?: PresenceInfo;
      moves?: Record<string, TMove>;
    };
    const movesByTurn = value.moves ?? {};
    const moves = Object.keys(movesByTurn)
      .map(Number)
      .sort((a, b) => a - b)
      .map((turn) => movesByTurn[turn]);
    onSnapshot({ host: value.host ?? null, guest: value.guest ?? null, moves });
  });
}
