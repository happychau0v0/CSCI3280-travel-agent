#!/usr/bin/env python3
"""Download the OpenFlights airports dataset and write a filtered JSON.

Usage:
    cd backend && python scripts/fetch_airports.py

Output: app/data/airports.json
Filters: must have a valid 3-letter IATA code (not \\N) and type == "airport".
"""
import csv
import json
import pathlib
import urllib.request

URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat"
OUT = pathlib.Path(__file__).parent.parent / "app" / "data" / "airports.json"

FIELDS = (
    "id", "name", "city", "country",
    "iata", "icao", "lat", "lng",
    "alt", "tz", "dst", "tz_db", "type", "source",
)


def main() -> None:
    print(f"Fetching {URL} …")
    with urllib.request.urlopen(URL) as resp:
        content = resp.read().decode("utf-8")

    airports = []
    for row in csv.DictReader(content.splitlines(), fieldnames=FIELDS):
        iata = row["iata"].strip()
        if not iata or iata == r"\N" or len(iata) != 3:
            continue
        if row["type"] != "airport":
            continue
        try:
            lat = round(float(row["lat"]), 4)
            lng = round(float(row["lng"]), 4)
        except ValueError:
            continue
        airports.append({
            "iata": iata.upper(),
            "name": row["name"].strip(),
            "city": row["city"].strip(),
            "country": row["country"].strip(),
            "lat": lat,
            "lng": lng,
        })

    airports.sort(key=lambda a: a["iata"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(airports, ensure_ascii=False, indent=2))
    print(f"Wrote {len(airports)} airports → {OUT}")


if __name__ == "__main__":
    main()
