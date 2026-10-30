import { invoke, isTauri } from "@tauri-apps/api/core";
import { getLanguage, setLanguage, t, watchSettings } from "./i18n";
import type { Language } from "./i18n";
import { icon } from "./icons";
import "./styles.css";
import "./settings.css";

const app = document.querySelector<HTMLElement>("#app")!;
let saving = false;
let failed = false;
document.body.classList.add("settings-window");

function render() {
  const focused = document.activeElement?.id;
  document.documentElement.lang = getLanguage();
  document.title = `${t("settings")} · Zen Todo`;
  app.innerHTML = `<div class="settings-layout">
    <aside class="settings-sidebar">
      <div class="settings-brand">${icon("settings")}<span>Zen Todo</span></div>
      <nav aria-label="${t("settingsNavigation")}"><button class="settings-category is-selected" aria-current="page">${icon("general")}<span>${t("general")}</span></button></nav>
      <div class="settings-autosave">${icon("check")}<span>${t("savedAutomatically")}</span></div>
    </aside>
    <section class="settings-main">
      <header class="settings-page-header"><div><h1>${t("settings")}</h1><p>${t("settingsDescription")}</p></div><button class="settings-close" id="close-settings" title="${t("closeSettings")}" aria-label="${t("closeSettings")}">${icon("close")}</button></header>
      <section class="settings-section" aria-labelledby="general-title"><h2 id="general-title">${t("general")}</h2><p class="section-description">${t("generalDescription")}</p>
        <div class="settings-card"><div class="setting-row"><div class="setting-label">${icon("language")}<label for="language-select">${t("language")}</label></div><select id="language-select" ${saving ? "disabled" : ""}><option value="zh-CN" lang="zh-CN" ${getLanguage() === "zh-CN" ? "selected" : ""}>简体中文</option><option value="en" lang="en" ${getLanguage() === "en" ? "selected" : ""}>English</option></select></div>
          <p class="setting-description">${t("languageDescription")}</p><p class="setting-hint">${t("languageHint")}</p></div>
      </section>
      <p class="settings-error" role="status">${failed ? t("settingsFailed") : ""}</p>
    </section>
  </div>`;
  document.querySelector<HTMLSelectElement>("#language-select")!.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value === "en" || value === "zh-CN") void changeLanguage(value);
  });
  document.querySelector("#close-settings")!.addEventListener("click", close);
  if (focused) document.getElementById(focused)?.focus();
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
});
