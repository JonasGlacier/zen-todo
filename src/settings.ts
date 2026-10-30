import { invoke, isTauri } from "@tauri-apps/api/core";
import { getLanguage, setLanguage, t, watchSettings } from "./i18n";
import type { Language } from "./i18n";
import { icon } from "./icons";
import "./styles.css";
import "./settings.css";

const app = document.querySelector<HTMLElement>("#app")!;
let saving = false;
let failed = false;
let vault: { encrypted: boolean; locked: boolean; lockOnHide: boolean; legacyTemp: boolean } | null = null;
let vaultError = "";
let vaultLoadFailed = false;
let category: "general" | "privacy" = "general";
document.body.classList.add("settings-window");

function render() {
  const focused = document.activeElement?.id;
  document.documentElement.lang = getLanguage();
  document.title = `${t("settings")} · Zen Todo`;
  app.innerHTML = `<div class="settings-layout">
    <aside class="settings-sidebar">
      <div class="settings-brand">${icon("settings")}<span>Zen Todo</span></div>
      <nav aria-label="${t("settingsNavigation")}">${(["general", "privacy"] as const).map((item) => `<button class="settings-category ${category === item ? "is-selected" : ""}" data-category="${item}" ${category === item ? 'aria-current="page"' : ""}>${icon(item)}<span>${t(item)}</span></button>`).join("")}</nav>
      <div class="settings-autosave">${icon("check")}<span>${t("savedAutomatically")}</span></div>
    </aside>
    <section class="settings-main">
      <header class="settings-page-header"><div><h1>${t("settings")}</h1><p>${t("settingsDescription")}</p></div><button class="settings-close" id="close-settings" title="${t("closeSettings")}" aria-label="${t("closeSettings")}">${icon("close")}</button></header>
      ${category === "general" ? `<section class="settings-section" aria-labelledby="general-title"><h2 id="general-title">${t("general")}</h2><p class="section-description">${t("generalDescription")}</p>
        <div class="settings-card"><div class="setting-row"><div class="setting-label">${icon("language")}<label for="language-select">${t("language")}</label></div><select id="language-select" ${saving ? "disabled" : ""}><option value="zh-CN" lang="zh-CN" ${getLanguage() === "zh-CN" ? "selected" : ""}>简体中文</option><option value="en" lang="en" ${getLanguage() === "en" ? "selected" : ""}>English</option></select></div>
          <p class="setting-description">${t("languageDescription")}</p><p class="setting-hint">${t("languageHint")}</p></div>
      </section><p class="settings-error" role="status">${failed ? t("settingsFailed") : ""}</p>` : `<section class="settings-section" aria-labelledby="privacy-title"><h2 id="privacy-title">${t("privacy")}</h2><p class="section-description">${t("privacyDescription")}</p>
        ${isTauri() && vault ? `<div class="settings-card"><div class="setting-label">${icon("privacy")}<span>${t("encryption")}</span></div><p class="setting-description">${t("encryptionDescription")}</p>
          ${vault.encrypted ? `<p class="encryption-status">${icon("check")}${t("encryptionEnabled")}</p><label class="setting-checkbox"><input id="lock-on-hide" type="checkbox" ${vault.lockOnHide ? "checked" : ""} ${saving ? "disabled" : ""}/><span>${t("lockOnHide")}</span></label><p class="setting-hint">${t("lockOnHideHint")}</p>` : `<form id="encryption-form" class="encryption-form"><label>${t("password")}<input type="password" id="password" autocomplete="new-password" required /></label><label>${t("confirmPassword")}<input type="password" id="confirm-password" autocomplete="new-password" required /></label><button type="submit" ${saving ? "disabled" : ""}>${t("enableEncryption")}</button></form>`}
          ${vault.legacyTemp ? `<p class="settings-error">${t("legacyTempWarning")}</p>` : ""}<p class="settings-error" role="status">${vaultError}</p></div>` : `<div class="settings-card"><p class="setting-description setting-message">${!isTauri() ? t("privacyDesktopOnly") : vaultLoadFailed ? t("privacyLoadFailed") : t("privacyLoading")}</p></div>`}</section>`}
    </section>
  </div>`;
  document.querySelectorAll<HTMLButtonElement>("[data-category]").forEach((button) => button.addEventListener("click", () => {
    if (saving) return;
    category = button.dataset.category === "privacy" ? "privacy" : "general";
    render();
    document.querySelector<HTMLButtonElement>(`[data-category="${category}"]`)?.focus();
  }));
  document.querySelector<HTMLSelectElement>("#language-select")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value === "en" || value === "zh-CN") void changeLanguage(value);
  });
  document.querySelector("#close-settings")!.addEventListener("click", close);
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
  if (focused) document.getElementById(focused)?.focus();
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
});
