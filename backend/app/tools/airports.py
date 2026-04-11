"""Tiny IATA airport lookup table.

A small bundled list of major international airports keyed by city. Used by
flights.py to map "Tokyo" -> "NRT", "Hong Kong" -> "HKG", etc. without an
extra network round trip.

Source: hand-curated from openflights.org top airports by passenger traffic.
Add more entries as needed; the LLM can still call geocode_city as a
fallback for cities not in this list.
"""
from __future__ import annotations

# {city_lower: (iata, full_name, lat, lng)}
AIRPORTS: dict[str, tuple[str, str, float, float]] = {
    # Asia
    "hong kong": ("HKG", "Hong Kong International", 22.3080, 113.9185),
    "tokyo": ("NRT", "Tokyo Narita", 35.7720, 140.3929),
    "haneda": ("HND", "Tokyo Haneda", 35.5494, 139.7798),
    "osaka": ("KIX", "Osaka Kansai", 34.4347, 135.2440),
    "seoul": ("ICN", "Seoul Incheon", 37.4602, 126.4407),
    "beijing": ("PEK", "Beijing Capital", 40.0801, 116.5846),
    "shanghai": ("PVG", "Shanghai Pudong", 31.1443, 121.8083),
    "singapore": ("SIN", "Singapore Changi", 1.3644, 103.9915),
    "bangkok": ("BKK", "Bangkok Suvarnabhumi", 13.6900, 100.7501),
    "kuala lumpur": ("KUL", "Kuala Lumpur International", 2.7456, 101.7099),
    "taipei": ("TPE", "Taipei Taoyuan", 25.0777, 121.2328),
    "manila": ("MNL", "Manila Ninoy Aquino", 14.5086, 121.0194),
    "jakarta": ("CGK", "Jakarta Soekarno-Hatta", -6.1256, 106.6558),
    "ho chi minh city": ("SGN", "Ho Chi Minh Tan Son Nhat", 10.8188, 106.6519),
    "delhi": ("DEL", "Delhi Indira Gandhi", 28.5562, 77.1000),
    "mumbai": ("BOM", "Mumbai Chhatrapati Shivaji", 19.0896, 72.8656),
    "dubai": ("DXB", "Dubai International", 25.2532, 55.3657),
    "doha": ("DOH", "Doha Hamad", 25.2731, 51.6080),
    # Europe
    "london": ("LHR", "London Heathrow", 51.4700, -0.4543),
    "paris": ("CDG", "Paris Charles de Gaulle", 49.0097, 2.5479),
    "amsterdam": ("AMS", "Amsterdam Schiphol", 52.3105, 4.7683),
    "frankfurt": ("FRA", "Frankfurt", 50.0379, 8.5622),
    "madrid": ("MAD", "Madrid Barajas", 40.4719, -3.5626),
    "barcelona": ("BCN", "Barcelona El Prat", 41.2974, 2.0833),
    "rome": ("FCO", "Rome Fiumicino", 41.8003, 12.2389),
    "milan": ("MXP", "Milan Malpensa", 45.6306, 8.7281),
    "munich": ("MUC", "Munich", 48.3538, 11.7861),
    "zurich": ("ZRH", "Zurich", 47.4647, 8.5492),
    "vienna": ("VIE", "Vienna", 48.1102, 16.5697),
    "istanbul": ("IST", "Istanbul", 41.2753, 28.7519),
    "moscow": ("SVO", "Moscow Sheremetyevo", 55.9726, 37.4146),
    "athens": ("ATH", "Athens", 37.9364, 23.9445),
    "lisbon": ("LIS", "Lisbon", 38.7813, -9.1359),
    "copenhagen": ("CPH", "Copenhagen", 55.6181, 12.6561),
    "stockholm": ("ARN", "Stockholm Arlanda", 59.6519, 17.9186),
    "oslo": ("OSL", "Oslo Gardermoen", 60.1939, 11.1004),
    "helsinki": ("HEL", "Helsinki Vantaa", 60.3172, 24.9633),
    "dublin": ("DUB", "Dublin", 53.4213, -6.2701),
    # North America
    "new york": ("JFK", "New York JFK", 40.6413, -73.7781),
    "newark": ("EWR", "Newark", 40.6925, -74.1687),
    "los angeles": ("LAX", "Los Angeles", 33.9416, -118.4085),
    "san francisco": ("SFO", "San Francisco", 37.6213, -122.3790),
    "chicago": ("ORD", "Chicago O'Hare", 41.9742, -87.9073),
    "atlanta": ("ATL", "Atlanta Hartsfield", 33.6407, -84.4277),
    "miami": ("MIA", "Miami", 25.7959, -80.2870),
    "boston": ("BOS", "Boston Logan", 42.3656, -71.0096),
    "seattle": ("SEA", "Seattle Tacoma", 47.4502, -122.3088),
    "dallas": ("DFW", "Dallas Fort Worth", 32.8998, -97.0403),
    "denver": ("DEN", "Denver", 39.8561, -104.6737),
    "houston": ("IAH", "Houston Intercontinental", 29.9844, -95.3414),
    "washington": ("IAD", "Washington Dulles", 38.9531, -77.4565),
    "toronto": ("YYZ", "Toronto Pearson", 43.6777, -79.6248),
    "vancouver": ("YVR", "Vancouver", 49.1967, -123.1815),
    "mexico city": ("MEX", "Mexico City", 19.4361, -99.0719),
    # Oceania
    "sydney": ("SYD", "Sydney Kingsford Smith", -33.9399, 151.1753),
    "melbourne": ("MEL", "Melbourne Tullamarine", -37.6690, 144.8410),
    "auckland": ("AKL", "Auckland", -37.0082, 174.7917),
    "brisbane": ("BNE", "Brisbane", -27.3942, 153.1218),
    # South America
    "sao paulo": ("GRU", "Sao Paulo Guarulhos", -23.4356, -46.4731),
    "buenos aires": ("EZE", "Buenos Aires Ezeiza", -34.8222, -58.5358),
    "lima": ("LIM", "Lima Jorge Chavez", -12.0219, -77.1143),
    "rio de janeiro": ("GIG", "Rio Galeao", -22.8099, -43.2506),
    # Africa
    "johannesburg": ("JNB", "Johannesburg O.R. Tambo", -26.1392, 28.2460),
    "cape town": ("CPT", "Cape Town", -33.9648, 18.6017),
    "cairo": ("CAI", "Cairo", 30.1219, 31.4056),
    "nairobi": ("NBO", "Nairobi Jomo Kenyatta", -1.3192, 36.9278),
    "addis ababa": ("ADD", "Addis Ababa Bole", 8.9779, 38.7993),
}


