/**
 * All widget styles live inside the shadow root. `.ph-root` resets inherited
 * properties so page styles (fonts, colors, `* { all: unset }` on the host) can't leak in.
 * Only px units: page `html { font-size }` must not scale the widget.
 */
export const STYLES = /* css */ `
:host { all: initial; }
.ph-root {
  all: initial;
  --ph-accent: #c96442;
  --ph-accent-rgb: 201, 100, 66;
  --ph-accent-ink: #ffffff;
  --ph-bug: #d14d41;
  --ph-question: #7b6bd6;
  --ph-bg: #ffffff;
  --ph-ink: #1f1e1d;
  --ph-muted: #73726c;
  --ph-line: #e6e4dd;
  --ph-line-soft: #f1efea;
  --ph-hover: #f0eee8;
  --ph-hover-soft: #faf9f6;
  --ph-pressed: #e6e3dc;
  --ph-danger: #c4392f;
  --ph-shadow: 0 4px 16px rgba(20, 20, 19, .10), 0 1px 3px rgba(20, 20, 19, .06);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 20px;
  color: var(--ph-ink);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .ph-root {
    --ph-bg: #262624;
    --ph-ink: #f2f0ea;
    --ph-muted: #a6a39b;
    --ph-line: #3a3936;
    --ph-line-soft: #302f2c;
    --ph-hover: #33322f;
    --ph-hover-soft: #2c2b29;
    --ph-pressed: #403e3a;
    --ph-accent: #d97757;
    --ph-accent-rgb: 217, 119, 87;
  }
}
.ph-root *, .ph-root *::before, .ph-root *::after { box-sizing: border-box; }
[hidden] { display: none !important; }

/* Floating bar: comment toggle + chevron menu */
.ph-bar {
  position: fixed;
  display: flex; align-items: center; gap: 2px;
  padding: 4px; margin: 0;
  background: var(--ph-bg);
  border: 1px solid var(--ph-line); border-radius: 12px;
  box-shadow: var(--ph-shadow);
  pointer-events: auto;
}
.ph-pos-bottom-right { right: 20px; bottom: 20px; }
.ph-pos-bottom-left { left: 20px; bottom: 20px; }
.ph-pos-top-right { right: 20px; top: 20px; }
.ph-pos-top-left { left: 20px; top: 20px; }
.ph-toggle, .ph-more, .ph-icon-btn {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; padding: 0; margin: 0;
  border: 0; border-radius: 8px;
  background: transparent; color: var(--ph-ink);
  cursor: pointer; user-select: none;
  appearance: none; -webkit-appearance: none;
  font-family: inherit;
  transition: background .12s;
}
.ph-more { width: 20px; border-radius: 6px; color: var(--ph-muted); }
.ph-toggle:hover, .ph-more:hover, .ph-icon-btn:hover { background: var(--ph-hover); }
.ph-toggle[aria-pressed="true"], .ph-more[aria-expanded="true"] { background: var(--ph-pressed); color: var(--ph-ink); }
.ph-toggle:focus-visible, .ph-more:focus-visible, .ph-icon-btn:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 1px; }
.ph-toggle svg { width: 20px; height: 20px; display: block; }
.ph-toggle[aria-pressed="true"] svg path { fill: currentColor; }
.ph-more svg { width: 12px; height: 12px; display: block; }
.ph-icon-btn { width: 28px; height: 28px; color: var(--ph-muted); }
.ph-icon-btn svg { width: 14px; height: 14px; display: block; }

.ph-tip {
  position: absolute; right: 0; bottom: calc(100% + 8px);
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border-radius: 6px;
  background: #1f1e1d; color: #fff;
  font-size: 12px; line-height: 16px; white-space: nowrap;
  opacity: 0; pointer-events: none; transition: opacity .12s;
}
.ph-tip kbd { font: inherit; opacity: .65; }
.ph-toggle:hover ~ .ph-tip, .ph-toggle:focus-visible ~ .ph-tip { opacity: 1; transition-delay: .3s; }
.ph-bar[data-popup] .ph-tip { display: none; }

/* Popups anchored to the bar: open upwards for bottom positions, downwards for top ones */
.ph-menu, .ph-panel {
  position: absolute; right: 0; bottom: calc(100% + 8px);
  background: var(--ph-bg); color: var(--ph-ink);
  border: 1px solid var(--ph-line); border-radius: 12px;
  box-shadow: var(--ph-shadow);
}
.ph-pos-top-right .ph-menu, .ph-pos-top-right .ph-panel, .ph-pos-top-left .ph-menu, .ph-pos-top-left .ph-panel,
.ph-pos-top-right .ph-tip, .ph-pos-top-left .ph-tip { bottom: auto; top: calc(100% + 8px); }
.ph-pos-bottom-left .ph-menu, .ph-pos-bottom-left .ph-panel, .ph-pos-top-left .ph-menu, .ph-pos-top-left .ph-panel,
.ph-pos-bottom-left .ph-tip, .ph-pos-top-left .ph-tip { right: auto; left: 0; }

.ph-menu { min-width: 240px; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.ph-mi {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px 10px; margin: 0; border: 0; border-radius: 8px;
  background: transparent; color: var(--ph-ink); text-align: left;
  font-family: inherit; font-size: 14px; line-height: 20px; cursor: pointer;
  appearance: none; -webkit-appearance: none;
}
.ph-mi:hover, .ph-mi:focus { background: var(--ph-hover); outline: none; }
.ph-mi svg { width: 16px; height: 16px; flex: none; color: var(--ph-muted); }
.ph-mi-text { flex: 1; white-space: nowrap; }
.ph-mi-extra { color: var(--ph-muted); font-size: 12px; }

.ph-panel { width: 340px; max-width: calc(100vw - 40px); max-height: min(420px, calc(100vh - 100px)); display: flex; flex-direction: column; overflow: hidden; }
.ph-panel-head { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--ph-line); }
.ph-panel-title { font-weight: 600; white-space: nowrap; }
.ph-seg { margin-left: auto; display: flex; gap: 2px; padding: 2px; border-radius: 7px; background: var(--ph-hover); }
.ph-tab {
  padding: 2px 8px; margin: 0; border: 0; border-radius: 5px;
  background: transparent; color: var(--ph-muted);
  font-family: inherit; font-size: 12px; line-height: 18px; font-weight: 500; cursor: pointer;
  appearance: none; -webkit-appearance: none;
}
.ph-tab[aria-selected="true"] { background: var(--ph-bg); color: var(--ph-ink); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.ph-tab:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 1px; }
.ph-list { overflow: auto; }
.ph-item {
  display: flex; gap: 10px; width: 100%;
  padding: 10px 14px; margin: 0; border: 0; border-bottom: 1px solid var(--ph-line-soft);
  background: transparent; color: var(--ph-ink); text-align: left;
  font-family: inherit; cursor: pointer;
  appearance: none; -webkit-appearance: none;
}
.ph-item:last-child { border-bottom: 0; }
.ph-item:hover, .ph-item:focus-visible { background: var(--ph-hover-soft); outline: none; }
.ph-item-missing { cursor: default; opacity: .55; }
.ph-num {
  flex: none; width: 22px; height: 22px; border-radius: 11px 11px 11px 3px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--ph-accent); color: #fff; font-size: 11px; line-height: 1; font-weight: 600;
}
.ph-num[data-kind="bug"] { background: var(--ph-bug); }
.ph-num[data-kind="question"] { background: var(--ph-question); }
.ph-item-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ph-item-text { font-size: 13px; line-height: 18px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.ph-item-meta { font-size: 12px; line-height: 16px; color: var(--ph-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ph-item-meta code { font: 11px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--ph-hover); padding: 0 4px; border-radius: 4px; }
.ph-missing { font-style: italic; }
.ph-empty { padding: 24px 14px; text-align: center; color: var(--ph-muted); font-size: 13px; }

/* Highlight boxes */
.ph-box {
  position: fixed; top: 0; left: 0; width: 0; height: 0;
  pointer-events: none;
  border-radius: 3px;
  outline: 2px solid var(--ph-accent);
  outline-offset: 0;
  background: rgba(var(--ph-accent-rgb), .06);
}
.ph-box.ph-selected { outline-width: 2px; background: rgba(var(--ph-accent-rgb), .10); }
.ph-tag {
  position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px;
  max-width: 280px; padding: 2px 6px; border-radius: 4px;
  background: var(--ph-accent); color: #fff;
  font: 500 11px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ph-tag.ph-inside { bottom: auto; top: 2px; left: 2px; margin: 0; }

/* Pins */
.ph-pin {
  position: fixed; top: 0; left: 0;
  width: 24px; height: 24px; padding: 0; margin: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 2px solid #fff; border-radius: 12px 12px 12px 3px;
  background: var(--ph-accent); color: #fff;
  font-family: inherit; font-weight: 600; font-size: 12px; line-height: 1;
  box-shadow: 0 2px 6px rgba(16,24,40,.3);
  cursor: pointer; pointer-events: auto;
  appearance: none; -webkit-appearance: none;
}
.ph-pin:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 2px; }
.ph-pin[data-kind="bug"] { background: var(--ph-bug); }
.ph-pin[data-kind="question"] { background: var(--ph-question); }

/* Popover */
.ph-popover {
  position: fixed; top: 0; left: 0;
  width: 344px; max-width: calc(100vw - 16px);
  padding: 12px; border-radius: 12px;
  background: var(--ph-bg); color: var(--ph-ink);
  border: 1px solid var(--ph-line);
  box-shadow: var(--ph-shadow);
  pointer-events: auto;
  display: flex; flex-direction: column; gap: 10px;
}
.ph-kinds { display: flex; gap: 2px; margin-right: auto; flex: none; }
.ph-kind {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; padding: 0; margin: 0; border: 0; border-radius: 8px;
  background: transparent; cursor: pointer;
  font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
  font-size: 18px; line-height: 1;
  appearance: none; -webkit-appearance: none;
  transition: background .12s, opacity .12s, filter .12s, transform .12s;
}
.ph-kind:hover { background: var(--ph-hover); }
.ph-kind[aria-pressed="true"] { background: rgba(var(--ph-accent-rgb), .14); transform: scale(1.06); }
/* once a category is picked, the other two step back */
.ph-kinds:has([aria-pressed="true"]) .ph-kind:not([aria-pressed="true"]):not(:hover) { opacity: .45; filter: grayscale(1); }
.ph-kind:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 1px; }
.ph-textarea {
  display: block; width: 100%; min-height: 72px; max-height: 240px; margin: 0;
  padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--ph-line); background: transparent; color: inherit;
  font-family: inherit; font-size: 14px; line-height: 20px;
  resize: none; overflow-y: auto; white-space: pre-wrap;
}
.ph-textarea:focus { outline: none; border-color: var(--ph-accent); box-shadow: 0 0 0 3px rgba(var(--ph-accent-rgb), .18); }
.ph-textarea::placeholder { color: var(--ph-muted); }
.ph-error { color: var(--ph-danger); font-size: 13px; line-height: 18px; }
.ph-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.ph-hint { margin-right: auto; color: var(--ph-muted); font-size: 12px; }
.ph-btn {
  display: inline-flex; align-items: center; justify-content: center;
  height: 32px; padding: 0 12px; margin: 0; border-radius: 8px;
  border: 1px solid var(--ph-line); background: transparent; color: inherit;
  font-family: inherit; font-weight: 500; font-size: 13px; line-height: 18px; cursor: pointer;
  appearance: none; -webkit-appearance: none;
}
.ph-btn:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 2px; }
.ph-btn-primary { background: var(--ph-accent); border-color: var(--ph-accent); color: var(--ph-accent-ink); }
.ph-btn:disabled { opacity: .45; cursor: default; }
.ph-view-head { display: flex; align-items: center; gap: 8px; }
.ph-badge { font-size: 12px; line-height: 16px; padding: 2px 8px; border-radius: 10px; background: rgba(127,127,127,.14); color: var(--ph-ink); }
.ph-meta { color: var(--ph-muted); font-size: 12px; margin-left: auto; }
.ph-view-text { white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }

/* Recording (Telegram-style button, bar, preview) */
.ph-rec-btn {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; padding: 0; margin: 0; border: 0; border-radius: 16px;
  background: transparent; color: var(--ph-muted); cursor: pointer;
  appearance: none; -webkit-appearance: none; touch-action: none; user-select: none;
  transition: background .12s, color .12s, transform .15s;
}
.ph-rec-btn:hover { background: var(--ph-hover); color: var(--ph-ink); }
.ph-rec-btn:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 1px; }
.ph-rec-btn svg { width: 20px; height: 20px; display: block; }
.ph-rec-btn.ph-pressing { background: rgba(var(--ph-accent-rgb), .14); color: var(--ph-accent); transform: scale(1.12); transition-duration: .35s; }
@media (prefers-reduced-motion: no-preference) {
  .ph-rec-btn svg { animation: ph-swap .18s ease-out; }
  @keyframes ph-swap { from { transform: scale(.6) rotate(-20deg); opacity: 0; } }
  .ph-rec-dot { animation: ph-pulse 1.2s ease-in-out infinite; }
  @keyframes ph-pulse { 50% { opacity: .35; } }
}
.ph-rec-area { display: flex; flex-direction: column; gap: 6px; }
.ph-rec-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 4px 4px 10px; border-radius: 8px;
  background: rgba(var(--ph-accent-rgb), .08);
  font-size: 13px; line-height: 18px;
}
.ph-rec-dot { width: 8px; height: 8px; border-radius: 4px; background: #e5484d; flex: none; }
.ph-rec-mode { font-weight: 500; }
.ph-rec-time { font-variant-numeric: tabular-nums; color: var(--ph-muted); white-space: nowrap; }
.ph-rec-progress { flex: 1; height: 3px; border-radius: 2px; background: var(--ph-line); overflow: hidden; min-width: 20px; }
.ph-rec-progress-fill { display: block; height: 100%; width: 0; background: var(--ph-accent); transition: width .2s linear; }
.ph-rec-stop { color: #e5484d; }
.ph-rec-preview { display: flex; flex-direction: column; gap: 4px; }
.ph-audio { display: block; width: 100%; height: 36px; }
.ph-video { display: block; width: 100%; max-height: 180px; border-radius: 8px; background: #000; }
.ph-rec-row { display: flex; align-items: center; gap: 2px; }
.ph-rec-info { margin-right: auto; color: var(--ph-muted); font-size: 12px; line-height: 16px; }
.ph-rec-note { color: var(--ph-muted); font-size: 12px; line-height: 16px; }
.ph-attachments { display: flex; flex-direction: column; gap: 8px; }
.ph-att { color: var(--ph-ink); }

/* Screen-recording strip: bottom centre, out of the way of what is being shown */
.ph-rec-dock {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  pointer-events: auto;
  border-radius: 12px; box-shadow: var(--ph-shadow);
}
.ph-rec-dock .ph-rec-bar {
  background: #1f1e1d; color: #fff; padding: 6px 6px 6px 14px; border-radius: 12px; gap: 10px;
}
.ph-rec-dock .ph-rec-time { color: rgba(255,255,255,.75); }
.ph-rec-dock .ph-rec-progress { width: 80px; flex: none; background: rgba(255,255,255,.2); }
.ph-rec-dock .ph-icon-btn { color: rgba(255,255,255,.8); }
.ph-rec-dock .ph-icon-btn:hover { background: rgba(255,255,255,.12); }
.ph-rec-dock .ph-rec-stop { color: #ff6b6b; }
.ph-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Toast */
.ph-toast {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  padding: 8px 14px; border-radius: 8px;
  background: #1f1e1d; color: #fff; font-size: 14px; line-height: 20px;
  box-shadow: var(--ph-shadow); pointer-events: none;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-popover, .ph-toast { animation: ph-in .12s ease-out; }
  @keyframes ph-in { from { opacity: 0; } }
  .ph-toast { animation: none; }
}
`;
