# ============================================================
# 📦 FamilyTreeNow + Nextdoor Automation — Railway Dockerfile
# ============================================================

# Use Node 20 on Debian slim base
FROM node:20-bookworm-slim

# ------------------------------------------------------------
# 🧩 Install Chromium dependencies + virtual display support
# ------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates fonts-liberation wget xdg-utils \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libpangocairo-1.0-0 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 \
    libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
    xvfb xauth \
 && rm -rf /var/lib/apt/lists/*

# Make sure Playwright installs browsers into image
ENV PLAYWRIGHT_BROWSERS_PATH=0

# ------------------------------------------------------------
# 🏗️ Create working directory
# ------------------------------------------------------------
WORKDIR /app

# Copy dependency manifests first
COPY package*.json ./

# Install dependencies (production only)
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# ------------------------------------------------------------
# 🧠 Copy project files
# ------------------------------------------------------------
COPY . .

# ------------------------------------------------------------
# 🧱 Install Chromium binary
# ------------------------------------------------------------
RUN npx playwright install chromium

# ------------------------------------------------------------
# 📁 Ensure debug folder exists at runtime
# ------------------------------------------------------------
RUN mkdir -p /app/ftn_debug && chmod 777 /app/ftn_debug
ENV FTN_DEBUG_PATH=/app/ftn_debug

# ------------------------------------------------------------
# 🚀 Start command (Nextdoor Redlands automation)
# ------------------------------------------------------------
CMD bash -c '\
  mkdir -p /app/ftn_debug && chmod 777 /app/ftn_debug && \
  if command -v xvfb-run >/dev/null 2>&1; then \
    echo "🖥️  Starting with xvfb-run (virtual display)..."; \
    xvfb-run -a node runFamilyTreeRailwayAutomation.js; \
  else \
    echo "⚙️  xvfb not available — running headless mode."; \
    HEADLESS=1 node runFamilyTreeRailwayAutomation.js; \
  fi'
