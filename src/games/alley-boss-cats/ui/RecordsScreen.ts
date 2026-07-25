import {
  clearRecords,
  deleteRecord,
  exportRecords,
  importRecords,
  loadRecords,
  type MatchRecord,
} from "../storage";
import type { Player } from "../types";
import { renderReplay } from "./Replay";

const PLAYER_NAME: Record<Player, string> = { A: "치즈냥", B: "고등어냥" };
const DIFFICULTY_NAME: Record<string, string> = {
  EASY: "쉬움",
  NORMAL: "보통",
  HARD: "어려움",
  VERY_HARD: "매우 어려움",
};

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function describeOutcome(record: MatchRecord): string {
  const winner = PLAYER_NAME[record.winner];
  if (record.mode === "LOCAL") {
    return record.winReason === "CAPTURE" ? `${winner} 포위승` : `${winner} 구역승`;
  }
  const won = record.winner === record.playerSide;
  const how = record.winReason === "CAPTURE" ? "포위" : "생활 구역";
  return `${won ? "승리" : "패배"} · ${how} (${winner})`;
}

function describeSetup(record: MatchRecord): string {
  if (record.mode === "LOCAL") return "로컬 2인";
  return `${DIFFICULTY_NAME[record.difficulty] ?? record.difficulty} · 내 무리 ${PLAYER_NAME[record.playerSide]}`;
}

function downloadJson(filename: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking immediately can cancel the download in some browsers; a tick is enough.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderRecords(host: HTMLElement): void {
  const overlay = document.createElement("div");
  overlay.className = "abc-overlay";

  const card = document.createElement("div");
  card.className = "abc-modal abc-records";
  overlay.appendChild(card);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  host.appendChild(overlay);

  let notice = "";

  function setNotice(message: string) {
    notice = message;
    render();
  }

  function render() {
    card.innerHTML = "";

    const title = document.createElement("h2");
    title.textContent = "최근 대국 기록";
    card.appendChild(title);

    const records = loadRecords();

    if (notice) {
      const p = document.createElement("p");
      p.className = "abc-records-notice";
      p.textContent = notice;
      card.appendChild(p);
    }

    if (records.length === 0) {
      const empty = document.createElement("p");
      empty.className = "abc-records-empty";
      empty.textContent = "아직 끝난 대국이 없습니다. 한 판 두고 오면 여기에 쌓입니다.";
      card.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "abc-records-list";
      for (const record of records) list.appendChild(renderRow(record));
      card.appendChild(list);
    }

    card.appendChild(renderActions(records));

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "닫기";
    closeBtn.addEventListener("click", () => overlay.remove());
    card.appendChild(closeBtn);
  }

  function renderRow(record: MatchRecord): HTMLLIElement {
    const row = document.createElement("li");
    row.className = "abc-records-row";

    const info = document.createElement("div");
    info.className = "abc-records-info";
    const placements = record.moveHistory.filter((m) => m.type === "PLACE").length;
    info.innerHTML = `
      <span class="abc-records-outcome">${describeOutcome(record)}</span>
      <span class="abc-records-meta">${formatDate(record.finishedAt)} · ${describeSetup(record)}</span>
      <span class="abc-records-meta">${placements}수 · 생활 구역 ${record.territoryA} : ${record.territoryB}</span>
    `;
    row.appendChild(info);

    const buttons = document.createElement("div");
    buttons.className = "abc-records-row-actions";

    const replayBtn = document.createElement("button");
    replayBtn.type = "button";
    replayBtn.textContent = "기보 보기";
    replayBtn.addEventListener("click", () => renderReplay(document.body, record.moveHistory, () => {}));
    buttons.appendChild(replayBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "삭제";
    deleteBtn.addEventListener("click", () => {
      deleteRecord(record.id);
      setNotice("기록을 삭제했습니다.");
    });
    buttons.appendChild(deleteBtn);

    row.appendChild(buttons);
    return row;
  }

  function renderActions(records: MatchRecord[]): HTMLElement {
    const actions = document.createElement("div");
    actions.className = "abc-records-actions";

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.textContent = "내보내기";
    exportBtn.disabled = records.length === 0;
    exportBtn.addEventListener("click", () => {
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(`골목대냥-기보-${stamp}.json`, exportRecords(records));
      setNotice(`${records.length}판을 파일로 내보냈습니다.`);
    });
    actions.appendChild(exportBtn);

    const importLabel = document.createElement("label");
    importLabel.className = "abc-records-import";
    importLabel.textContent = "불러오기";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/json,.json";
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const outcome = importRecords(await file.text());
        const parts = [`${outcome.added}판을 불러왔습니다`];
        if (outcome.duplicates > 0) parts.push(`이미 있는 ${outcome.duplicates}판은 건너뜀`);
        if (outcome.rejected > 0) parts.push(`읽을 수 없는 항목 ${outcome.rejected}개`);
        setNotice(`${parts.join(" · ")}.`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "불러오기에 실패했습니다.");
      } finally {
        fileInput.value = "";
      }
    });
    importLabel.appendChild(fileInput);
    actions.appendChild(importLabel);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "전체 삭제";
    clearBtn.disabled = records.length === 0;
    clearBtn.addEventListener("click", () => {
      if (!window.confirm(`저장된 기보 ${records.length}판을 모두 지울까요?`)) return;
      clearRecords();
      setNotice("모든 기록을 지웠습니다.");
    });
    actions.appendChild(clearBtn);

    return actions;
  }

  render();
}
