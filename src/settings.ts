import { invoke, isTauri } from "@tauri-apps/api/core";
import { UI_SCALES, getLanguage, getUiScale, isUiScale, setLanguage, setUiScale, t, watchSettings } from "./i18n";
import type { Language } from "./i18n";
import { icon } from "./icons";
import { AI_PRESETS } from "./ai";
import type { AiSettings } from "./ai";
import "./styles.css";
import "./settings.css";

const app = document.querySelector<HTMLElement>("#app")!;
let saving = false;
let failed = false;
let scaleFailed = false;
let vault: { encrypted: boolean; locked: boolean; lockOnHide: boolean; legacyTemp: boolean } | null = null;
let vaultError = "";
let vaultLoadFailed = false;
let changingPassword = false;
let passwordChanged = false;
let category: "general" | "privacy" | "ai" = "general";
let aiSettings: AiSettings = { ...AI_PRESETS.ollama, apiKey: "" };
let aiPreset: keyof typeof AI_PRESETS = "ollama";
let aiClearKey = false;
let aiLoaded = !isTauri();
let aiStatus = "";
let aiError = false;
let copyingAgentPrompt = false;
let agentCopyStatus = "";
let agentCopyError = false;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
document.body.classList.add("settings-window");

function aiPage(): string {
  return `<section class="settings-section"><h2>${t("ai")}</h2><p class="section-description">${t("aiDescription")} ${t("aiPlanningHint")}</p>
    <div class="settings-card agent-setup"><div class="setting-label">${icon("ai")}<span>${t("agentSetup")}</span></div><p class="setting-description">${t("agentCopyHint")}</p><button class="settings-action" id="copy-agent-prompt" ${copyingAgentPrompt || !isTauri() ? "disabled" : ""}>${t(copyingAgentPrompt ? "agentCopying" : "agentCopyPrompt")}</button><p class="${agentCopyError ? "settings-error" : "settings-success"}" role="status">${escapeHtml(agentCopyStatus)}</p></div>
    ${isTauri() ? `<form id="ai-settings-form" class="settings-card ai-settings-form"><fieldset ${saving || !aiLoaded ? "disabled" : ""}>
    <label>${t("aiPreset")}<select id="ai-preset">${Object.keys(AI_PRESETS).map((key) => `<option value="${key}" ${aiPreset === key ? "selected" : ""}>${key === "custom" ? t("aiCustom") : { ollama: "Ollama (local)", bigmodel: "BigModel", siliconflow: "SiliconFlow", openai: "OpenAI", openrouter: "OpenRouter" }[key]}</option>`).join("")}</select></label>
    <label>${t("aiBaseUrl")}<input id="ai-base-url" type="url" value="${escapeHtml(aiSettings.baseUrl)}" required placeholder="https://example.com/v1" /></label>
    <label>${t("aiModel")}<input id="ai-model" value="${escapeHtml(aiSettings.model)}" required maxlength="200" /></label>
    <label>${t("aiApiKey")}<input id="ai-api-key" type="password" value="${escapeHtml(aiSettings.apiKey)}" autocomplete="off" /></label><p class="setting-hint">${t("aiKeyHint")}</p>
    <label class="setting-checkbox"><input id="ai-clear-key" type="checkbox" ${aiClearKey ? "checked" : ""} /><span>${t("aiClearKey")}</span></label>
    <p class="setting-description">${t("aiPrivacyHint")}</p><div class="password-actions"><button class="settings-action" type="submit">${t("aiSave")}</button><button class="settings-action" type="button" id="ai-test">${t("aiTest")}</button></div>
    </fieldset><p class="${aiError ? "settings-error" : "settings-success"}" role="status">${escapeHtml(aiStatus)}</p></form>` : `<div class="settings-card"><p class="setting-message setting-description">${t("aiDesktopOnly")}</p></div>`}<p class="setting-description">${t("aiCliHint")}</p></section>`;
}

