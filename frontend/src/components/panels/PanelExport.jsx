import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { exportPdf } from "../../api/client";
import { downloadKml, countKmlPlaces } from "../../utils/exportKml";

const CHECKLIST_DEFAULT_ITEMS = [
  { key: "passport", label: "Passport valid for 6+ months", critical: true },
  { key: "visa", label: "Visa / ESTA / travel authorization", critical: true },
  { key: "insurance", label: "Travel insurance booked", critical: false },
  { key: "flights_confirm", label: "Flight confirmation received", critical: true },
  { key: "hotel_confirm", label: "Hotel booking confirmed", critical: true },
  { key: "adapter", label: "Power adapter for destination", critical: false },
  { key: "sim", label: "SIM / eSIM / roaming plan", critical: false },
  { key: "cash", label: "Local currency / card with no FX fees", critical: false },
  { key: "meds", label: "Medications + copies of prescriptions", critical: false },
  { key: "emergency", label: "Emergency contacts saved offline", critical: true },
  { key: "calendar", label: "Out of office / calendar blocked", critical: false },
  { key: "home", label: "House-sitter / mail / plants", critical: false },
];

// Progress phases shown while the PDF request is in flight.
// `after` is the ms delay from when loading starts before this label shows.
const PDF_PHASES = [
  { after: 0,     label: "Sending request…" },
  { after: 2000,  label: "Fetching activity photos…" },
  { after: 10000, label: "Rendering PDF… almost done" },
];

function usePdfPhase(loading) {
  const [phaseLabel, setPhaseLabel] = useState("");
  const timersRef = useRef([]);

  useEffect(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    if (!loading) {
      // Reset asynchronously so setState is never called synchronously in the effect body
      const t = setTimeout(() => setPhaseLabel(""), 0);
      timersRef.current = [t];
      return () => clearTimeout(t);
    }
    // Schedule each phase label to appear after its delay
    timersRef.current = PDF_PHASES.map(({ after, label }) =>
      setTimeout(() => setPhaseLabel(label), after),
    );
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, [loading]);

  return phaseLabel;
}

function loadChecklistState(destinationKey) {
  try {
    const raw = localStorage.getItem("travel-checklist");
    const all = raw ? JSON.parse(raw) : {};
    return all[destinationKey || "default"] || {};
  } catch {
    return {};
  }
}

export default function PanelExport({ itinerary, visaAlert }) {
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState(null);
  const [pdfDone, setPdfDone] = useState(false);
  const [kmlDone, setKmlDone] = useState(false);

  const phaseLabel = usePdfPhase(pdfLoading);

  const hasItinerary = !!(itinerary?.days?.length);
  const kmlPlaces = countKmlPlaces(itinerary);

  const destKey = itinerary?.destination || "default";
  const checklistChecked = loadChecklistState(destKey);
  const checklistItems = CHECKLIST_DEFAULT_ITEMS.map((it) => ({
    ...it,
    checked: !!checklistChecked[it.key],
  }));

  async function handleExportPdf() {
    // flushSync forces React to paint the loading state BEFORE the async
    // fetch starts — without it React 18 batching can skip the intermediate
    // loading render entirely if the request resolves quickly.
    flushSync(() => {
      setPdfError(null);
      setPdfDone(false);
      setPdfLoading(true);
    });
    try {
      await exportPdf({
        itinerary,
        visaData: visaAlert || null,
        checklistItems,
      });
      setPdfDone(true);
      setTimeout(() => setPdfDone(false), 4000);
    } catch (err) {
      setPdfError(err.message || "PDF export failed");
    } finally {
      setPdfLoading(false);
    }
  }

  function handleExportKml() {
    setKmlDone(false);
    downloadKml(itinerary);
    setKmlDone(true);
    setTimeout(() => setKmlDone(false), 3000);
  }

  return (
    <div className="export-panel">
      <div className="export-panel-header">
        <span className="export-panel-bracket">◢</span>
        <span className="export-panel-title">EXPORT TRIP</span>
        {itinerary?.destination && (
          <span className="export-panel-dest">
            {itinerary.origin && `${itinerary.origin} → `}{itinerary.destination}
          </span>
        )}
      </div>

      {!hasItinerary && (
        <div className="export-empty">
          <p>Complete your trip plan first — PLAN → FLIGHTS → HOTELS → DAYS — then come back to export.</p>
        </div>
      )}

      <div className="export-cards">
        {/* ── PDF Export Card ──────────────────────────────── */}
        <div className={`export-card${!hasItinerary ? " export-card--disabled" : ""}`}>
          <div className="export-card-icon">📄</div>
          <div className="export-card-body">
            <div className="export-card-title">TRIP DOCUMENT (PDF)</div>
            <div className="export-card-desc">
              Click <strong>Download PDF</strong> to generate a clean, printable document
              with your full itinerary — ready for customs, hotels, and offline use.
              Generation takes ~15–20 seconds while photos are fetched.
            </div>

            <ul className="export-card-includes">
              {visaAlert && <li>✓ Visa requirements ({itinerary?.destination})</li>}
              {itinerary?.flight && <li>✓ Flight details</li>}
              {(itinerary?.selected_hotel || itinerary?.hotels?.length > 0) && <li>✓ Hotel + photo</li>}
              {itinerary?.days?.length > 0 && (
                <li>✓ {itinerary.days.length}-day itinerary with directions + activity photos</li>
              )}
              <li>✓ Pre-trip checklist ({checklistItems.filter(i => i.checked).length}/{checklistItems.length} done)</li>
              {itinerary?.phrasebook && <li>✓ Phrasebook ({itinerary.phrasebook.language})</li>}
            </ul>

            {/* Loading progress */}
            {pdfLoading && (
              <div className="export-progress">
                <span className="export-spinner" aria-hidden="true" />
                <span className="export-progress-label">{phaseLabel}</span>
              </div>
            )}

            {pdfError && (
              <div className="export-error">{pdfError}</div>
            )}

            <button
              type="button"
              className={`export-btn${pdfDone ? " export-btn--done" : ""}`}
              onClick={handleExportPdf}
              disabled={pdfLoading}
            >
              {pdfLoading
                ? <><span className="export-btn-spinner" aria-hidden="true" /> Generating…</>
                : pdfDone
                ? "✓ Downloaded"
                : "Download PDF"}
            </button>
          </div>
        </div>

        {/* ── KML Export Card ──────────────────────────────── */}
        <div className={`export-card${!hasItinerary ? " export-card--disabled" : ""}`}>
          <div className="export-card-icon">🗺</div>
          <div className="export-card-body">
            <div className="export-card-title">GOOGLE MAPS BOOKMARKS (KML)</div>
            <div className="export-card-desc">
              Click <strong>Download KML</strong> to save all trip places as a file you can
              import into <strong>Google My Maps</strong> or <strong>Google Earth</strong>.
              Instant — no server call needed.
            </div>

            {kmlPlaces > 0 && (
              <ul className="export-card-includes">
                <li>✓ {kmlPlaces} place{kmlPlaces !== 1 ? "s" : ""} — airports, hotel, and daily activities</li>
                <li>✓ Organised into folders by day</li>
              </ul>
            )}

            <div className="export-card-hint">
              After download: <em>Google My Maps → Create a new map → Import</em> → select the .kml file.
            </div>

            <button
              type="button"
              className={`export-btn${kmlDone ? " export-btn--done" : ""}`}
              onClick={handleExportKml}
            >
              {kmlDone
                ? "✓ Downloaded"
                : `Download KML${kmlPlaces > 0 ? ` (${kmlPlaces} places)` : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
