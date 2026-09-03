import { get, ref, set, type DatabaseReference } from "firebase/database";
import { getDb } from "../../../net/firebase";
import { createRoom, joinRoom, sendMove, subscribeRoom, type RoomSnapshot, type Side } from "../../../net/rooms";
import { DEFAULT_MAP_ID } from "../maps";
import type { Move, Player } from "../types";

/**
 * Shared repo-wide bucket, matching the id every sibling game in this hub
 * uses (see src/net/rooms.ts) — not a blooming-garden-specific id, so a
 * future second online game in this repo will need its own sub-path under
 * here to avoid room-code collisions with this one.
 */
const GAME_ID = "asgmod";

// The room host always plays the first-moving side (rose / A); the player
// who joins with a code always plays second (hydrangea / B).
const SIDE_TO_PLAYER: Record<Side, Player> = { host: "A", guest: "B" };

export interface OnlineSession {
  code: string;
  humanSide: Player;
  mapId: string;
}

function mapIdRef(code: string): DatabaseReference {
  return ref(getDb(), `games/${GAME_ID}/rooms/${code}/mapId`);
}

/** Creates a room and records which map the host picked, so the guest plays
 * the same board rather than whatever their own (irrelevant, once they join
 * someone else's room) map radio happened to be set to. */
export async function hostOnlineRoom(mapId: string): Promise<OnlineSession> {
  const { code, side } = await createRoom(GAME_ID);
  await set(mapIdRef(code), mapId);
  return { code, humanSide: SIDE_TO_PLAYER[side], mapId };
}

export async function joinOnlineRoom(code: string): Promise<OnlineSession> {
  const { code: joinedCode, side } = await joinRoom(GAME_ID, code);
  const snapshot = await get(mapIdRef(joinedCode));
  const mapId = typeof snapshot.val() === "string" ? (snapshot.val() as string) : DEFAULT_MAP_ID;
  return { code: joinedCode, humanSide: SIDE_TO_PLAYER[side], mapId };
}

/** Relays a locally-confirmed-legal move to the room. Both players — the
 * mover and the opponent — pick it up the same way, through
 * `subscribeOnlineRoom`'s move list, never applied straight from this call. */
export function sendOnlineMove(code: string, move: Move): Promise<boolean> {
  return sendMove(GAME_ID, code, move);
}

export interface OnlineRoomUpdate {
  moves: Move[];
  opponentOnline: boolean;
}

/** Subscribes to a room from `humanSide`'s point of view, translating the
 * generic host/guest presence into a single "is my opponent connected" flag. */
export function subscribeOnlineRoom(
  code: string,
  humanSide: Player,
  onUpdate: (update: OnlineRoomUpdate) => void,
): () => void {
  const opponentSeat: Side = humanSide === "A" ? "guest" : "host";
  return subscribeRoom<Move>(GAME_ID, code, (snapshot: RoomSnapshot<Move>) => {
    onUpdate({
      moves: snapshot.moves,
      opponentOnline: Boolean(snapshot[opponentSeat]?.online),
    });
  });
}