function render() {
  const focused = document.activeElement?.id;
  const scrollTop = document.querySelector<HTMLElement>(".settings-main")?.scrollTop ?? 0;
  document.documentElement.lang = getLanguage();
  document.title = `${t("settings")} · Zen Todo`;
  app.innerHTML = `<div class="settings-layout">
    <div class="settings-drag" aria-label="${t("dragWindow")}" title="${t("dragWindow")}"></div>
    <aside class="settings-sidebar">
      <div class="settings-brand">${icon("settings")}<span>Zen Todo</span></div>
      <nav aria-label="${t("settingsNavigation")}">${(["general", "privacy", "ai"] as const).map((item) => `<button class="settings-category ${category === item ? "is-selected" : ""}" data-category="${item}" ${category === item ? 'aria-current="page"' : ""}>${icon(item)}<span>${t(item)}</span></button>`).join("")}</nav>
      <div class="settings-autosave">${icon("check")}<span>${t("savedAutomatically")}</span></div>
    </aside>
    <button class="settings-close" id="close-settings" title="${t("closeSettings")}" aria-label="${t("closeSettings")}">${icon("close")}</button>
    <section class="settings-main">
      ${category === "ai" ? aiPage() : category === "general" ? `<section class="settings-section" aria-labelledby="general-title"><h2 id="general-title">${t("general")}</h2><p class="section-description">${t("generalDescription")}</p>
        <div class="settings-card"><div class="setting-row"><div class="setting-label">${icon("language")}<label for="language-select">${t("language")}</label></div><select id="language-select" ${saving ? "disabled" : ""}><option value="zh-CN" lang="zh-CN" ${getLanguage() === "zh-CN" ? "selected" : ""}>简体中文</option><option value="en" lang="en" ${getLanguage() === "en" ? "selected" : ""}>English</option></select></div>
          <p class="setting-description">${t("languageDescription")}</p><p class="setting-hint">${t("languageHint")}</p></div>
        <div class="settings-card scale-card"><div class="setting-row"><div class="setting-label"><label for="scale-select">${t("uiScale")}</label></div><select id="scale-select" ${saving ? "disabled" : ""}>${UI_SCALES.map((scale) => `<option value="${scale}" ${getUiScale() === scale ? "selected" : ""}>${scale}%</option>`).join("")}</select></div><p class="setting-description">${t("uiScaleDescription")}</p></div>
      </section><p class="settings-error" role="status">${failed ? t("settingsFailed") : scaleFailed ? t("uiScaleFailed") : ""}</p>` : `<section class="settings-section" aria-labelledby="privacy-title"><h2 id="privacy-title">${t("privacy")}</h2><p class="section-description">${t("privacyDescription")}</p>
        ${isTauri() && vault ? `<div class="settings-card"><div class="setting-label">${icon("privacy")}<span>${t("encryption")}</span></div><p class="setting-description">${t("encryptionDescription")}</p>
          ${vault.encrypted ? `<p class="encryption-status">${icon("check")}${t("encryptionEnabled")}</p><label class="setting-checkbox"><input id="lock-on-hide" type="checkbox" ${vault.lockOnHide ? "checked" : ""} ${saving ? "disabled" : ""}/><span>${t("lockOnHide")}</span></label><p class="setting-hint">${t("lockOnHideHint")}</p>
          ${changingPassword ? `<form id="change-password-form" class="encryption-form"><label>${t("currentPassword")}<input id="current-password" type="password" autocomplete="current-password" required /></label><label>${t("newPassword")}<input id="new-password" type="password" autocomplete="new-password" required /></label><label>${t("confirmNewPassword")}<input id="confirm-new-password" type="password" autocomplete="new-password" required /></label><div class="password-actions"><button type="submit">${t("changePassword")}</button><button type="button" id="cancel-password" class="secondary-button">${t("cancel")}</button></div><p id="password-error" class="settings-error" role="alert"></p></form>` : `<button id="change-password" class="settings-action">${t("changePassword")}</button>${passwordChanged ? `<p class="settings-success" role="status">${t("passwordChanged")}</p>` : ""}`}` : `<form id="encryption-form" class="encryption-form"><label>${t("password")}<input type="password" id="password" autocomplete="new-password" required /></label><label>${t("confirmPassword")}<input type="password" id="confirm-password" autocomplete="new-password" required /></label><button type="submit" ${saving ? "disabled" : ""}>${t("enableEncryption")}</button></form>`}
          ${vault.legacyTemp ? `<p class="settings-error">${t("legacyTempWarning")}</p>` : ""}<p class="settings-error" role="status">${vaultError}</p></div>` : `<div class="settings-card"><p class="setting-description setting-message">${!isTauri() ? t("privacyDesktopOnly") : vaultLoadFailed ? t("privacyLoadFailed") : t("privacyLoading")}</p></div>`}</section>`}
    </section>
  </div>`;
  document.querySelector<HTMLElement>(".settings-drag")!.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !isTauri()) return;
    event.preventDefault();
    void invoke("start_dragging").catch(console.error);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-category]").forEach((button) => button.addEventListener("click", () => {
    if (saving) return;
    category = button.dataset.category === "ai" ? "ai" : button.dataset.category === "privacy" ? "privacy" : "general";
    render();
    document.querySelector<HTMLButtonElement>(`[data-category="${category}"]`)?.focus();
  }));
  document.querySelector<HTMLSelectElement>("#language-select")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value === "en" || value === "zh-CN") void changeLanguage(value);
  });
  document.querySelector("#close-settings")!.addEventListener("click", close);
  document.querySelector<HTMLSelectElement>("#ai-preset")?.addEventListener("change", (event) => {
    const preset = (event.target as HTMLSelectElement).value as keyof typeof AI_PRESETS;
    if (!(preset in AI_PRESETS)) return;
    aiPreset = preset;
    aiSettings = { ...AI_PRESETS[preset], apiKey: "" };
    aiClearKey = true;
    aiStatus = "";
    render();
  });
  for (const [id, field] of [["ai-base-url", "baseUrl"], ["ai-model", "model"], ["ai-api-key", "apiKey"]] as const) {
    document.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener("input", (event) => {
      aiSettings[field] = (event.target as HTMLInputElement).value;
      if (field === "apiKey" && aiSettings.apiKey) { aiClearKey = false; const box = document.querySelector<HTMLInputElement>("#ai-clear-key"); if (box) box.checked = false; }
    });
  }
  document.querySelector<HTMLInputElement>("#ai-clear-key")?.addEventListener("change", (event) => { aiClearKey = (event.target as HTMLInputElement).checked; });
  document.querySelector("#ai-settings-form")?.addEventListener("submit", (event) => { event.preventDefault(); void saveAi(); });
  document.querySelector("#ai-test")?.addEventListener("click", () => { void testAi(); });
  document.querySelector("#copy-agent-prompt")?.addEventListener("click", () => { void copyAgentPrompt(); });
  document.querySelector<HTMLFormElement>("#encryption-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const password = document.querySelector<HTMLInputElement>("#password")!.value;
    const confirm = document.querySelector<HTMLInputElement>("#confirm-password")!.value;
    if (!password || password !== confirm) { vaultError = t("passwordMismatch"); render(); return; }
    void updateVault("enable_encryption", { password });
  });
  document.querySelector<HTMLInputElement>("#lock-on-hide")?.addEventListener("change", (event) => {
    void updateVault("set_lock_on_hide", { value: (event.target as HTMLInputElement).checked });
  });
  document.querySelector<HTMLSelectElement>("#scale-select")?.addEventListener("change", (event) => {
    const value = Number((event.target as HTMLSelectElement).value);
    if (!isUiScale(value)) return;
    try { scaleFailed = false; setUiScale(value); }
    catch (error) { scaleFailed = true; console.error(error); render(); }
  });
  document.querySelector("#change-password")?.addEventListener("click", () => { changingPassword = true; passwordChanged = false; render(); document.querySelector<HTMLInputElement>("#current-password")?.focus(); });
  document.querySelector("#cancel-password")?.addEventListener("click", () => { if (!saving) { changingPassword = false; render(); document.querySelector<HTMLElement>("#change-password")?.focus(); } });
  document.querySelector<HTMLFormElement>("#change-password-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const currentPassword = document.querySelector<HTMLInputElement>("#current-password")!.value;
    const newPassword = document.querySelector<HTMLInputElement>("#new-password")!.value;
    const confirm = document.querySelector<HTMLInputElement>("#confirm-new-password")!.value;
    if (!newPassword || newPassword !== confirm) { document.querySelector("#password-error")!.textContent = t("passwordMismatch"); return; }
    void changePassword(currentPassword, newPassword);
  });
  const main = document.querySelector<HTMLElement>(".settings-main");
  if (main) main.scrollTop = scrollTop;
  if (focused) document.getElementById(focused)?.focus();
}

