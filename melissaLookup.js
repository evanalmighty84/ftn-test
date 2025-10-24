// melissaLookup.js
// to run locally use the other file called runMelissaTerminalAutomation with a test name, state and city
require('dotenv').config();
const { chromium } = require('playwright');

const SIGNIN = 'https://apps.melissa.com/user/signin.aspx?src=https://lookups.melissa.com/home/';
const PEOPLE_SEARCH = 'https://lookups.melissa.com/home/personatorsearch/';
const TARGET_STATE = process.env.TERMINAL_TARGET_STATE; // to keep nextdoorAutomationRedlands.jS copyable
const TARGET_CITY = process.env.TERMINAL_TARGET_CITY; // to keep nextdoorAutomationRedlands.jS copyable



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

//MelissaLookup.Js
async function personSearchAndScrape(browser,   { name = '', city = process.env.TERMINAL_TARGET_CITY || '', state = process.env.TERMINAL_TARGET_STATE || '', zip = '' }) {
    console.log(state, "I'm  passing this to the personSerachAndScrape")
    const context = await browser.newContext({viewport: {width: 1400, height: 900}});
    const page = await context.newPage();

    await loginMelissa(page);
    await page.goto(PEOPLE_SEARCH, {waitUntil: 'domcontentloaded'});


    if (name) await page.fill('input[placeholder*="Full Name"], input[name="name"]', name).catch(() => {
    });
    if (city) await page.fill('input[name="city"], input[placeholder*="City"]', city).catch(() => {
    });
    if (zip) await page.fill('input[name="postalCode"], input[placeholder*="ZIP"]', zip).catch(() => {
    });
    if (state) await page.fill('input[name="state"], input[placeholder*="STATE"]', state).catch(() => {
        console.log(`found this ${state} as the state and inputed it`)
    });


    const submit = page.locator('input[type="submit"][value="Submit"], button:has-text("Submit")').first();
    await submit.waitFor({timeout: 5000});
    await submit.click();

    // Wait for results
    const rows = page.locator('table tbody tr');
    await rows.first().waitFor({timeout: 20000});

    const inputCity = city.toUpperCase();
    const inputName = name.toUpperCase();
    const allCities = new Set();
    const allNames = new Set();
    let foundCityRowIndex = -1;
    let foundStateRowIndex = -1;

// --- Pass 1: collect all cities + find direct city match ---
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
        const txt = (await rows.nth(i).innerText()).toUpperCase();

        // collect name text (first column or similar)
        const rowName = (await rows.nth(i).locator('td').first().innerText()).toUpperCase();
        allNames.add(rowName);

        // Collect cities seen in this state
        const match = txt.match(new RegExp(`([A-Z\\s]+)(?:,)?\\s+${state}\\b`));
        if (match && match[1]) allCities.add(match[1].trim().replace(/\s{2,}/g, ' '));

        // Look for direct city match
        const cityPattern = new RegExp(`\\b${inputCity}\\b`, 'i');
        if (cityPattern.test(txt)) {
            console.log(`✅ Found matching city ${inputCity} at row ${i}`);
            foundCityRowIndex = i;
            break;
        }

    }

// --- Pass 2: look for state match if city not found ---
    if (foundCityRowIndex === -1) {
        let found = false;
        for (let i = 0; i < count; i++) {
            const txt = (await rows.nth(i).innerText()).toUpperCase();
            console.log(`Row ${i}: ${txt}`);

            const st = (state || '').trim().toUpperCase();
            if (new RegExp(`\\b${st}\\b`).test(txt)) {
                console.log(`✅ Found matching state row (${state}) at index ${i}`);
                foundStateRowIndex = i;
                found = true;
                break;
            }
        }

        if (!found) console.log(`❌ Didn't find any rows containing state ${state}`);
    }

