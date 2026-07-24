/**
 * Clause-by-clause verification of the game's stated rules. Each `describe`
 * maps to one numbered rule so a failure points straight at the rule it
 * breaks, rather than at an incidental implementation detail.
 */
import { describe, expect, it } from "vitest";
import { findCapturedGroups, getConnectedGroup, getGroupLiberties } from "./groups";
import { applyMove, calculateFinalResult, createInitialState, getLegalMoves, isLegalMove, passTurn } from "./rules";
import { calculateTerritories } from "./territory";
import { BOARD_SIZE, CENTER } from "./types";
import type { Board, GameState } from "./types";

function emptyBoard(): Board {
  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill("EMPTY"));
  board[CENTER][CENTER] = "NEUTRAL";
  return board;
}

/** Builds a state directly from a board diagram, bypassing move ordering. */
function stateFrom(board: Board, overrides: Partial<GameState> = {}): GameState {
  const base = createInitialState();
  return { ...base, board, territories: calculateTerritories(board), ...overrides };
}

describe("규칙 1: 성 배치 & 턴 진행", () => {
  it("빈 칸에 성을 하나 놓을 수 있다", () => {
    const state = createInitialState();
    expect(isLegalMove(state, 0, 0, "A")).toBe(true);
    const next = applyMove(state, 0, 0);
    expect(next.board[0][0]).toBe("PLAYER_A");
    expect(next.currentPlayer).toBe("B");
  });

  it("이미 성이 있는 칸에는 놓을 수 없다", () => {
    let state = createInitialState();
    state = applyMove(state, 0, 0);
    expect(isLegalMove(state, 0, 0, "B")).toBe(false);
  });

  it("패스를 선언하고 턴을 넘길 수 있다", () => {
    const state = createInitialState();
    const next = passTurn(state);
    expect(next.currentPlayer).toBe("B");
    expect(next.consecutivePasses).toBe(1);
    expect(next.winner).toBeNull();
  });
});

describe("규칙 2: 영토", () => {
  it("상하좌우로 빈틈 없이 둘러싸인 영역을 영토로 인정한다", () => {
    const board = emptyBoard();
    // (3,1)을 A의 성 네 개로 상하좌우 포위. 모서리를 피해 배치해야
    // 가장자리를 벽 삼은 다른 칸이 덩달아 영토가 되지 않는다.
    board[2][1] = "PLAYER_A";
    board[4][1] = "PLAYER_A";
    board[3][0] = "PLAYER_A";
    board[3][2] = "PLAYER_A";
    const territories = calculateTerritories(board);
    expect(territories.A).toEqual([{ row: 3, col: 1 }]);
    expect(territories.B).toHaveLength(0);
  });

  it("대각선만 막힌 영역은 영토가 아니다", () => {
    const board = emptyBoard();
    board[0][0] = "PLAYER_A";
    board[2][2] = "PLAYER_A";
    const territories = calculateTerritories(board);
    expect(territories.A).toHaveLength(0);
  });

  it("완성된 영토에는 성을 배치할 수 없다", () => {
    const board = emptyBoard();
    board[2][1] = "PLAYER_A";
    board[4][1] = "PLAYER_A";
    board[3][0] = "PLAYER_A";
    board[3][2] = "PLAYER_A";
    const state = stateFrom(board);
    expect(state.territories.A).toEqual([{ row: 3, col: 1 }]);
    expect(isLegalMove(state, 3, 1, "B")).toBe(false);
    // 원 기획서 기준: 소유자 본인도 자기 영토에 놓을 수 없다.
    expect(isLegalMove(state, 3, 1, "A")).toBe(false);
  });

  it("영역 안에 상대 성이 하나라도 있으면 영토가 아니다", () => {
    const board = emptyBoard();
    // A가 2x1 공간을 감싸지만 그 안에 B의 성이 하나 들어있다
    board[0][0] = "PLAYER_A";
    board[0][2] = "PLAYER_A";
    board[1][0] = "PLAYER_A";
    board[1][2] = "PLAYER_A";
    board[2][0] = "PLAYER_A";
    board[2][1] = "PLAYER_A";
    board[2][2] = "PLAYER_A";
    board[0][1] = "PLAYER_B"; // 상대 성이 경계에 끼어든다
    const territories = calculateTerritories(board);
    expect(territories.A).toHaveLength(0);
    expect(territories.B).toHaveLength(0);
  });

  it("중립 성을 경계로 삼아 영토를 만들 수 있다", () => {
    const board = emptyBoard();
    // (3,4)의 네 이웃 중 (4,4)는 중립 성, 나머지 셋은 A의 성
    board[2][4] = "PLAYER_A";
    board[3][3] = "PLAYER_A";
    board[3][5] = "PLAYER_A";
    const territories = calculateTerritories(board);
    expect(territories.A).toEqual([{ row: 3, col: 4 }]);
  });

  it("보드 가장자리를 경계로 삼아 영토를 만들 수 있다", () => {
    const board = emptyBoard();
    // (0,0) 모서리는 두 변이 벽이므로 성 두 개로 닫힌다
    board[0][1] = "PLAYER_A";
    board[1][0] = "PLAYER_A";
    const territories = calculateTerritories(board);
    expect(territories.A).toEqual([{ row: 0, col: 0 }]);
  });

  it("보드판 변 4개 모두로 둘러싸인 영역은 영토가 아니다", () => {
    const board = emptyBoard();
    // 성 하나만 놓으면 바깥 전체가 하나의 영역이고 네 변에 모두 닿는다
    board[4][0] = "PLAYER_A";
    const territories = calculateTerritories(board);
    expect(territories.A).toHaveLength(0);
    expect(territories.B).toHaveLength(0);
  });
});

