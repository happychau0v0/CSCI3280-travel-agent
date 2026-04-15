import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "../api/client";

const STATUS_COLORS = {
  ok:            "#10b981",  // green
  degraded:      "#f59e0b",  // amber
  error:         "#ef4444",  // red
  unconfigured:  "#6b7280",  // grey
};

const STATUS_LABELS = {
  ok:            "OK",
  degraded:      "SLOW",
  error:         "ERROR",
  unconfigured:  "NO KEY",
};

function StatusDot({ status }) {
  return (
    <span
      className="sso-dot"
      style={{ background: STATUS_COLORS[status] ?? STATUS_COLORS.error }}
      aria-hidden="true"
    />
  );
}

export default function ServiceStatusOverlay({ open, onClose }) {
  const [fetchState, setFetchState] = useState("idle"); // idle|loading|loaded|error
  const [data, setData] = useState(null);
  const rootRef = useRef(null);
  const previousFocusRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    setFetchState("loading");
    try {
      const res = await fetch(`${API_BASE}/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setFetchState("loaded");
    } catch {
      setFetchState("error");
    }
  }, []);

  // Focus management
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement;
      requestAnimationFrame(() => rootRef.current?.focus());
      fetchStatus();
    } else if (previousFocusRef.current) {
      try { previousFocusRef.current.focus(); } catch { /* ignore */ }
      previousFocusRef.current = null;
    }
  }, [open, fetchStatus]);

  // Keyboard: Esc closes, R refreshes
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose?.(); return; }
      if (e.key === "r" || e.key === "R") { e.preventDefault(); fetchStatus(); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, fetchStatus]);

  if (!open) return null;

  const checkedAt = data?.checked_at
    ? new Date(data.checked_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  const content = (
    <div
      className="sso-overlay"
      role="dialog"
      aria-label="Service Status"
      ref={rootRef}
      tabIndex={-1}
    >
      <div className="sso-backdrop" onClick={onClose} />
      <div className="sso-frame">
        <header className="sso-header">
          <span className="sso-title">SERVICE STATUS</span>
          <span className="sso-hints">
            <kbd>R</kbd> refresh · <kbd>Esc</kbd> close
          </span>
        </header>

        <div className="sso-body">
          {fetchState === "loading" && (
            <div className="sso-loading">
              <span className="sso-pulse" />
              PROBING SERVICES…
            </div>
          )}

          {fetchState === "error" && (
            <div className="sso-fetch-error">
              Could not reach backend. Is the server running?
            </div>
          )}

          {fetchState === "loaded" && data && (
            <>
              <ul className="sso-list">
                {data.services.map((svc) => (
                  <li key={svc.id} className="sso-row">
                    <StatusDot status={svc.status} />
                    <span className="sso-label">{svc.label}</span>
                    <span className="sso-spacer" />
                    <span
                      className="sso-badge"
                      style={{ color: STATUS_COLORS[svc.status] ?? STATUS_COLORS.error }}
                    >
                      {STATUS_LABELS[svc.status] ?? svc.status.toUpperCase()}
                    </span>
                    {svc.status !== "unconfigured" && (
                      <span className="sso-latency">{svc.latency_ms} ms</span>
                    )}
                    {svc.detail && (
                      <span className="sso-detail">{svc.detail}</span>
                    )}
                  </li>
                ))}
              </ul>
              {checkedAt && (
                <p className="sso-checked">Checked {checkedAt}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
