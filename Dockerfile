# ============================================================
# 📦 FamilyTreeNow Stealth Scraper — Railway Dockerfile
# ============================================================

# Use Node 20 on Debian slim base
FROM node:20-bookworm-slim

# ------------------------------------------------------------
# 🧩 Install Chromium dependencies + bash
# ------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates fonts-liberation wget xdg-utils \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libpangocairo-1.0-0 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 \
    libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
 && rm -rf /var/lib/apt/lists/*

# Make sure playwright installs browsers into image
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
# 🔧 Make runner executable
# ------------------------------------------------------------
RUN chmod +x scripts/run_ftn.sh

# ------------------------------------------------------------
# 🚀 Default start command
# ------------------------------------------------------------
CMD ["bash", "scripts/run_ftn.sh"]
