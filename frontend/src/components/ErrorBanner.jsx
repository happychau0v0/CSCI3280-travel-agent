import { API_BASE } from "../api/client";

/**
 * Top-of-page error banner with a friendly message and dismiss button.
 */
export default function ErrorBanner({ error, onDismiss }) {
  if (!error) return null;

  let message = error.message || String(error);
  if (error.status === 503) {
    message =
      "The travel agent is offline. Check that OPENROUTER_API_KEY and GOOGLE_MAPS_API_KEY are set in backend/.env, then restart the backend.";
  } else if (error.status === 500) {
    message = `Server error: ${message}. Check the backend logs.`;
  } else if (error.message?.includes("Failed to fetch")) {
    message = `Cannot reach the backend at ${API_BASE}. Is uvicorn running and reachable from this host?`;
  }

  return (
    <div className="error-banner" role="alert">
      <span className="error-icon">⚠</span>
      <span className="error-text">{message}</span>
      <button
        type="button"
        className="error-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss error"
      >
        ×
      </button>
    </div>
  );
}
