import { icon } from "./icons";
import { t } from "./i18n";

type State = { open: boolean; busy: boolean; prompt: string; error: string };
type Actions = { toggle: () => void; input: (value: string) => void; run: () => void; cancel: () => void };

// Lives outside #app: task renders must never replace the animated surface or editor.
export function createAiIsland(actions: Actions) {
  const island = document.createElement("aside");
  island.className = "ai-island";
  island.innerHTML = `<button type="button" class="ai-island-trigger">${icon("ai")}<span>AI</span></button>
    <form class="ai-island-form" id="android-ai-panel" inert>
      <div class="ai-island-heading"><span>${icon("ai")} AI</span><button type="button" class="ai-island-close">${icon("close")}</button></div>
      <label class="sr-only" for="android-ai-prompt"></label>
      <textarea id="android-ai-prompt" rows="2" maxlength="2000"></textarea>
      <div class="ai-island-actions"><span class="ai-island-status" role="status" aria-live="polite"></span><button class="ai-island-send" type="submit"></button></div>
    </form>`;
  document.body.append(island);
  const trigger = island.querySelector<HTMLButtonElement>(".ai-island-trigger")!;
  const form = island.querySelector<HTMLFormElement>("form")!;
  const input = island.querySelector<HTMLTextAreaElement>("textarea")!;
  const close = island.querySelector<HTMLButtonElement>(".ai-island-close")!;
  const send = island.querySelector<HTMLButtonElement>(".ai-island-send")!;
  const status = island.querySelector<HTMLElement>(".ai-island-status")!;
  let state: State = { open: false, busy: false, prompt: "", error: "" };

  const resize = () => {
    input.style.height = "0px";
    const height = Math.min(120, Math.max(48, input.scrollHeight));
    input.style.height = `${height}px`;
    island.style.setProperty("--island-height", `${height + 100}px`);
  };
  const viewport = () => {
    const view = window.visualViewport;
    // adjustResize already changes innerHeight. Only compensate any remaining
    // visual-viewport occlusion, avoiding a second keyboard-height offset.
    const inset = view ? Math.max(0, window.innerHeight - view.height - view.offsetTop) : 0;
    island.style.setProperty("--keyboard-inset", `${inset}px`);
  };
  window.visualViewport?.addEventListener("resize", viewport);
  window.visualViewport?.addEventListener("scroll", viewport);
  window.addEventListener("resize", viewport);
  trigger.addEventListener("click", actions.toggle);
  close.addEventListener("click", actions.toggle);
  input.addEventListener("input", () => { actions.input(input.value); resize(); send.disabled = !state.busy && !input.value.trim(); });
  form.addEventListener("submit", (event) => { event.preventDefault(); if (state.busy) actions.cancel(); else actions.run(); });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); actions.toggle(); }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!state.busy) actions.run(); }
  });

  return {
    update(next: State) {
      const opening = next.open && !state.open;
      const closing = !next.open && state.open;
      state = next;
      trigger.setAttribute("aria-label", t("aiMobileOpen"));
      trigger.setAttribute("aria-expanded", String(next.open));
      trigger.setAttribute("aria-controls", form.id);
      trigger.inert = next.open;
      form.inert = !next.open;
      close.setAttribute("aria-label", t("aiCollapse"));
      input.setAttribute("aria-label", t("ai"));
      input.placeholder = t("aiPlaceholder");
      if (input.value !== next.prompt) input.value = next.prompt;
      input.readOnly = next.busy;
      send.setAttribute("aria-label", t(next.busy ? "cancel" : "aiRun"));
      send.innerHTML = next.busy ? icon("close") : icon("send");
      send.disabled = !next.busy && !next.prompt.trim();
      status.textContent = next.busy ? t("aiThinking") : next.error;
      status.classList.toggle("is-error", !!next.error && !next.busy);
      island.classList.toggle("is-open", next.open);
      island.classList.toggle("is-busy", next.busy);
      document.documentElement.classList.toggle("ai-island-open", next.open);
      resize();
      if (opening) input.focus({ preventScroll: true });
      if (closing && island.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      viewport();
    },
  };
}
