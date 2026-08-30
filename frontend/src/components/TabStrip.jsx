import { useEffect, useRef, useState } from "react";
import { PANELS } from "../hooks/useMenuState";

const TAB_LABELS = {
  HOME: "PLAN",
  FLIGHTS: "FLIGHTS",
  HOTELS: "HOTELS",
  DAYS: "DAYS",
  EXPORT: "EXPORT",
};

function chipClass(ms) {
  if (ms < 3000) return "fast";
  if (ms < 10000) return "warn";
  return "slow";
}

function TimingDropdown({ agentState, toolTimings, requestStartedAt }) {
  const [open, setOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const wrapRef = useRef(null);

  // Tick elapsed time while working
  useEffect(() => {
    if (agentState !== "working") return;
    const id = setInterval(() => {
      setElapsed(requestStartedAt?.current
        ? Date.now() - requestStartedAt.current
        : 0);
    }, 250);
    return () => clearInterval(id);
  }, [agentState, requestStartedAt]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function handleKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const totalMs = toolTimings.reduce((s, t) => s + t.elapsed_ms, 0);
  const displayMs = agentState === "working" ? elapsed : totalMs;
  if (displayMs <= 0) return null;

  const label = `${(displayMs / 1000).toFixed(1)}s`;

  return (
    <div className="timing-wrap" ref={wrapRef}>
      <button
        className="timing-btn"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Show request timing breakdown"
      >
        {label}
        <span className="timing-arrow">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="timing-dropdown" role="menu">
          {toolTimings.length === 0 ? (
            <div className="timing-row timing-empty">No tool data yet</div>
          ) : (
            <>
              {toolTimings.map((t, i) => (
                <div key={i} className="timing-row">
                  <span className="timing-name">{t.name}</span>
                  <span className={`timing-chip ${chipClass(t.elapsed_ms)}`}>
                    {t.elapsed_ms < 1000
                      ? `${t.elapsed_ms}ms`
                      : `${(t.elapsed_ms / 1000).toFixed(1)}s`}
                  </span>
                </div>
              ))}
              <div className="timing-row timing-total">
                <span className="timing-name">TOTAL</span>
                <span className="timing-chip fast">{label}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Top-of-screen NieR-style tab strip. Shows the panel tabs on the left
 * and a subtle "Thinking…" indicator on the right when the agent is busy,
 * plus a timing dropdown showing elapsed / per-tool times.
 */
export default function TabStrip({
  activePanel,
  scope,
  onTabClick,
  agentState = "idle",
  toolTimings = [],
  requestStartedAt = null,
  exportEnabled = false,
}) {
  return (
    <nav className="tab-strip" aria-label="Menu sections" role="tablist">
      {PANELS.map((panel, i) => {
        const isActive = panel === activePanel;
        const inFocus = isActive && scope === "tabs";
        const isDisabled = panel === "EXPORT" && !exportEnabled;
        return (
          <button
            key={panel}
            type="button"
            className={`tab${isActive ? " active" : ""}${inFocus ? " focused" : ""}${isDisabled ? " disabled" : ""}`}
            onClick={() => !isDisabled && onTabClick?.(panel)}
            role="tab"
            aria-selected={isActive}
            aria-disabled={isDisabled || undefined}
            title={isDisabled ? "Complete your itinerary first (PLAN → FLIGHTS → HOTELS → DAYS)" : undefined}
          >
            <span className="tab-bracket">◢</span>
            <span className="tab-num">{i + 1}</span>
            <span className="tab-label">{TAB_LABELS[panel]}</span>
          </button>
        );
      })}
      <div className="tab-status" aria-live="polite" aria-label="Agent status">
        {agentState === "working" && (
          <>
            <span className="tab-status-dot" />
            <span className="tab-status-label">Thinking…</span>
          </>
        )}
        <TimingDropdown
          agentState={agentState}
          toolTimings={toolTimings}
          requestStartedAt={requestStartedAt}
        />
      </div>
    </nav>
  );
}
