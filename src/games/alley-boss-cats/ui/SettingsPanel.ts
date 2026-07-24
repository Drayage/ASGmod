import { setMusicEnabled, setSoundEnabled } from "../sound";
import { loadSettings, saveSettings } from "../storage";

export function renderSettingsPanel(host: HTMLElement): void {
  const overlay = document.createElement("div");
  overlay.className = "abc-overlay";

  const card = document.createElement("div");
  card.className = "abc-modal abc-settings";
  card.innerHTML = `<h2>설정</h2>`;

  const settings = loadSettings();

  const soundRow = checkboxRow("효과음", settings.soundEnabled, (checked) => {
    const next = { ...loadSettings(), soundEnabled: checked };
    saveSettings(next);
    setSoundEnabled(checked);
  });
  card.appendChild(soundRow);

  const musicRow = checkboxRow("배경음악", settings.musicEnabled, (checked) => {
    const next = { ...loadSettings(), musicEnabled: checked };
    saveSettings(next);
    setMusicEnabled(checked);
  });
  card.appendChild(musicRow);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "닫기";
  closeBtn.addEventListener("click", () => overlay.remove());
  card.appendChild(closeBtn);

  overlay.appendChild(card);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  host.appendChild(overlay);
}

function checkboxRow(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLLabelElement {
  const row = document.createElement("label");
  row.className = "abc-settings-row";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  row.appendChild(input);
  row.appendChild(document.createTextNode(label));
  return row;
}
