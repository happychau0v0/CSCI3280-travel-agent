import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COUNTRIES } from "../data/countries";

/**
 * SettingsOverlay — full-screen dimmed settings panel.
 *
 * Triggered by the S hotkey. Same visual model as HistoryOverlay:
 * portal, dimmed backdrop, framed content area, focus-trap, Esc to
 * close. Inside is a list of editable preference rows + actionable
 * rows (mute, clear data, about).
 *
 * Replaces the deleted PanelSettings tab. The same row schema is
 * preserved so the user's localStorage prefs continue to work.
 */

const PREF_FIELDS = [
  { key: "interests", label: "INTERESTS", type: "text", placeholder: "history, ramen, hiking" },
  { key: "dislikes", label: "DISLIKES", type: "text", placeholder: "crowds, seafood" },
  { key: "dietary", label: "DIETARY", type: "text", placeholder: "vegetarian, halal" },
  {
    key: "budget",
    label: "BUDGET",
    type: "select",
    options: [
      ["", "Any"],
      ["$", "$ — budget"],
      ["$$", "$$ — moderate"],
      ["$$$", "$$$ — premium"],
    ],
  },
  { key: "travel_style", label: "TRAVEL STYLE", type: "text", placeholder: "relaxed, adventurous" },
  {
    key: "passport_country",
    label: "PASSPORT",
    type: "select",
    options: [["", "Select passport..."], ...COUNTRIES.map((c) => [c.value, c.label])],
  },
];

