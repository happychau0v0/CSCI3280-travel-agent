# Contributing

TravelMind is a course project and portfolio prototype. Keep changes focused, preserve the documented planning contracts, and run the relevant checks before opening a pull request or sharing a commit.

## Local setup

```bash
cp .env.example .env

cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt -c requirements.lock

cd ../frontend
npm ci
```

Start both applications with `./scripts/dev.sh`, then open <http://localhost:5173>.

For a local container deployment, configure `.env` and run `docker compose up --build`; open <http://localhost>.

## Verification

```bash
cd backend
source .venv/bin/activate
pytest
ruff check .

cd ../frontend
npm run test:run
npm run lint
npm run build
```

Run the five Playwright spec files against a running development server with `cd frontend && npm run test:e2e`.

## Project conventions

- Update [`docs/design.md`](docs/design.md) and [`docs/llm-spec.md`](docs/llm-spec.md) in the same change when altering planning behaviour, prompts, tool allow-lists, or UI state flow.
- Preserve the three planning stages and their fixed tool scopes unless the design and test coverage change with them.
- Treat LLM output as untrusted: validate structured responses and keep place, route, weather, and fare data grounded in tools.
- Keep secrets in `.env`; do not commit API keys, private certificates, local paths, or generated runtime output.
- Use focused conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, or `chore:`), with each commit left in a runnable state.

## Browser smoke check

For changes to panels, maps, prompt output, or streaming, manually verify the PLAN → FLIGHTS → HOTELS → DAYS flow at 1440×900 and 1024×600. Confirm that overlays close with `Esc`, maps render, the browser console is clean, and the chat/voice controls remain usable.
