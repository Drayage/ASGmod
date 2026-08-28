import { createRoom, joinRoom, sendMove, subscribeRoom, type RoomSnapshot, type Side } from "../../../net/rooms";
import type { Move, Player } from "../types";

/**
 * Namespaces this game's online rooms under the shared Firebase project —
 * this is the repo id, not the game id, per the cross-repo convention that
 * every "abstract games" sibling gets its own `games/<repo-id>/rooms/`
 * subtree so room codes never collide between games.
 */
const GAME_ID = "asgmod";

// The room host always plays the first-moving side (cheese cat / A); the
// player who joins with a code always plays second (mackerel cat / B). The
// simplest possible seat assignment for a 2-seat room, and it matches how
// "내 무리" already reads at mode-select time.
const SIDE_TO_PLAYER: Record<Side, Player> = { host: "A", guest: "B" };

export interface OnlineSession {
  code: string;
  humanSide: Player;
}

export async function hostOnlineRoom(): Promise<OnlineSession> {
  const { code, side } = await createRoom(GAME_ID);
  return { code, humanSide: SIDE_TO_PLAYER[side] };
}

export async function joinOnlineRoom(code: string): Promise<OnlineSession> {
  const { code: joinedCode, side } = await joinRoom(GAME_ID, code);
  return { code: joinedCode, humanSide: SIDE_TO_PLAYER[side] };
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
 * generic host/guest presence into a single "is my opponent connected"
 * flag. Returns an unsubscribe function. */
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