describe("규칙 3: 공성", () => {
  it("상대 성을 상하좌우로 빈틈 없이 둘러싸면 즉시 승리한다", () => {
    const board = emptyBoard();
    board[1][1] = "PLAYER_B";
    board[0][1] = "PLAYER_A";
    board[1][0] = "PLAYER_A";
    board[1][2] = "PLAYER_A";
    // 마지막 도망길 (2,1)만 남은 상태
    const state = stateFrom(board, { currentPlayer: "A" });
    expect(getGroupLiberties(board, getConnectedGroup(board, 1, 1)).size).toBe(1);

    const next = applyMove(state, 2, 1);
    expect(next.winner).toBe("A");
    expect(next.winReason).toBe("CAPTURE");
  });

  it("이어진 상대 성 무리는 도망길이 하나라도 남으면 파괴되지 않는다", () => {
    const board = emptyBoard();
    board[1][1] = "PLAYER_B";
    board[1][2] = "PLAYER_B";
    board[0][1] = "PLAYER_A";
    board[0][2] = "PLAYER_A";
    board[1][0] = "PLAYER_A";
    board[2][1] = "PLAYER_A";
    board[2][2] = "PLAYER_A";
    // (1,3)이 아직 열려 있다
    const state = stateFrom(board, { currentPlayer: "A" });
    expect(state.winner).toBeNull();
    const group = getConnectedGroup(board, 1, 1);
    expect(group).toHaveLength(2);
    expect(getGroupLiberties(board, group).size).toBe(1);
  });

  it("한 수로 양쪽이 동시에 포위되면 배치한 쪽이 살고 상대만 파괴된다", () => {
    const board = emptyBoard();
    // A가 (1,0)에 놓으면 A(0,0)과 이어져 무리 {(0,0),(1,0)}가 되는데
    // 그 무리의 도망길이 0이 되고, 동시에 B(2,0)의 도망길도 0이 된다.
    // (1,0)은 A와 B 양쪽에 접하므로 어느 쪽 영토도 아니어서 배치가 막히지 않는다.
    board[0][0] = "PLAYER_A";
    board[3][0] = "PLAYER_A";
    board[2][1] = "PLAYER_A";
    board[0][1] = "PLAYER_B";
    board[1][1] = "PLAYER_B";
    board[2][0] = "PLAYER_B";
    const state = stateFrom(board, { currentPlayer: "A" });

    // 두는 칸이 아직 누구의 영토도 아님을 먼저 확인한다
    expect(state.territories.A).not.toContainEqual({ row: 1, col: 0 });
    expect(state.territories.B).not.toContainEqual({ row: 1, col: 0 });

    expect(isLegalMove(state, 1, 0, "A")).toBe(true);
    const next = applyMove(state, 1, 0);

    // 상대를 잡았으므로, 자기 무리도 도망길을 잃었지만 배치한 A가 승리한다
    expect(getGroupLiberties(next.board, getConnectedGroup(next.board, 0, 0)).size).toBe(0);
    expect(next.winner).toBe("A");
    expect(next.winReason).toBe("CAPTURE");
  });

  it("상대를 잡지 못하면서 자기 성만 고립되는 수는 둘 수 없다", () => {
    const board = emptyBoard();
    // 놓을 칸 (6,3)은 A와 B 양쪽에 접해 있어 어느 쪽 영토도 아니다.
    // (영토로 판정되면 "영토엔 못 놓는다"는 다른 규칙에 막혀서
    //  정작 자살수 판정은 검증되지 않는다.)
    // A(5,3)은 도망길이 (6,3) 하나뿐이라, 거기에 이어 놓으면
    // 무리 {(5,3),(6,3)}의 도망길이 0이 되는데 잡히는 B 무리는 없다.
    board[5][3] = "PLAYER_A";
    board[4][3] = "PLAYER_B";
    board[5][2] = "PLAYER_B";
    board[5][4] = "PLAYER_B";
    board[6][2] = "PLAYER_B";
    board[6][4] = "PLAYER_B";
    board[7][3] = "PLAYER_B";
    const state = stateFrom(board, { currentPlayer: "A" });

    // 전제 확인: (6,3)은 누구의 영토도 아니고, A는 도망길이 하나뿐이다
    expect(state.territories.A).toHaveLength(0);
    expect(state.territories.B).toHaveLength(0);
    expect(getGroupLiberties(board, getConnectedGroup(board, 5, 3))).toEqual(new Set(["6,3"]));
    // 둘러싼 B 무리들은 모두 살아 있으므로 이 수로 잡히지 않는다
    for (const [r, c] of [[4, 3], [5, 2], [7, 3]]) {
      expect(getGroupLiberties(board, getConnectedGroup(board, r, c)).size).toBeGreaterThan(0);
    }

    expect(isLegalMove(state, 6, 3, "A")).toBe(false);
    expect(getLegalMoves(state, "A")).not.toContainEqual({ row: 6, col: 3 });
  });
});