def lookup(city: str) -> tuple[str, str, float, float] | None:
    """Find the IATA + name + coordinates for a city. Case-insensitive.

    Strips common suffixes ("airport", country names) so 'Tokyo, Japan' and
    'Tokyo Airport' both resolve to the same entry.
    """
    if not city:
        return None
    key = city.strip().lower()
    # Strip everything after the first comma — "Tokyo, Japan" -> "tokyo"
    if "," in key:
        key = key.split(",", 1)[0].strip()
    # Strip "airport" suffix
    if key.endswith(" airport"):
        key = key[: -len(" airport")]
    return AIRPORTS.get(key)


# Round 12 — alternate airports per metro area. Key is the primary
# city (as it appears in AIRPORTS); value is a list of (iata, name,
# lat, lng) tuples for OTHER nearby airports the user might consider.
# Kept small — the user's "please wait, is this close enough?" question
# is answered by the primary airport plus these alternates.
CITY_ALTERNATES: dict[str, list[tuple[str, str, float, float]]] = {
    "tokyo": [("HND", "Tokyo Haneda", 35.5494, 139.7798)],
    "osaka": [("ITM", "Osaka Itami (domestic)", 34.7854, 135.4383)],
    "seoul": [("GMP", "Seoul Gimpo", 37.5583, 126.7908)],
    "new york": [
        ("EWR", "Newark Liberty", 40.6925, -74.1687),
        ("LGA", "New York LaGuardia", 40.7769, -73.8740),
    ],
    "los angeles": [
        ("BUR", "Hollywood Burbank", 34.2007, -118.3587),
        ("LGB", "Long Beach", 33.8177, -118.1516),
    ],
    "san francisco": [
        ("OAK", "Oakland International", 37.7213, -122.2208),
        ("SJC", "San Jose International", 37.3626, -121.9290),
    ],
    "london": [
        ("LGW", "London Gatwick", 51.1537, -0.1821),
        ("STN", "London Stansted", 51.8860, 0.2389),
        ("LTN", "London Luton", 51.8747, -0.3683),
    ],
    "paris": [
        ("ORY", "Paris Orly", 48.7233, 2.3794),
        ("BVA", "Paris Beauvais", 49.4544, 2.1128),
    ],
    "milan": [
        ("LIN", "Milan Linate", 45.4451, 9.2767),
        ("BGY", "Bergamo Orio al Serio", 45.6739, 9.7042),
    ],
    "rome": [("CIA", "Rome Ciampino", 41.7994, 12.5949)],
    "moscow": [
        ("DME", "Moscow Domodedovo", 55.4088, 37.9063),
        ("VKO", "Moscow Vnukovo", 55.5914, 37.2615),
    ],
    "chicago": [("MDW", "Chicago Midway", 41.7868, -87.7522)],
    "washington": [
        ("DCA", "Reagan National", 38.8521, -77.0377),
        ("BWI", "Baltimore Washington", 39.1754, -76.6684),
    ],
    "houston": [("HOU", "Houston Hobby", 29.6454, -95.2788)],
    "toronto": [("YTZ", "Billy Bishop (downtown)", 43.6275, -79.3962)],
    "shanghai": [("SHA", "Shanghai Hongqiao", 31.1979, 121.3363)],
    "beijing": [("PKX", "Beijing Daxing", 39.5098, 116.4105)],
    "taipei": [("TSA", "Taipei Songshan (downtown)", 25.0697, 121.5519)],
    "istanbul": [("SAW", "Istanbul Sabiha Gokcen", 40.8986, 29.3092)],
    "dubai": [
        ("DWC", "Dubai Al Maktoum", 24.8966, 55.1614),
        ("AUH", "Abu Dhabi (alternate metro)", 24.4330, 54.6511),
    ],
    "bangkok": [("DMK", "Bangkok Don Mueang", 13.9130, 100.6066)],
}


def lookup_alternates(city: str) -> list[tuple[str, str, float, float]]:
    """Return alternate airports near a given city, or [] if none.

    Uses the same normalization as `lookup` so "Tokyo, Japan" and
    "Tokyo" both map to the same alternates list.
    """
    if not city:
        return []
    key = city.strip().lower()
    if "," in key:
        key = key.split(",", 1)[0].strip()
    if key.endswith(" airport"):
        key = key[: -len(" airport")]
    return CITY_ALTERNATES.get(key, [])
