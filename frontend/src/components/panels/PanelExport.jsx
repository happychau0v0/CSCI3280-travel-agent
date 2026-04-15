import { useState } from "react";
import { exportPdf } from "../../api/client";
import { downloadKml, countKmlPlaces } from "../../utils/exportKml";

/**
 * EXPORT panel — 5th tab.
 *
 * Two export cards:
 *   1. PDF — backend-generated document via POST /export/pdf (weasyprint)
 *      Includes: visa requirements, flight, hotel, day-by-day itinerary,
 *      pre-trip checklist, phrasebook.
 *   2. Google Maps KML — client-side KML generation; downloads a .kml file
 *      that can be imported into Google My Maps or Google Earth.
 */

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

  const hasItinerary = !!(itinerary?.days?.length);
  const kmlPlaces = countKmlPlaces(itinerary);

  const destKey = itinerary?.destination || "default";
  const checklistChecked = loadChecklistState(destKey);
  const checklistItems = CHECKLIST_DEFAULT_ITEMS.map((it) => ({
    ...it,
    checked: !!checklistChecked[it.key],
  }));

  async function handleExportPdf() {
    setPdfError(null);
    setPdfDone(false);
    setPdfLoading(true);
    try {
      await exportPdf({
        itinerary,
        visaData: visaAlert || null,
        checklistItems,
      });
      setPdfDone(true);
      setTimeout(() => setPdfDone(false), 3000);
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
          <p>Complete your trip plan first — PLAN, FLIGHTS, HOTELS, and DAYS must all be filled in before you can export.</p>
        </div>
      )}

      <div className="export-cards">
        {/* ── PDF Export Card ──────────────────────────────── */}
        <div className={`export-card${!hasItinerary ? " export-card--disabled" : ""}`}>
          <div className="export-card-icon">📄</div>
          <div className="export-card-body">
            <div className="export-card-title">TRIP DOCUMENT (PDF)</div>
            <div className="export-card-desc">
              A clean, printable PDF with all trip details — ready for customs, hotels, and offline use.
            </div>
            <ul className="export-card-includes">
              {visaAlert && <li>✓ Visa requirements ({itinerary?.destination})</li>}
              {itinerary?.flight && <li>✓ Flight details</li>}
              {(itinerary?.selected_hotel || itinerary?.hotels?.length > 0) && <li>✓ Hotel</li>}
              {itinerary?.days?.length > 0 && (
                <li>✓ {itinerary.days.length}-day itinerary with directions</li>
              )}
              <li>✓ Pre-trip checklist ({checklistItems.filter(i => i.checked).length}/{checklistItems.length} done)</li>
              {itinerary?.phrasebook && <li>✓ Phrasebook ({itinerary.phrasebook.language})</li>}
            </ul>
            {pdfError && (
              <div className="export-error">{pdfError}</div>
            )}
            <button
              type="button"
              className="export-btn"
              onClick={handleExportPdf}
              disabled={pdfLoading}
            >
              {pdfLoading ? "Generating…" : pdfDone ? "✓ Downloaded" : "Download PDF"}
            </button>
          </div>
        </div>

        {/* ── KML Export Card ──────────────────────────────── */}
        <div className={`export-card${!hasItinerary ? " export-card--disabled" : ""}`}>
          <div className="export-card-icon">🗺</div>
          <div className="export-card-body">
            <div className="export-card-title">GOOGLE MAPS BOOKMARKS (KML)</div>
            <div className="export-card-desc">
              Download a <code>.kml</code> file with all your trip places. Import it into{" "}
              <strong>Google My Maps</strong> or <strong>Google Earth</strong> to get pinned
              locations organised by day.
            </div>
            {kmlPlaces > 0 && (
              <ul className="export-card-includes">
                <li>✓ {kmlPlaces} place{kmlPlaces !== 1 ? "s" : ""} across airports, hotel, and daily activities</li>
                <li>✓ Organised into folders by day</li>
              </ul>
            )}
            <div className="export-card-hint">
              After download: open{" "}
              <em>Google My Maps → Create a new map → Import</em> and select the .kml file.
            </div>
            <button
              type="button"
              className="export-btn"
              onClick={handleExportKml}
            >
              {kmlDone ? "✓ Downloaded" : `Download KML${kmlPlaces > 0 ? ` (${kmlPlaces} places)` : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
