/**
 * VisaAlertBanner — inline pill badge showing visa status for the
 * destination country based on the user's passport.
 *
 * Renders as a small pill next to the destination name in PanelFlights.
 * Hover reveals extra notes (e.g., "eTA required", "apply at consulate").
 *
 * Props:
 *   visaAlert — { status, free_days?, notes?, destination, passport } | null
 *               When null the component renders nothing.
 */

const STATUS_CONFIG = {
  visa_free: {
    className: "visa-badge visa-badge--free",
    label: (days) => days ? `VISA FREE · ${days}D` : "VISA FREE",
  },
  visa_on_arrival: {
    className: "visa-badge visa-badge--arrival",
    label: (days) => days ? `VISA ON ARRIVAL · ${days}D` : "VISA ON ARRIVAL",
  },
  visa_required: {
    className: "visa-badge visa-badge--required",
    label: () => "VISA REQUIRED",
  },
  unknown: {
    className: "visa-badge visa-badge--unknown",
    label: () => "VISA ?",
  },
};

export default function VisaAlertBanner({ visaAlert }) {
  if (!visaAlert) return null;

  const { status, free_days, notes } = visaAlert;
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.unknown;
  const label = config.label(free_days);

  return (
    <span
      className={config.className}
      title={notes || undefined}
      aria-label={`Visa status: ${label}${notes ? `. ${notes}` : ""}`}
    >
      {label}
    </span>
  );
}
