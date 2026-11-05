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
  --ph-ok: #3f8f5b;
  --ph-ok-rgb: 63, 143, 91;
  --ph-unread: #2f6fe4;
  --ph-chat: #f7f6f2;
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
    --ph-ok: #6cbf88;
    --ph-ok-rgb: 108, 191, 136;
    --ph-unread: #5b8ff0;
    --ph-chat: #1f1f1d;
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
.ph-menu, .ph-panel, .ph-signin {
  position: absolute; right: 0; bottom: calc(100% + 8px);
  background: var(--ph-bg); color: var(--ph-ink);
  border: 1px solid var(--ph-line); border-radius: 12px;
  box-shadow: var(--ph-shadow);
}
.ph-pos-top-right .ph-menu, .ph-pos-top-right .ph-panel, .ph-pos-top-left .ph-menu, .ph-pos-top-left .ph-panel,
.ph-pos-top-right .ph-signin, .ph-pos-top-left .ph-signin,
.ph-pos-top-right .ph-tip, .ph-pos-top-left .ph-tip { bottom: auto; top: calc(100% + 8px); }
.ph-pos-bottom-left .ph-menu, .ph-pos-bottom-left .ph-panel, .ph-pos-top-left .ph-menu, .ph-pos-top-left .ph-panel,
.ph-pos-bottom-left .ph-signin, .ph-pos-top-left .ph-signin,
.ph-pos-bottom-left .ph-tip, .ph-pos-top-left .ph-tip { right: auto; left: 0; }