async function copyAgentPrompt() {
  if (copyingAgentPrompt || !isTauri()) return;
  copyingAgentPrompt = true;
  agentCopyStatus = "";
  agentCopyError = false;
  render();
  try {
    await invoke("copy_agent_prompt", { language: getLanguage() });
    agentCopyStatus = t("agentCopied");
  } catch (error) {
    agentCopyError = true;
    agentCopyStatus = t("agentCopyFailed", { error: String(error) });
  } finally { copyingAgentPrompt = false; render(); }
}

async function saveAi() {
  if (saving || !aiLoaded) return;
  saving = true;
  aiStatus = "";
  aiError = false;
  render();
  try {
    await invoke("save_ai_settings", { settings: { ...aiSettings, baseUrl: aiSettings.baseUrl.trim(), model: aiSettings.model.trim() }, clearKey: aiClearKey });
    aiSettings.apiKey = "";
    aiClearKey = false;
    aiStatus = t("aiSaved");
  } catch (error) { aiError = true; aiStatus = t("aiSaveFailed", { error: String(error) }); }
  finally { saving = false; render(); }
}

async function testAi() {
  if (saving || !aiLoaded) return;
  saving = true;
  aiStatus = "";
  aiError = false;
  render();
  try { await invoke("test_ai_connection"); aiStatus = t("aiTestOk"); }
  catch (error) { aiError = true; aiStatus = t("aiTestFailed", { error: String(error) }); }
  finally { saving = false; render(); }
}

