import { setMusicEnabled, setSoundEnabled } from "../sound";
import { loadSettings, saveSettings } from "../storage";

export function renderSettingsPanel(host: HTMLElement): void {
  const overlay = document.createElement("div");
  overlay.className = "grdn-overlay";

  const card = document.createElement("div");
  card.className = "grdn-modal grdn-settings";
  card.innerHTML = `<h2>설정</h2>`;

  const settings = loadSettings();

  const soundRow = checkboxRow("효과음", settings.soundEnabled, (checked) => {
    saveSettings({ ...loadSettings(), soundEnabled: checked });
    setSoundEnabled(checked);
  });
  card.appendChild(soundRow);

  const musicRow = checkboxRow("배경음악", settings.musicEnabled, (checked) => {
    saveSettings({ ...loadSettings(), musicEnabled: checked });
    setMusicEnabled(checked);
  });
  card.appendChild(musicRow);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "grdn-primary-btn";
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
  row.className = "grdn-settings-row";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  row.appendChild(input);
  row.appendChild(document.createTextNode(label));
  return row;
}
