# ── Backend ────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS backend

WORKDIR /app

# Install OS deps needed by weasyprint (PDF export)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf2.0-0 \
    libffi-dev libcairo2 libharfbuzz0b libfontconfig1 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
COPY backend/requirements.lock .
RUN pip install --no-cache-dir -r requirements.txt -c requirements.lock

COPY backend/ .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

# ── Frontend build ──────────────────────────────────────────────────────────
FROM node:20-slim AS frontend-build

WORKDIR /app

# Docker serves frontend and API through one Nginx origin. A slash becomes an
# empty base in api/client.js, so browser requests stay same-origin.
ARG VITE_API_BASE=/
ENV VITE_API_BASE=${VITE_API_BASE}

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ .
RUN npm run build

# ── Nginx serving the built frontend ───────────────────────────────────────
FROM nginx:alpine AS frontend

COPY --from=frontend-build /app/dist /usr/share/nginx/html

# Proxy /api/* → backend so the SPA never makes cross-origin calls
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
