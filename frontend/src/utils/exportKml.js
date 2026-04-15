/**
 * KML export utility for the EXPORT panel.
 *
 * Generates a KML 2.2 file from the current itinerary, organised into folders:
 *   - Airports   (origin + destination)
 *   - Hotel      (selected or first hotel)
 *   - Day 1 … N  (activities with lat/lng)
 *
 * No dependencies — pure string generation + browser Blob download.
 */

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function placemark(name, description, lat, lng) {
  if (lat == null || lng == null) return "";
  return `
    <Placemark>
      <name>${esc(name)}</name>
      ${description ? `<description>${esc(description)}</description>` : ""}
      <Point>
        <coordinates>${lng},${lat},0</coordinates>
      </Point>
    </Placemark>`;
}

function folder(name, content) {
  if (!content.trim()) return "";
  return `
  <Folder>
    <name>${esc(name)}</name>
    ${content}
  </Folder>`;
}

/**
 * Build a KML document string from an itinerary object.
 * @param {object} itinerary - the currentItinerary state object
 * @returns {string} KML XML string
 */
export function generateKml(itinerary) {
  if (!itinerary) return "";

  const flight = itinerary.flight || null;
  const hotel =
    itinerary.selected_hotel || itinerary.hotels?.[0] || null;
  const days = itinerary.days || [];
  const title = itinerary.title || itinerary.destination || "Trip";

  // ── Airports folder ─────────────────────────────
  let airportPins = "";
  if (flight?.from_lat != null && flight?.from_lng != null) {
    airportPins += placemark(
      `${flight.from_iata} – ${flight.from_city || flight.from_name || "Origin"}`,
      `Departure airport${flight.date ? ` · ${flight.date}` : ""}`,
      flight.from_lat,
      flight.from_lng,
    );
  }
  if (flight?.to_lat != null && flight?.to_lng != null) {
    airportPins += placemark(
      `${flight.to_iata} – ${flight.to_city || flight.to_name || "Destination"}`,
      `Arrival airport${flight.date ? ` · ${flight.date}` : ""}`,
      flight.to_lat,
      flight.to_lng,
    );
  }

  // ── Hotel folder ─────────────────────────────────
  let hotelPin = "";
  if (hotel?.lat != null && hotel?.lng != null) {
    hotelPin = placemark(
      hotel.name,
      [hotel.address, hotel.rating ? `★ ${hotel.rating.toFixed(1)}` : null]
        .filter(Boolean)
        .join(" · "),
      hotel.lat,
      hotel.lng,
    );
  }

  // ── Day folders ──────────────────────────────────
  const dayFolders = days.map((day) => {
    const activities = (day.activities || []).filter(
      (a) => a.lat != null && a.lng != null,
    );
    if (!activities.length) return "";

    const pins = activities
      .map((act, idx) =>
        placemark(
          `${idx + 1}. ${act.time} – ${act.name}`,
          [act.address, act.description, act.duration_min ? `${act.duration_min} min` : null]
            .filter(Boolean)
            .join("\n"),
          act.lat,
          act.lng,
        ),
      )
      .join("");

    const folderName = [
      `Day ${day.day}`,
      day.date,
      day.theme,
    ]
      .filter(Boolean)
      .join(" · ");

    return folder(folderName, pins);
  });

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(title)}</name>
    <description>Trip itinerary exported from CSCI3280 Travel Agent</description>
    ${folder("Airports", airportPins)}
    ${folder("Hotel", hotelPin)}
    ${dayFolders.join("")}
  </Document>
</kml>`;

  return kml;
}

/**
 * Count the total number of pins that will be in the KML file.
 * Useful for showing "X places" in the UI before download.
 */
export function countKmlPlaces(itinerary) {
  if (!itinerary) return 0;
  const flight = itinerary.flight || null;
  const hotel = itinerary.selected_hotel || itinerary.hotels?.[0] || null;
  const days = itinerary.days || [];

  let count = 0;
  if (flight?.from_lat != null) count++;
  if (flight?.to_lat != null) count++;
  if (hotel?.lat != null) count++;
  for (const day of days) {
    count += (day.activities || []).filter((a) => a.lat != null && a.lng != null).length;
  }
  return count;
}

/**
 * Generate KML and trigger a browser file download.
 * @param {object} itinerary
 */
export function downloadKml(itinerary) {
  const kml = generateKml(itinerary);
  if (!kml) return;

  const dest = (itinerary?.destination || "trip")
    .replace(/\s+/g, "-")
    .toLowerCase();
  const filename = `itinerary-${dest}.kml`;

  const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