.ph-signin { width: 300px; max-width: calc(100vw - 40px); padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.ph-signin-head { display: flex; align-items: center; gap: 8px; }
.ph-signin-title { flex: 1; font-weight: 600; font-size: 14px; }
.ph-signin-list { display: flex; flex-direction: column; gap: 8px; }
.ph-signin .ph-btn { width: 100%; justify-content: center; }
.ph-signin-error { color: var(--ph-danger, #c62828); font-size: 12px; margin: 0; }
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

.ph-panel { width: 380px; max-width: calc(100vw - 40px); max-height: min(420px, calc(100vh - 100px)); display: flex; flex-direction: column; overflow: hidden; }
.ph-panel-head { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--ph-line); }
.ph-panel-title { font-weight: 600; white-space: nowrap; }
.ph-seg { margin-left: auto; display: flex; gap: 2px; padding: 2px; border-radius: 7px; background: var(--ph-hover); }
.ph-tab {
  padding: 2px 8px; margin: 0; border: 0; border-radius: 5px;
  background: transparent; color: var(--ph-muted);
  font-family: inherit; font-size: 12px; line-height: 18px; font-weight: 500; cursor: pointer; white-space: nowrap;
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
.ph-issue-mark[data-state="unavailable"] { color: var(--ph-danger); }
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
/* data-picked is set from JS: :has() inside shadow roots is not re-evaluated reliably in every engine */
.ph-kinds[data-picked] .ph-kind:not([aria-pressed="true"]):not(:hover) { opacity: .45; filter: grayscale(1); }
.ph-kind:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 1px; }
.ph-textarea {
  display: block; width: 100%; min-height: 72px; max-height: 240px; margin: 0;
  padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--ph-line); background: transparent; color: inherit;
  font-family: inherit; font-size: 14px; line-height: 20px;
  resize: none; overflow-y: auto; white-space: pre-wrap;
}
.ph-field { position: relative; display: block; }
.ph-field[data-rec] .ph-textarea { min-height: 84px; padding-right: 44px; padding-bottom: 36px; }
.ph-field .ph-rec-btn { position: absolute; right: 6px; bottom: 6px; }
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
/* Threads */
.ph-popover-thread { width: 360px; padding: 0; gap: 0; overflow: hidden; }
.ph-thread-head { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--ph-line); }
.ph-thread-head > .ph-icon-btn { flex: none; }
.ph-spacer { flex: 1; }
.ph-status { font-size: 12px; line-height: 16px; padding: 2px 8px; border-radius: 10px; font-weight: 500; background: rgba(var(--ph-accent-rgb), .12); color: var(--ph-accent); white-space: nowrap; }
.ph-status[data-status="resolved"] { background: rgba(var(--ph-ok-rgb), .14); color: var(--ph-ok); }
.ph-status[data-status="closed-other"] { background: rgba(127,127,127,.16); color: var(--ph-muted); }
.ph-issue { font-size: 12px; line-height: 16px; padding: 2px 8px; border-radius: 10px; color: var(--ph-muted); background: var(--ph-hover); text-decoration: none; white-space: nowrap; font-weight: 500; }
.ph-issue:hover { color: var(--ph-ink); background: var(--ph-pressed); }
.ph-issue:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 1px; }
.ph-issue-state { font-size: 12px; line-height: 16px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; font-weight: 500; }
.ph-issue-state[data-state="unavailable"] { color: var(--ph-danger); background: rgba(127,127,127,.12); }
.ph-resolve[data-status="open"]:hover { color: var(--ph-ok); }
.ph-feed { display: flex; flex-direction: column; gap: 6px; padding: 10px 10px 12px; max-height: min(340px, 50vh); overflow-y: auto; background: var(--ph-chat); overscroll-behavior: contain; }
.ph-feed:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: -2px; }
.ph-msg { display: flex; align-items: flex-end; gap: 4px; max-width: 100%; }
.ph-msg.ph-mine { flex-direction: row-reverse; }
.ph-bubble {
  max-width: 82%; min-width: 64px; padding: 6px 10px 4px; border-radius: 14px 14px 14px 4px;
  background: var(--ph-bg); border: 1px solid var(--ph-line); color: var(--ph-ink);
}
.ph-mine .ph-bubble { border-radius: 14px 14px 4px 14px; background: rgba(var(--ph-accent-rgb), .13); border-color: transparent; }
.ph-msg-name { font-size: 12px; line-height: 16px; font-weight: 600; margin-bottom: 1px; color: #c96442; }
.ph-msg-name[data-color="1"] { color: #7b6bd6; }
.ph-msg-name[data-color="2"] { color: #3f8f5b; }
.ph-msg-name[data-color="3"] { color: #2f6fe4; }
.ph-msg-name[data-color="4"] { color: #b7791f; }
.ph-msg-name[data-color="5"] { color: #c2417a; }
.ph-msg-name[data-color="6"] { color: #1d8a99; }
.ph-msg-github .ph-msg-name { display: flex; align-items: center; gap: 4px; }
.ph-msg-name a { color: inherit; text-decoration: none; }
.ph-msg-name a:hover { text-decoration: underline; }
.ph-avatar { width: 14px; height: 14px; border-radius: 50%; flex: none; }
.ph-msg-source { font-weight: 400; color: var(--ph-muted) !important; font-size: 11px; text-decoration: none; }
.ph-msg-text { white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 19px; }
.ph-bubble .ph-view-text { max-height: none; overflow: visible; }
.ph-bubble .ph-attachments { margin-top: 4px; }
.ph-msg-foot { display: flex; justify-content: flex-end; gap: 6px; margin-top: 1px; font-size: 11px; line-height: 14px; color: var(--ph-muted); white-space: nowrap; }
.ph-msg-tools { display: flex; gap: 0; opacity: 0; transition: opacity .12s; }
.ph-msg:hover .ph-msg-tools, .ph-msg-tools:focus-within { opacity: 1; }
.ph-msg-tools .ph-icon-btn { width: 26px; height: 26px; }
.ph-msg-delete:hover { color: var(--ph-danger); }
.ph-confirm { display: flex; align-items: center; gap: 6px; font-size: 13px; padding: 4px 6px; border-radius: 8px; background: var(--ph-bg); border: 1px solid var(--ph-line); }
.ph-confirm span { margin-right: auto; }
.ph-mine .ph-confirm { order: -1; }
.ph-msg:has(.ph-confirm) { flex-wrap: wrap; justify-content: flex-end; }
.ph-btn-danger { background: var(--ph-danger); border-color: var(--ph-danger); color: #fff; }
.ph-confirm .ph-btn, .ph-editor .ph-btn { height: 28px; padding: 0 10px; font-size: 12px; }
.ph-editor { display: flex; flex-direction: column; gap: 6px; width: 82%; margin-left: auto; }
.ph-edit-text { min-height: 44px; background: var(--ph-bg); }
.ph-event { align-self: center; display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px; border-radius: 10px; background: rgba(127,127,127,.12); color: var(--ph-muted); font-size: 12px; line-height: 16px; text-align: center; }
.ph-event svg { width: 12px; height: 12px; color: var(--ph-ok); flex: none; }
.ph-reply { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid var(--ph-line); }
.ph-textarea-compact { min-height: 44px; }
.ph-field[data-rec] .ph-textarea-compact { min-height: 44px; padding-bottom: 10px; }
.ph-btn-resolve { margin-right: auto; gap: 6px; color: var(--ph-ok); border-color: rgba(var(--ph-ok-rgb), .4); }
.ph-btn-resolve svg { width: 14px; height: 14px; }
.ph-btn-resolve:not(:disabled):hover { background: rgba(var(--ph-ok-rgb), .1); }
.ph-name {
  display: block; width: 100%; height: 32px; margin: 0; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--ph-line); background: transparent; color: inherit; font-family: inherit; font-size: 13px;
}
.ph-name:focus { outline: none; border-color: var(--ph-accent); box-shadow: 0 0 0 3px rgba(var(--ph-accent-rgb), .18); }
.ph-name::placeholder { color: var(--ph-muted); }

/* Unread counter, resolved / unread pins and list rows */
.ph-unread {
  position: absolute; left: 28px; top: -4px; min-width: 18px; height: 18px; padding: 0 5px; margin: 0;
  border: 2px solid var(--ph-bg); border-radius: 9px; background: var(--ph-unread); color: #fff;
  font-family: inherit; font-size: 11px; line-height: 14px; font-weight: 600; cursor: pointer;
  appearance: none; -webkit-appearance: none;
}
.ph-unread:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 1px; }
.ph-pin[data-resolved] { background: #fff; color: var(--ph-ok); border-color: var(--ph-ok); }
.ph-pin[data-unread]::after { content: ""; position: absolute; right: -5px; top: -5px; width: 10px; height: 10px; border-radius: 5px; background: var(--ph-unread); border: 2px solid #fff; }
.ph-panel-filters { display: flex; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--ph-line-soft); }
.ph-filter {
  padding: 2px 10px; margin: 0; border: 1px solid var(--ph-line); border-radius: 12px;
  background: transparent; color: var(--ph-muted); font-family: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
  appearance: none; -webkit-appearance: none;
}
.ph-filter[aria-pressed="true"] { background: var(--ph-ink); border-color: var(--ph-ink); color: var(--ph-bg); }
.ph-filter:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 1px; }
.ph-item-unread .ph-item-text { font-weight: 600; }
.ph-unread-dot { flex: none; width: 8px; height: 8px; border-radius: 4px; background: var(--ph-unread); align-self: center; margin-left: auto; }
.ph-item-resolved { opacity: .65; }
.ph-num[data-resolved] { background: transparent; color: var(--ph-ok); box-shadow: inset 0 0 0 1.5px var(--ph-ok); }
@media (prefers-reduced-motion: no-preference) {
  .ph-popover, .ph-toast { animation: ph-in .12s ease-out; }
  @keyframes ph-in { from { opacity: 0; } }
  .ph-toast { animation: none; }
}
`;