describe("규칙 2/3 경계 사례", () => {
  it("세로 벽으로 판이 둘로 갈리면 양쪽 다 그 색의 영토가 된다", () => {
    const board = emptyBoard();
    for (let row = 0; row < BOARD_SIZE; row++) board[row][3] = "PLAYER_A";

    const territories = calculateTerritories(board);
    // 왼쪽(27칸)은 위·아래·왼쪽 3개 변에, 오른쪽(급식소 제외 44칸)은
    // 위·아래·오른쪽 3개 변에 닿는다. 규칙이 배제하는 것은 "네 변 모두"뿐이라
    // 두 영역 모두 영토로 인정된다.
    expect(territories.A).toHaveLength(71);
    expect(territories.B).toHaveLength(0);
    expect(territories.A).toContainEqual({ row: 0, col: 0 });
    expect(territories.A).toContainEqual({ row: 8, col: 8 });
    // 급식소 자체는 빈칸이 아니므로 누구의 영토도 아니다
    expect(territories.A).not.toContainEqual({ row: CENTER, col: CENTER });
  });

  it("가로 벽으로 판이 둘로 갈려도 마찬가지다", () => {
    const board = emptyBoard();
    for (let col = 0; col < BOARD_SIZE; col++) board[3][col] = "PLAYER_B";

    const territories = calculateTerritories(board);
    expect(territories.B).toHaveLength(71);
    expect(territories.A).toHaveLength(0);
  });

  it("3개 변과 함께 둘러싼 외곽 공간은 영토지만, 네 변 모두면 아니다", () => {
    // 3개 변: 위·아래를 잇는 벽의 왼쪽 공간은 위/아래/왼쪽에만 닿는다
    const threeSides = emptyBoard();
    for (let row = 0; row < BOARD_SIZE; row++) threeSides[row][2] = "PLAYER_A";
    const left = calculateTerritories(threeSides).A.filter((c) => c.col < 2);
    expect(left).toHaveLength(18);

    // 네 변: 성 하나로는 바깥 공간이 네 변에 모두 닿아 영토가 되지 않는다
    const fourSides = emptyBoard();
    fourSides[4][0] = "PLAYER_A";
    expect(calculateTerritories(fourSides).A).toHaveLength(0);
  });

  it("확정된 영토에 접한 성은 그 영토 때문에 포위되지 않는다", () => {
    const board = emptyBoard();
    // A가 (0,0) 모서리를 막아 영토로 만든다
    board[0][1] = "PLAYER_A";
    board[1][0] = "PLAYER_A";
    // B가 A(0,1)의 바깥쪽 도망길을 전부 메운다
    board[0][2] = "PLAYER_B";
    board[1][1] = "PLAYER_B";

    const territories = calculateTerritories(board);
    expect(territories.A).toContainEqual({ row: 0, col: 0 });

    // 남은 도망길은 자기 영토 (0,0) 하나뿐이지만, 빈칸인 이상 포위가 아니다
    const group = getConnectedGroup(board, 0, 1);
    expect(getGroupLiberties(board, group)).toEqual(new Set(["0,0"]));
    expect(findCapturedGroups(board, "A")).toHaveLength(0);

    // 그리고 그 칸에는 아무도 놓을 수 없으므로 이 성은 잡히지 않는다
    const state = stateFrom(board, { currentPlayer: "B" });
    expect(isLegalMove(state, 0, 0, "B")).toBe(false);
    expect(isLegalMove(state, 0, 0, "A")).toBe(false);
  });
});

