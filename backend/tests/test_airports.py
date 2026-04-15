from app.tools.airports import lookup, search


# --- lookup() ---

def test_lookup_by_city_name():
    result = lookup("hong kong")
    assert result is not None
    assert result[0] == "HKG"


def test_lookup_city_with_country():
    result = lookup("Tokyo, Japan")
    assert result is not None
    assert result[0] in ("NRT", "HND")  # either Tokyo airport


def test_lookup_by_iata_code_direct():
    result = lookup("HKG")
    assert result is not None
    assert result[0] == "HKG"


def test_lookup_by_label_format():
    # "Name (IATA)" format stored by the combobox
    result = lookup("Hong Kong International (HKG)")
    assert result is not None
    assert result[0] == "HKG"


def test_lookup_unknown_city():
    assert lookup("not a real city xyz123") is None


# --- search() ---

def test_search_by_iata_exact():
    results = search("HKG")
    assert len(results) > 0
    assert results[0]["iata"] == "HKG"


def test_search_by_city_prefix():
    results = search("tok", limit=10)
    iatas = [r["iata"] for r in results]
    assert "NRT" in iatas or "HND" in iatas


def test_search_by_airport_name():
    results = search("heathrow", limit=5)
    assert len(results) > 0
    assert results[0]["iata"] == "LHR"


def test_search_returns_at_most_limit():
    results = search("a", limit=5)
    assert len(results) <= 5


def test_search_result_has_required_fields():
    results = search("HKG", limit=1)
    assert len(results) == 1
    r = results[0]
    assert all(k in r for k in ("iata", "name", "city", "country", "lat", "lng"))