const STORAGE_KEY = "travel-prefs";

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    // Default passport to HK if not yet set
    return { passport_country: "HK", ...parsed };
  } catch {
    return { passport_country: "HK" };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function preferencesForApi(prefs) {
  if (!prefs) return null;
  const out = {};
  if (prefs.interests?.trim()) {
    out.interests = prefs.interests.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (prefs.dislikes?.trim()) {
    out.dislikes = prefs.dislikes.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (prefs.dietary?.trim()) out.dietary = prefs.dietary.trim();
  if (prefs.budget) out.budget = prefs.budget;
  if (prefs.travel_style?.trim()) out.travel_style = prefs.travel_style.trim();
  if (prefs.passport_country) out.passport_country = prefs.passport_country;
  return Object.keys(out).length > 0 ? out : null;
}

const THEME_STORAGE_KEY = "travel-theme";

export function loadTheme() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

// Round 14 — display currency conversion. Rates are hardcoded
// approximations from HKD (the backend's native currency).
const CURRENCY_STORAGE_KEY = "travel-currency";

export const CURRENCY_TO_HKD = {
  HKD: 1.0,
  USD: 7.8,   // 1 USD ≈ 7.8 HKD
  EUR: 8.4,   // 1 EUR ≈ 8.4 HKD
  JPY: 0.052, // 1 JPY ≈ 0.052 HKD
  GBP: 9.9,   // 1 GBP ≈ 9.9 HKD
  CNY: 1.1,   // 1 CNY ≈ 1.1 HKD
};

export const CURRENCY_LABELS = {
  HKD: "HK$",
  USD: "US$",
  EUR: "€",
  JPY: "¥",
  GBP: "£",
  CNY: "¥CN",
};

export function loadCurrency() {
  try {
    const raw = localStorage.getItem(CURRENCY_STORAGE_KEY);
    return raw && raw in CURRENCY_TO_HKD ? raw : "HKD";
  } catch {
    return "HKD";
  }
}

function saveCurrency(code) {
  try {
    localStorage.setItem(CURRENCY_STORAGE_KEY, code);
  } catch {
    /* ignore */
  }
}

// Round 17 — subtitle text size (small / medium / large).
const SUBTITLE_SIZE_KEY = "travel-subtitle-size";
const SUBTITLE_SIZES = ["small", "medium", "large"];

// LLM model selector — stored in localStorage, sent to backend on each request.
const LLM_MODEL_STORAGE_KEY = "travel-llm-model";

export const LLM_MODELS = [
  { id: "grok-4.20-0309-non-reasoning", label: "grok-4.20 Non-Reasoning", hint: "xAI · fast (~3-5 s/round) — default" },
  { id: "grok-4.20-0309-reasoning",     label: "grok-4.20 Thinking",      hint: "xAI · extended reasoning (~30-60 s/round)" },
  { id: "grok-4.20-multi-agent-0309",   label: "grok-4.20 Multi-Agent",   hint: "xAI · agentic tasks" },
  { id: "gemini-3.1-pro-preview",       label: "Gemini 3.1 Pro Preview",  hint: "Google · fallback provider" },
];

export function loadLlmModel() {
  try {
    const raw = localStorage.getItem(LLM_MODEL_STORAGE_KEY);
    return LLM_MODELS.find((m) => m.id === raw)?.id || LLM_MODELS[0].id;
  } catch {
    return LLM_MODELS[0].id;
  }
}

function saveLlmModel(id) {
  try { localStorage.setItem(LLM_MODEL_STORAGE_KEY, id); } catch { /* ignore */ }
}

export function loadSubtitleSize() {
  try {
    const raw = localStorage.getItem(SUBTITLE_SIZE_KEY);
    return SUBTITLE_SIZES.includes(raw) ? raw : "medium";
  } catch {
    return "medium";
  }
}

function saveSubtitleSize(size) {
  try {
    localStorage.setItem(SUBTITLE_SIZE_KEY, size);
  } catch {
    /* ignore */
  }
}

export function applySubtitleSize(size) {
  if (typeof document === "undefined") return;
  const body = document.body;
  if (!body) return;
  body.classList.remove("subtitle-small", "subtitle-medium", "subtitle-large");
  body.classList.add(`subtitle-${SUBTITLE_SIZES.includes(size) ? size : "medium"}`);
}

/** Convert an HKD price into the display currency. Backend returns
 * HKD, the frontend re-labels with a fixed rate. */
export function priceInDisplayCurrency(hkd, currency) {
  if (typeof hkd !== "number" || !Number.isFinite(hkd)) return null;
  const rate = CURRENCY_TO_HKD[currency] || 1;
  return hkd / rate;
}

export function formatDisplayPrice(hkd, currency) {
  const converted = priceInDisplayCurrency(hkd, currency);
  if (converted == null) return "—";
  const label = CURRENCY_LABELS[currency] || CURRENCY_LABELS.HKD;
  return `${label}${Math.round(converted).toLocaleString("en")}`;
}

function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

/** Apply a theme to document.body — called on page load and on toggle. */
export function applyTheme(theme) {
  if (typeof document === "undefined") return;
  const body = document.body;
  if (!body) return;
  if (theme === "light") {
    body.classList.add("theme-light");
  } else {
    body.classList.remove("theme-light");
  }
}

export default function SettingsOverlay({
  open,
  onClose,
  onChange,
  onCurrencyChange,
  onLlmModelChange,
  onThemeChange,
  muted = false,
  onToggleMute,
  onClearAll,
}) {
  const [prefs, setPrefs] = useState(() => loadPrefs());
  const [theme, setTheme] = useState(() => loadTheme());
  const [currency, setCurrency] = useState(() => loadCurrency());
  const [subtitleSize, setSubtitleSize] = useState(() => loadSubtitleSize());
  const [llmModel, setLlmModel] = useState(() => loadLlmModel());
  const [confirmClear, setConfirmClear] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [savedFlash, setSavedFlash] = useState(false);
  const previousFocusRef = useRef(null);
  const rootRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    onChange?.(preferencesForApi(prefs));
  }, [prefs, onChange]);

  useEffect(() => {
    onCurrencyChange?.(currency);
  }, [currency, onCurrencyChange]);

  useEffect(() => {
    onLlmModelChange?.(llmModel);
  }, [llmModel, onLlmModelChange]);

  useEffect(() => {
    if (open) {
      setActiveIdx(0);
      setConfirmClear(false);
      previousFocusRef.current = document.activeElement;
      requestAnimationFrame(() => rootRef.current?.focus());
    } else if (previousFocusRef.current) {
      try {
        previousFocusRef.current.focus();
      } catch {
        // ignore
      }
      previousFocusRef.current = null;
    }
  }, [open]);

  const update = (field) => (e) => {
    const next = { ...prefs, [field]: e.target.value };
    setPrefs(next);
    savePrefs(next);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 600);
  };

  const rows = [
    // Most-used: model and appearance
    { kind: "llm", key: "llm_model", label: "LLM MODEL", value: llmModel },
    {
      kind: "action",
      key: "theme",
      label: "THEME",
      value: theme,
      options: ["dark", "light"],
      optionLabels: ["DARK", "LIGHT"],
      onActivate: () => {
        const next = theme === "light" ? "dark" : "light";
        setTheme(next);
        saveTheme(next);
        applyTheme(next);
        onThemeChange?.(next);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 600);
      },
    },
    // Common display preferences
    {
      kind: "action",
      key: "currency",
      label: "CURRENCY",
      value: currency,
      cycleHint: true,
      onActivate: () => {
        const codes = Object.keys(CURRENCY_TO_HKD);
        const idx = codes.indexOf(currency);
        const next = codes[(idx + 1) % codes.length];
        setCurrency(next);
        saveCurrency(next);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 600);
      },
    },
    {
      kind: "action",
      key: "mute",
      label: "MUTE TTS",
      value: muted ? "on" : "off",
      options: ["off", "on"],
      optionLabels: ["OFF", "ON"],
      onActivate: onToggleMute,
    },
    {
      kind: "action",
      key: "subtitle_size",
      label: "SUBTITLE SIZE",
      value: subtitleSize,
      options: ["small", "medium", "large"],
      optionLabels: ["SMALL", "MED", "LARGE"],
      onActivate: () => {
        const idx = SUBTITLE_SIZES.indexOf(subtitleSize);
        const next = SUBTITLE_SIZES[(idx + 1) % SUBTITLE_SIZES.length];
        setSubtitleSize(next);
        saveSubtitleSize(next);
        applySubtitleSize(next);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 600);
      },
    },
    // Trip preferences
    ...PREF_FIELDS.map((f) => ({ kind: "field", ...f })),
    // Destructive / meta
    {
      kind: "action",
      key: "clear",
      label: "CLEAR ALL DATA",
      value: confirmClear ? "TAP AGAIN" : "RESET",
      onActivate: () => {
        if (confirmClear) {
          onClearAll?.();
          setConfirmClear(false);
          onClose?.();
        } else {
          setConfirmClear(true);
          setTimeout(() => setConfirmClear(false), 4000);
        }
      },
    },
  ];

  const selectedIdx = Math.min(activeIdx, rows.length - 1);
  const selected = rows[selectedIdx];

  // Local keyboard handler. Parent useKeyboard is disabled while open.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
        return;
      }
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(rows.length - 1, i + 1));
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        const row = rows[selectedIdx];
        if (row?.kind === "action") row.onActivate?.();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, rows, selectedIdx, onClose]);

  // Scroll the active row into view when navigating with arrow keys.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(".panel-list-item.active")
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx, open]);

  const handleRowClick = (i, row) => {
    setActiveIdx(i);
    if (row.kind === "action") row.onActivate?.();
  };

  if (!open) return null;

  const content = (
    <div
      className="settings-overlay"
      role="dialog"
      aria-label="Settings"
      ref={rootRef}
      tabIndex={-1}
    >
      <div className="history-overlay-backdrop" onClick={onClose} />
      <div className="history-overlay-frame settings-overlay-frame">
        <header className="history-overlay-header">
          <span className="history-overlay-title">SETTINGS</span>
          <span className="history-overlay-meta">
            <kbd>↑↓</kbd> row · <kbd>Space</kbd> activate · <kbd>Esc</kbd> close
          </span>
        </header>

        <div className="settings-overlay-body">
          <ul className="panel-list-items settings-overlay-list" ref={listRef}>
            {rows.map((row, i) => {
              let displayEl;
              if (row.kind === "action" && row.options) {
                displayEl = (
                  <span className="panel-list-options">
                    {row.options.map((opt, oi) => (
                      <span
                        key={opt}
                        className={`panel-list-opt${opt === row.value ? " opt-active" : ""}`}
                      >
                        {row.optionLabels[oi]}
                      </span>
                    ))}
                  </span>
                );
              } else if (row.cycleHint) {
                displayEl = (
                  <span className="panel-list-cycle">‹ {row.value.toUpperCase()} ›</span>
                );
              } else if (row.kind === "llm") {
                const label = LLM_MODELS.find((m) => m.id === row.value)?.label || row.value;
                displayEl = <span className="panel-list-value">{label}</span>;
              } else if (row.kind === "field") {
                const v = prefs[row.key];
                const text = row.type === "select"
                  ? row.options.find(([val]) => val === v)?.[1] || "—"
                  : v || "—";
                displayEl = <span className="panel-list-value">{text}</span>;
              } else {
                displayEl = <span className="panel-list-value">{row.value}</span>;
              }
              return (
                <li
                  key={row.key}
                  className={
                    `panel-list-item${i === selectedIdx ? " active" : ""}` +
                    (row.kind === "action" ? " panel-list-action" : "")
                  }
                  onClick={() => handleRowClick(i, row)}
                  data-row-key={row.key}
                >
                  <span className="panel-list-label">{row.label}</span>
                  {displayEl}
                </li>
              );
            })}
          </ul>

          <div className="panel-detail settings-overlay-detail">
            <div className="panel-detail-label">
              {selected.label}
              {savedFlash && selected.kind === "field" && (
                <span className="settings-saved">✓ SAVED</span>
              )}
            </div>

            {selected.kind === "field" && selected.type === "text" && (
              <input
                type="text"
                value={prefs[selected.key] || ""}
                onChange={update(selected.key)}
                placeholder={selected.placeholder}
                className="panel-input"
                data-testid="settings-input"
              />
            )}
            {selected.kind === "field" && selected.type === "select" && (
              <select
                value={prefs[selected.key] || ""}
                onChange={update(selected.key)}
                className="panel-input"
              >
                {selected.options.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            )}

            {selected.kind === "llm" && (
              <>
                <select
                  value={llmModel}
                  onChange={(e) => {
                    setLlmModel(e.target.value);
                    saveLlmModel(e.target.value);
                    setSavedFlash(true);
                    setTimeout(() => setSavedFlash(false), 600);
                  }}
                  className="panel-input"
                  data-testid="settings-llm-model"
                >
                  {LLM_MODELS.map(({ id, label, hint }) => (
                    <option key={id} value={id}>
                      {label} — {hint}
                    </option>
                  ))}
                </select>
                <p className="panel-detail-hint">
                  Selects the AI model for planning. xAI models require the xAI
                  API key; Gemini requires the Google API key. Change takes effect
                  on the next message.
                </p>
              </>
            )}

            {selected.kind === "action" && selected.key === "mute" && (
              <>
                <button
                  type="button"
                  className="settings-btn"
                  onClick={selected.onActivate}
                  data-testid="settings-mute-btn"
                >
                  {muted ? "🔇 UNMUTE TTS" : "🔊 MUTE TTS"}
                </button>
                <p className="panel-detail-hint">
                  When muted, replies still show as subtitles but aren't
                  spoken aloud and audio cues are silenced.
                </p>
              </>
            )}

            {selected.kind === "action" && selected.key === "clear" && (
              <>
                <button
                  type="button"
                  className={`settings-btn settings-btn-danger${confirmClear ? " confirming" : ""}`}
                  onClick={selected.onActivate}
                  data-testid="settings-clear-btn"
                >
                  {confirmClear ? "TAP AGAIN TO CONFIRM" : "CLEAR ALL DATA"}
                </button>
                <p className="panel-detail-hint">
                  Wipes the conversation, current itinerary, and saved
                  trip form. Preferences are preserved.
                </p>
              </>
            )}

            {selected.kind === "action" && selected.key === "about" && (
              <p className="panel-detail-hint" style={{ marginTop: 0 }}>
                CSCI3280 AI Travel Agent — round 8.5 build.<br />
                NieR-style menu shell, voice-first, LLM-driven.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
