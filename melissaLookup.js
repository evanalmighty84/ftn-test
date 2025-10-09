// melissaLookup.js
require('dotenv').config();
const { chromium } = require('playwright');

const SIGNIN = 'https://apps.melissa.com/user/signin.aspx?src=https://lookups.melissa.com/home/';
const PEOPLE_SEARCH = 'https://lookups.melissa.com/home/personatorsearch/';

async function loginMelissa(page) {
    await page.goto(SIGNIN, { waitUntil: 'domcontentloaded' });
    if (await page.locator('#ctl00_ContentPlaceHolder1_Signin1_txtEmail').count()) {
        await page.fill('#ctl00_ContentPlaceHolder1_Signin1_txtEmail', process.env.MELISSA_USERNAME);
        const pwdSel = '#ctl00_ContentPlaceHolder1_Signin1_txtPassword, input[type="password"]';
        await page.fill(pwdSel, process.env.MELISSA_PASSWORD);
        await Promise.all([
            page.waitForLoadState('domcontentloaded'),
            page.click('#ctl00_ContentPlaceHolder1_Signin1_btnLogin')
        ]);
    }
}

// --- Helper: force the State to TX across select/input/combobox variants ---
async function forceStateTX(page, abbr = 'TX', full = 'Texas') {
    // 1) Plain <select>
    const selects = [
        'select[name="state"]',
        'select[name="stateabbr"]',
        'select#state',
        'select#stateabbr'
    ];
    for (const sel of selects) {
        if (await page.locator(sel).count()) {
            try {
                await page.selectOption(sel, { value: abbr }).catch(async () => {
                    await page.selectOption(sel, { label: full });
                });
                const val = await page.$eval(sel, el => (el.value || '').toUpperCase());
                if (val === abbr) return true;
            } catch {}
        }
    }

    // 2) Text inputs
    const inputs = [
        'input[name="state"]',
        'input[name="stateabbr"]',
        'input[placeholder*="State" i]'
    ];
    for (const sel of inputs) {
        if (await page.locator(sel).count()) {
            try { await page.fill(sel, abbr); return true; } catch {}
        }
    }

    // 3) ARIA combobox style
    const combo = page.locator('[role="combobox"][aria-haspopup="listbox"]');
    if (await combo.count()) {
        try {
            await combo.click();
            await page.keyboard.type(full);
            await page.keyboard.press('Enter');
            return true;
        } catch {}
    }

    return false;
}



// --- Main lookup with TX forcing + TX-row preference ---
async function personSearchAndScrape(browser, { name, city = '', state = 'TX', zip = '' }) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();

    await loginMelissa(page);
    await page.goto(PEOPLE_SEARCH, { waitUntil: 'domcontentloaded' });

    // Fill inputs
    const nameInput = page.locator('input[placeholder*="Full Name"], input[name="name"]');
    await nameInput.first().waitFor();
    await nameInput.first().fill(name);

    if (city) await page.fill('input[name="city"], input[placeholder*="City"]', city).catch(() => {});
    if (zip)  await page.fill('input[name="postalCode"], input[placeholder*="ZIP"]', zip).catch(() => {});

    // Force TX regardless of control type
    if (state) await forceStateTX(page, state, 'Texas');

    // (optional) log what we think it is
    try {
        const sVal = await page.evaluate(() => {
            const sel = document.querySelector('select[name="state"],select[name="stateabbr"]');
            if (sel) return sel.value || '';
            const inp = document.querySelector('input[name="state"],input[name="stateabbr"]');
            return inp ? inp.value || '' : '';
        });
        console.log('🧭 Melissa state set to:', sVal || '(unknown)');
    } catch {}

    // Submit
    const submit = page.locator('input[type="submit"][value="Submit"], button:has-text("Submit")').first();
    await submit.waitFor({ timeout: 15000 });
    await submit.click();

    // Wait for results
    const rows = page.locator('table tbody tr');
    await rows.first().waitFor({ timeout: 20000 });

    // Prefer a TX row
    let clicked = false;
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
        const txt = (await rows.nth(i).innerText()).toUpperCase();
        if (txt.includes(' TX ') || txt.endsWith(' TX') || txt.includes(' TX-')) {
            const link = rows
                .nth(i)
                .locator('a.btnAjax[href*="/home/personator/index"], a.btnAjax[href*="/home/mikpersoninfo/index"]')
                .first();
            if (await link.count()) {
                await Promise.all([page.waitForLoadState('domcontentloaded'), link.click()]);
                clicked = true;
                break;
            }
        }
    }

    // Fallback: first detail link
    if (!clicked) {
        const nameLink = page.locator('a.btnAjax[href*="/home/personator/index"]').first();
        const mikLink  = page.locator('a.btnAjax[href*="/home/mikpersoninfo/index"]').first();
        if (await nameLink.count()) {
            await Promise.all([page.waitForLoadState('domcontentloaded'), nameLink.click()]);
        } else if (await mikLink.count()) {
            await Promise.all([page.waitForLoadState('domcontentloaded'), mikLink.click()]);
        } else {
            return { phone: null, email: null, physical_address: null };
        }
    }

    // Scrape detail
    const out = { phone: null, email: null, physical_address: null };

    try {
        const phoneEl = page.locator('a[href*="/home/phonecheck?phone="]').first();
        if (await phoneEl.count()) out.phone = (await phoneEl.innerText()).trim();
    } catch {}

    try {
        const emailEl = page.locator('a[href*="/home/emailcheck"], a[href^="mailto:"]').first();
        if (await emailEl.count()) {
            const t = (await emailEl.innerText()) || (await emailEl.getAttribute('href')) || '';
            out.email = t.replace(/^mailto:/, '').trim();
        }
    } catch {}

    try {
        const addr = await page
            .locator('xpath=//td[normalize-space(text())="Address"]/following-sibling::td[1]')
            .innerText();
        out.physical_address = addr.trim();
    } catch {}

    return out;
}


async function runMelissaAutomation() {
    const browser = await chromium.launch({ headless: false });
    try {
        const result = await personSearchAndScrape(browser, {
            name: 'Suzy Andrus',
            city: 'Wylie',
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

module.exports = { personSearchAndScrape, runMelissaAutomation };


