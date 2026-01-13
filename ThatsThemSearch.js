require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* ---------------- Screenshot Helper ---------------- */
async function uploadScreenshot(page, label) {
    const tmpPath = path.join(os.tmpdir(), `${label}_${Date.now()}.png`);
    await page.screenshot({ path: tmpPath, fullPage: true });
    const res = await cloudinary.uploader.upload(tmpPath, { folder: 'thatsthem-screenshots' });
    console.log(`📸 Screenshot uploaded: ${res.secure_url}`);
    return res.secure_url;
}

/* ---------------- Scraper Core ---------------- */
async function scrapeThatsThem(name, city) {
    const searchUrl = `https://thatsthem.com/name/${encodeURIComponent(name).replace(/%20/g, '-')}/${encodeURIComponent(city).replace(/%20/g, '-')}`;
    console.log('🔍 Visiting:', searchUrl);

    const baseDefault = fs.existsSync('/data') ? '/data' : os.tmpdir();
    let profileDir = process.env.ND_PROFILE_DIR || path.join(baseDefault, `.thatsthem-profile`);
    fs.mkdirSync(profileDir, { recursive: true });

    const context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        viewport: { width: 1400, height: 900 },
        timezoneId: 'America/Chicago',
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });

    try {
        const page = await context.newPage();
        page.setDefaultTimeout(45000);

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000); // let it settle

        const screenshotUrl = await uploadScreenshot(page, name.replace(/\s+/g, '_'));

        // Try first card
        const result = await page.evaluate(() => {
            const card = document.querySelector('.card');
            if (!card) return null;

            const name = card.querySelector('.name a.web')?.innerText.trim();
            const age = card.querySelector('.age')?.innerText.trim();
            const phones = Array.from(card.querySelectorAll('.phone .number'))
                .map(n => n.innerText.trim())
                .filter(Boolean);

            return { name, age, phones };
        });

        if (!result) {
            console.log(`⚠️ No matching result selectors found for ${name}`);
            return { name: undefined, age: undefined, phones: [], screenshotUrl };
        }

        console.log('✅ Result:', result);
        return { ...result, screenshotUrl };

    } catch (err) {
        console.error(`❌ Error scraping ${name}:`, err.message);
        return null;
    } finally {
        await context.close();
    }
}

/* ---------------- Batch Runner ---------------- */
async function runBatch() {
    const queries = [
        { name: 'Mary McCormick', city: 'Carrollton-TX' },
        { name: 'Javier Villalobos', city: 'Frisco-TX' },
        { name: 'Shane Milburn', city: 'Plano-TX' },
    ];

    for (const q of queries) {
        const result = await scrapeThatsThem(q.name, q.city);
        console.log(JSON.stringify(result, null, 2));
        console.log('⏳ Waiting 1 minute before next query...');
        await new Promise(r => setTimeout(r, 60 * 1000));
    }
}

if (require.main === module) runBatch();
module.exports = scrapeThatsThem;
