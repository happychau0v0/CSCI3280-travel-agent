.PHONY: test smoke live bench-flights bench-chat bench-models check-all

PY := .venv/bin/python
PYTEST := .venv/bin/pytest

test:
	$(PYTEST) -q

smoke:
	$(PY) scripts/smoke_tools.py

live:
	RUN_LIVE=1 $(PYTEST) tests/test_live_llm.py -v -s

bench-flights:
	$(PY) scripts/bench_flights.py

bench-chat:
	$(PY) scripts/bench_chat.py

bench-models:
	$(PY) scripts/bench_models.py

check-all: test smoke
