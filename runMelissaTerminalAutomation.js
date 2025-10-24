//runMelissaTerminalAutomation
// used to run test for scraping locally. No need to use .env file or exports in command line. Just run  node runMelissaTerminalAutomation


const {chromium} = require("playwright");
const { personSearchAndScrape } = require('./melissaLookup');



async function runMelissaTerminalAutomation() {
    const browser = await chromium.launch({
        headless: false,
        channel: 'chrome', // use your installed Chrome.app
    });

    try {
        const result = await personSearchAndScrape(browser, {
            name: 'Emily Fung',
            city: 'Plano',
            state: 'TX',
            zip: ''
        });

        console.log('✅ Melissa result:', JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('❌ Melissa test failed:', err);
    } finally {
        await browser.close();
    }
}
if (require.main === module) {
    runMelissaTerminalAutomation()
        .then(() => {
            console.log('🎯 Automation completed');
            process.exit(0);
        })
        .catch(err => {
            console.error('💥 Fatal error:', err);
            process.exit(1);
        });
}