describe("규칙 4: 게임 종료 & 승리 조건", () => {
  it("두 플레이어가 연속으로 패스하면 게임이 종료된다", () => {
    let state = createInitialState();
    state = passTurn(state);
    expect(state.winner).toBeNull();
    state = passTurn(state);
    expect(state.winner).not.toBeNull();
    expect(state.winReason).toBe("TERRITORY");
  });

  it("한 명만 패스하고 상대가 성을 놓으면 종료되지 않는다", () => {
    let state = createInitialState();
    state = passTurn(state);
    state = applyMove(state, 0, 0);
    expect(state.consecutivePasses).toBe(0);
    state = passTurn(state);
    expect(state.winner).toBeNull();
  });

  it("선공은 후공보다 영토가 3 이상 많아야 승리한다", () => {
    const base = createInitialState();
    const withTerritory = (a: number, b: number): GameState => ({
      ...base,
      territories: {
        A: Array.from({ length: a }, (_, i) => ({ row: 0, col: i })),
        B: Array.from({ length: b }, (_, i) => ({ row: 1, col: i })),
      },
    });

    expect(calculateFinalResult(withTerritory(10, 7)).winner).toBe("A"); // +3
    expect(calculateFinalResult(withTerritory(12, 9)).winner).toBe("A"); // +3
    expect(calculateFinalResult(withTerritory(9, 7)).winner).toBe("B"); // +2 뿐
    expect(calculateFinalResult(withTerritory(8, 8)).winner).toBe("B"); // 동점
    expect(calculateFinalResult(withTerritory(0, 0)).winner).toBe("B"); // 무영토
  });

  it("공성이 성립하면 패스 여부와 무관하게 즉시 종료된다", () => {
    const board = emptyBoard();
    board[1][1] = "PLAYER_B";
    board[0][1] = "PLAYER_A";
    board[1][0] = "PLAYER_A";
    board[1][2] = "PLAYER_A";
    let state = stateFrom(board, { currentPlayer: "A", consecutivePasses: 1 });
    state = applyMove(state, 2, 1);
    expect(state.winner).toBe("A");
    expect(state.winReason).toBe("CAPTURE");
  });
});