async function changePassword(currentPassword: string, newPassword: string) {
  if (saving) return;
  saving = true;
  const form = document.querySelector<HTMLFormElement>("#change-password-form")!;
  const controls = form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button");
  controls.forEach((control) => { control.disabled = true; });
  const lockControl = document.querySelector<HTMLInputElement>("#lock-on-hide");
  if (lockControl) lockControl.disabled = true;
  document.querySelector("#password-error")!.textContent = "";
  try {
    await invoke("change_encryption_password", { currentPassword, newPassword });
    changingPassword = false;
    passwordChanged = true;
    saving = false;
    render();
    document.querySelector<HTMLElement>("#change-password")?.focus();
  } catch (error) {
    console.error(error);
    const errorMessage = document.querySelector("#password-error");
    if (errorMessage) errorMessage.textContent = error === "invalid_current_password_or_data" ? t("currentPasswordFailed") : t("encryptionFailed");
    controls.forEach((control) => { control.disabled = false; });
    if (lockControl) lockControl.disabled = false;
    saving = false;
  }
}

async function updateVault(command: string, args: Record<string, unknown>) {
  if (saving) return;
  saving = true;
  vaultError = "";
  try {
    await invoke(command, args);
    vault = await invoke("vault_status");
  } catch (error) {
    vaultError = t("encryptionFailed");
    console.error(error);
  } finally { saving = false; render(); }
}

async function changeLanguage(language: Language) {
  if (saving || language === getLanguage()) return;
  const previous = getLanguage();
  saving = true;
  failed = false;
  try {
    setLanguage(language);
    if (isTauri()) await invoke("set_language", { language });
  } catch (error) {
    try { setLanguage(previous); } catch (restoreError) { console.error(restoreError); }
    if (isTauri()) await invoke("set_language", { language: previous }).catch(console.error);
    failed = true;
    console.error(error);
  } finally {
    saving = false;
    render();
  }
}

function close() {
  if (saving) return;
  if (isTauri()) void invoke("close_settings").catch(console.error);
  else window.close();
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.isComposing) close();
});

void watchSettings(render).then((dispose) => {
  window.addEventListener("pagehide", dispose, { once: true });
  render();
  if (isTauri()) void invoke<typeof vault>("vault_status").then((status) => { vault = status; render(); }).catch((error) => { console.error(error); vaultLoadFailed = true; render(); });
  if (isTauri()) void invoke<AiSettings>("get_ai_settings").then((settings) => {
    if (settings.baseUrl) {
      aiSettings = settings;
      aiPreset = (Object.keys(AI_PRESETS) as (keyof typeof AI_PRESETS)[]).find((key) => AI_PRESETS[key].baseUrl === settings.baseUrl && AI_PRESETS[key].model === settings.model) ?? "custom";
    }
    aiLoaded = true;
    render();
  }).catch((error) => { aiLoaded = true; aiError = true; aiStatus = t("aiLoadFailed", { error: String(error) }); render(); });
});
