#!/bin/bash
set -e
set -o pipefail

echo "🚀 Starting FamilyTreeNow stealth test runner..."
echo "📅 $(date)"
echo "🧩 Node version: $(node -v)"
echo "🧩 NPM version: $(npm -v)"
echo "🌐 Proxy: ${PROXY_LINE:-<none>}"
echo "🔑 2Captcha Key: ${TWOCAPTCHA_API_KEY:0:6}****"
echo "🎯 Target: ${TARGET_URL:-(dynamic via args)}"
echo "---------------------------------------------"

# Ensure log directory exists
mkdir -p ftn_debug

# Run the main script
echo "▶️ Running runFamilyTreeStealth.js..."
node runFamilyTreeStealth.js || {
  echo "❌ Script failed!"
  echo "🔍 Dumping recent ftn_debug files..."
  ls -lh ftn_debug || true
  exit 1
}

echo "✅ Script completed successfully."
echo "---------------------------------------------"

# Show latest logs for quick visibility
if [ -d "ftn_debug" ]; then
  echo "🧾 Listing debug artifacts:"
  ls -lt ftn_debug | head -n 10
fi

# Optional Cloudinary upload if credentials exist
if [[ -n "$CLOUDINARY_CLOUD_NAME" && -n "$CLOUDINARY_API_KEY" && -n "$CLOUDINARY_API_SECRET" ]]; then
  echo "☁️ Uploading latest screenshot(s) to Cloudinary..."
  LATEST_SCREENSHOT=$(ls -t ftn_debug/*.png 2>/dev/null | head -n 1)
  if [ -f "$LATEST_SCREENSHOT" ]; then
    node - <<'EOF'
      const cloudinary = require('cloudinary').v2;
      const fs = require('fs');
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
      });
      const latest = process.env.LATEST_SCREENSHOT;
      if (latest && fs.existsSync(latest)) {
        cloudinary.uploader.upload(latest, { folder: 'ftn_debug' })
          .then(res => console.log("✅ Uploaded:", res.secure_url))
          .catch(err => console.error("❌ Upload failed:", err.message));
      } else {
        console.log("ℹ️ No screenshot found to upload.");
      }
EOF
  else
    echo "ℹ️ No screenshots found for upload."
  fi
else
  echo "⚠️ Cloudinary upload skipped (no credentials set)."
fi

echo "🏁 Done."