// --- AI Name filtering stage (only if we found state or city rows) ---
    if (foundStateRowIndex !== -1 || foundCityRowIndex !== -1) {
        console.log(`🧾 Candidate names on page: ${Array.from(allNames).join(', ')}`);

        const {OpenAI} = require('openai');
        const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

        let probableNames = [];
        let rationale = '';

        try {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content:
                            'You are an expert at determining whether two names refer to the same person, including nicknames and shortened versions (e.g. William ↔ Bill, Robert ↔ Bob). Always explain your reasoning briefly.'
                    },
                    {
                        role: 'user',
                        content: `Input name: "${inputName}". Candidate names: ${Array.from(allNames).join(', ')}.
Return a JSON object in the following format:
{"matches": [ARRAY OF MATCHING NAMES, UPPERCASE], "reason": "EXPLAIN WHY THESE NAMES MATCH OR NOT"}`
                    }
                ]
            });

            let raw = completion.choices[0].message.content.trim();
            raw = raw.replace(/```json|```/gi, '').trim();

            const parsed = JSON.parse(raw);
            probableNames = parsed.matches || [];
            rationale = parsed.reason || '';
        } catch (err) {
            console.warn('⚠️ Name AI check failed or returned invalid JSON:', err.message);
        }

        console.log(`🤝 Probable matching names: ${probableNames.join(', ') || '(none)'}`);
        if (rationale) console.log(`🧠 AI rationale: ${rationale}`);

        if (!probableNames.length) {
            console.log('❌ No name match found — aborting city logic.');
            return null;
        }


        // Filter down to rows that match one of these probable names
        const nameMatchedRows = [];
        for (let i = 0; i < count; i++) {
            const rowName = (await rows.nth(i).locator('td').first().innerText()).toUpperCase();
            if (probableNames.some(p => rowName.includes(p))) {
                nameMatchedRows.push(i);
            }
        }

        console.log(`🧩 Rows with matching/synonym names: ${nameMatchedRows.join(', ') || '(none)'}`);

        // If city match was already found, make sure that row also has a matching name
        if (foundCityRowIndex !== -1 && nameMatchedRows.includes(foundCityRowIndex)) {
            console.log(`✅ City + name match confirmed at row ${foundCityRowIndex}`);

            const link = rows
                .nth(foundCityRowIndex)
                .locator('a.btnAjax[href*="/home/personator/index"], a.btnAjax[href*="/home/mikpersoninfo/index"]')
                .first();

            if (await link.count()) {
                await Promise.all([
                    page.waitForLoadState('domcontentloaded'),
                    link.click()
                ]);
                console.log(`🎯 Clicked matching record at row ${foundCityRowIndex}`);
            } else {
                console.log('⚠️ No link found to click on the confirmed row.');
            }

            // Scrape details after click
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

            console.log('✅ Melissa result:', JSON.stringify(out, null, 2));
            return out;
        }


        // If state match found but city missing, continue to AI city fallback below
    }

// --- AI fallback if state found but city missing ---
// --- AI fallback if state found but city missing ---
    if (foundCityRowIndex === -1 && foundStateRowIndex !== -1 && allCities.size) {
        console.log(`🧭 No results for original city ${inputCity}, but found state ${state}. Checking nearby cities...`);

        const { OpenAI } = require('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const cityList = Array.from(allCities).join(', ');

        // Ask AI for the nearest city
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You pick the geographically closest city from a provided list.' },
                {
                    role: 'user',
                    content: `Cities: ${cityList}. Original city: ${inputCity}. Return only the name of the closest match.`
                }
            ]
        });

        const suggestedCity = completion.choices[0].message.content.trim().toUpperCase();
        console.log(`💡 Suggested nearby city: ${suggestedCity}`);

        // --- New: ask AI for approximate distance between the two cities ---
        let distanceMiles = Infinity;
        try {
            const distResp = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content:
                            'Estimate driving distance in miles between two US cities. Return only a number (integer).'
                    },
                    {
                        role: 'user',
                        content: `How many miles apart are ${inputCity}, ${state} and ${suggestedCity}, ${state}? Return only a number.`
                    }
                ]
            });

            const rawDist = distResp.choices[0].message.content.match(/\d+/);
            if (rawDist) distanceMiles = parseInt(rawDist[0], 10);
        } catch (err) {
            console.warn('⚠️ Distance lookup failed:', err.message);
        }

        console.log(`📏 Approx distance between ${inputCity} and ${suggestedCity}: ${distanceMiles} mi`);

        // --- Guardrail: skip if distance > 10 miles ---
        if (!Number.isFinite(distanceMiles) || distanceMiles > 10) {
            console.log(`🚫 Closest match ${suggestedCity} is ${distanceMiles} mi away (> 10 mi). Aborting.`);
            return null;
        }

        // --- Otherwise click the suggested city row ---
        const cityPattern = new RegExp(`\\b${suggestedCity}\\b`, 'i');
        for (let i = 0; i < count; i++) {
            const txt = (await rows.nth(i).evaluate(el => el.textContent)).toUpperCase();
            if (cityPattern.test(txt)) {
                const link = rows
                    .nth(i)
                    .locator(
                        'a.btnAjax[href*="/home/personator/index"], a.btnAjax[href*="/home/mikpersoninfo/index"]'
                    )
                    .first();

                if (await link.count()) {
                    await Promise.all([page.waitForLoadState('domcontentloaded'), link.click()]);
                    console.log(`✅ Clicked suggested city ${suggestedCity} (${distanceMiles} mi away)`);
                    break;
                } else {
                    console.log(`⚠️ No clickable link found in row ${i} (${suggestedCity})`);
                }
            }
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



module.exports = { personSearchAndScrape };


