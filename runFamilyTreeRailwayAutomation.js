// runFamilyTreeRailwayAutomation.js
// HEADLESS=1 node runFamilyTreeRailwayAutomation.js; \ change this code to  HEADLESS=1 node nextdoorAutomationRedlands.js; if it passes.
// 🔧 Used for testing FamilyTree scraping logic inside Railway with virtual display (Xvfb)
// CMD in Dockerfile will call xvfb-run automatically
// Just run in container:  node runFamilyTreeRailwayAutomation.js

const { chromium } = require('playwright');
const { runFamilyTreeStealth } = require('./runFamilyTreeStealth');

async function runFamilyTreeRailwayAutomation() {
    // 🧩 Static test parameters (same as local)
    const first = 'Emily';
    const last = 'Fung';
    const city = 'Plano';

    console.log(`🏗️  Running FamilyTreeNow Railway test for ${first} ${last} (${city})`);

    // --- Railway Chrome launch (non-headless) ---
    const browser = await chromium.launch({
        headless: false, // required for Xvfb display
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--use-gl=swiftshader',
            '--disable-software-rasterizer',
            '--window-size=1366,768',
        ],
    });

    try {
        // --- Call your production scraper logic ---
        const result = await runFamilyTreeStealth({ first, last, city, browser });

        console.log('\n✅ FamilyTreeNow Railway result:');
        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('❌ FamilyTree Railway test failed:', err);
    } finally {
        await browser.close().catch(() => {});
    }
}

// Allow standalone execution
if (require.main === module) {
    runFamilyTreeRailwayAutomation()
        .then(() => {
            console.log('🎯 FamilyTreeNow Railway automation complete.');
            process.exit(0);
        })
        .catch(err => {
            console.error('💥 Fatal error in FamilyTreeNow Railway automation:', err);
            process.exit(1);
        });
}
