const CITY = 'Wylie';
const STATE = 'TX';


require('dotenv').config();
const path = require('path');
const { chromium } = require('playwright');
const OpenAI = require('openai');
const pool = require('./db/db');
const fs = require('fs');
const { personSearchAndScrape } = require('./melissaLookup');
const { postLeadAlert } = require('./leadAlertClient');
const { runFamilyTreeStealth } = require('./runFamilyTreeStealth');
const { getLatestVerificationCodeFromEmail } = require('./iMap2fa');




const cloudinary = require('cloudinary').v2;
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const os = require("os");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });




SEARCH_TERMS = [
    // 🏊 Pool
    { label: 'Pool Repair', query: 'pool repair', type: 'pool', needsMostRecent: true },
    { label: 'Pool Maintenance', query: 'pool maintenance', type: 'pool', needsMostRecent: true },
    { label: 'Pool Leak', query: 'pool leak', type: 'pool', needsMostRecent: true },

    // 🧰 General Trades
    { label: 'Handyman', query: 'handyman', type: 'handyman', needsMostRecent: true },
    { label: 'Plumber', query: 'plumber', type: 'plumber', needsMostRecent: true },
    { label: 'Electrician', query: 'electrician', type: 'electrician', needsMostRecent: true },
    { label: 'Painter', query: 'painter', type: 'painter', needsMostRecent: true },
    { label: 'Roofer', query: 'roofer', type: 'roofer', needsMostRecent: true },
    { label: 'General Contractor', query: 'general contractor', type: 'general_contractor', needsMostRecent: true },
    { label: 'HVAC', query: 'hvac', type: 'hvac', needsMostRecent: true },

    // 🧹 Home Services
    { label: 'House Cleaner', query: 'house cleaner', type: 'house_cleaner', needsMostRecent: true },
    { label: 'Junk Removal', query: 'junk removal', type: 'junk_removal', needsMostRecent: true },
    { label: 'Pest Control', query: 'pest control', type: 'pest_control', needsMostRecent: true },

    // 🌿 Outdoor
    { label: 'Lawn Care', query: 'lawn care', type: 'lawn_care', needsMostRecent: true },
    { label: 'Tree Trimming', query: 'tree trimming', type: 'lawn_care', needsMostRecent: true },
    { label: 'Windows', query: 'window cleaning', type: 'windows', needsMostRecent: true },
    { label: 'Power Washing', query: 'power washing', type: 'power_washing', needsMostRecent: true },
    { label: 'Fencing', query: 'fence repair', type: 'fencing', needsMostRecent: true },

    // 🏠 Specialty Services
    { label: 'Interior Designer', query: 'kitchen remodel', type: 'interior_designer', needsMostRecent: true },
    { label: 'Bathroom Remodel', query: 'bathroom remodel', type: 'interior_designer', needsMostRecent: true },
    { label: 'Christmas Lights', query: 'christmas lights', type: 'christmas_lights', needsMostRecent: true },

    // 🐾 Personal / Real Estate
    { label: 'Pet Sitter', query: 'pet sitter', type: 'pet_sitter', needsMostRecent: true },
    { label: 'Realtor', query: 'realtor', type: 'realtor', needsMostRecent: true },
    { label: 'Mover', query: 'mover', type: 'mover', needsMostRecent: true },
    { label: 'Lawyer', query: 'lawyer', type: 'lawyer', needsMostRecent: true },
];





const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


const FEED_SEL =
    '[data-testid="home-feed"], input[aria-label="Search Nextdoor"], main[role="main"]';

async function waitForFeed(page, totalMs = 90_000) {
    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
        // feed visible?
        if (await page.locator(FEED_SEL).first().count()) return true;

        // address interstitial?
        if (/\/choose_address/i.test(page.url())) {
            console.log('ℹ️ Address interstitial detected — attempting to skip');
            await skipAddressIfPresent(page);
            await page.waitForTimeout(1500);
        }

        // stuck on login? shove to feed again
        if (/\/login/i.test(page.url())) {
            await page.goto('https://nextdoor.com/news_feed/', { waitUntil: 'domcontentloaded' }).catch(() => {});
            await page.waitForTimeout(2000);
        } else {
            // let SPA settle
            await page.waitForTimeout(1500);
        }
    }
    return false;
}


/** Wipe cookies + site storage for Nextdoor so each run is “clean”. */
async function clearNextdoorStorage(context, phase = 'startup') {
    try {
        // 1) Cookies/permissions at the context level
        await context.clearCookies();
        await context.clearPermissions();

        // 2) Open a temp page on Nextdoor origin to clear localStorage/sessionStorage/indexedDB/caches
        const p = await context.newPage();
        await p.goto('https://nextdoor.com/', { waitUntil: 'domcontentloaded' });
        await p.evaluate(async () => {
            try { localStorage.clear(); } catch {}
            try { sessionStorage.clear(); } catch {}
            try {
                if (indexedDB && indexedDB.databases) {
                    const dbs = await indexedDB.databases();
                    for (const db of dbs) {
                        if (db && db.name) {
                            try { indexedDB.deleteDatabase(db.name); } catch {}
                        }
                    }
                }
            } catch {}
            try {
                if (typeof caches !== 'undefined' && caches.keys) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map(k => caches.delete(k)));
                }
            } catch {}
        });
        await p.close();
        //test2
        console.log(`🧼 Cleared Nextdoor storage (${phase}).`);
    } catch (e) {
        console.warn(`⚠️ Failed to clear storage (${phase}):`, e.message);
    }
}




async function ensureLoggedIn(page) {
    console.log("🚪 Starting ensureLoggedIn()...");

    // 1️⃣ Try direct feed first
    await page.goto("https://nextdoor.com/news_feed/", { waitUntil: "domcontentloaded" });
    if (await page.locator(FEED_SEL).first().count()) {
        console.log("✅ Already on feed");
        return;
    }

    // 2️⃣ Go to login
    await page.goto("https://nextdoor.com/login/?next=/news_feed/", { waitUntil: "domcontentloaded" });
    if (await page.locator('text=New here? Join Nextdoor').first().count()) {
        console.log("ℹ️ Got join splash, forcing login form…");
        await page.goto("https://nextdoor.com/login/?allow_login=true&next=/news_feed/", {
            waitUntil: "domcontentloaded",
        });
        await page.waitForTimeout(1200);
    }

    // 3️⃣ Cookie consent (best-effort)
    try {
        await page
            .locator(
                [
                    'button:has-text("Accept")',
                    'button:has-text("I agree")',
                    'button:has-text("Allow all")',
                    '[data-testid="cookie-accept"]',
                ].join(",")
            )
            .first()
            .click({ timeout: 1500 });
    } catch {}

    // 4️⃣ Find form fields
    const emailSel = await (async () => {
        for (const s of [
            'input[data-testid="email-address-input"]',
            'input[name="email"]',
            'input[type="email"]',
            'input[placeholder*="Email" i]',
        ])
            if (await page.locator(s).first().count()) return s;
        return null;
    })();

    const passSel = await (async () => {
        for (const s of [
            'input[data-testid="password-input"]',
            'input[name="password"]',
            'input[type="password"]',
            'input[placeholder*="Password" i]',
        ])
            if (await page.locator(s).first().count()) return s;
        return null;
    })();

    const btnSel = await (async () => {
        for (const s of [
            'button[data-testid="signin_button"]',
            'button:has-text("Log in")',
            'button:has-text("Sign in")',
            'button[type="submit"]',
        ])
            if (await page.locator(s).first().count()) return s;
        return null;
    })();

    // 5️⃣ Fallback if no form
    if (!emailSel || !passSel || !btnSel) {
        console.log("ℹ️ Login form not found, checking feed/interstitial…");
        if (await waitForFeed(page, 30_000)) {
            console.log("✅ Feed became visible without manual login");
            return;
        }
        throw new Error("Login form not found (and feed did not appear).");
    }

    console.log(`🔐 Filling login: email="${emailSel}", pass="${passSel}", btn="${btnSel}"`);
    await page.locator(emailSel).click();
    await page.keyboard.type(process.env.NEXTDOOR_USERNAME, { delay: 40 });
    await page.locator(passSel).click();
    await page.keyboard.type(process.env.NEXTDOOR_PASSWORD, { delay: 45 });

    // 6️⃣ Submit login
    console.log("🖱️ Clicking sign-in and waiting for redirect or verification step...");
    await Promise.race([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null),
        (async () => {
            await page.click(btnSel, { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(3000);
        })(),
    ]);

    // 7️⃣ Extended verification detection (email or phone)
    const verificationSelector =
        'input[name="verification_code"], input[data-testid="verify-code-input"], input.blocks-rrao5z, input[type="tel"], input[placeholder*="code" i], input[aria-label*="code" i]';

    await page.waitForTimeout(2500);
    let codeInputs = [];
    try {
        codeInputs = await page.$$(verificationSelector);
    } catch (err) {
        console.warn("⚠️ Skipped verification check due to navigation race:", err.message);
    }

    if (codeInputs.length > 0) {
        console.log(`🔔 Detected ${codeInputs.length} verification input(s) — fetching 6-digit code...`);
        const code = await getLatestVerificationCodeFromEmail({
            pollIntervalMs: 2500,
            pollTimeoutMs: 120000, // 2 minutes max
        });
        if (!code) throw new Error("No verification code received via email!");
        console.log("🔐 Got code:", code);

        // fill code
        if (codeInputs.length >= 4) {
            console.log(`🧩 Typing each digit into ${codeInputs.length} boxes...`);
            for (let i = 0; i < Math.min(code.length, codeInputs.length); i++) {
                await codeInputs[i].focus();
                await page.keyboard.type(code[i]);
                await page.waitForTimeout(100);
            }
        } else {
            await codeInputs[0].fill(code);
        }

        const contBtn = page.locator('button:has-text("Continue"), button:has-text("Verify")');
        if (await contBtn.count()) {
            console.log("✅ Clicking Continue after verification...");
            await Promise.all([
                page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null),
                contBtn.first().click(),
            ]);
        }

        await page.waitForTimeout(4000);
    }

    // 8️⃣ Force cookie persist and reload
    await page.context().storageState({ path: path.join(os.tmpdir(), "nextdoor_state.json") });
    console.log("💾 Saved session state to temp file — reloading page...");
    await page.reload({ waitUntil: "domcontentloaded" });

    // 9️⃣ Wait for feed
    const ok = await waitForFeed(page, 90_000);
    console.log("➡️ Post-login URL:", page.url());

    if (ok) {
        console.log("✅ Feed visible after login");
        return;
    }

    console.log("⏳ Waiting extra 30s for feed to stabilize...");
    if (await waitForFeed(page, 30_000)) {
        console.log("✅ Feed became visible after delayed wait.");
        return;
    }

    console.warn("⚠️ Still no feed after extended wait — possible security interstitial.");
    const cookies = await page.context().cookies();
    console.log("🍪 Cookie names:", cookies.map((c) => c.name).join(", ") || "(none)");

    if (page.url().includes("/login")) {
        console.warn("⚠️ Redirected back to login page — likely auth cookie not set.");
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await page.waitForTimeout(3000);
    }

    const FEED_SEL_ALT =
        'div[data-testid="feed-container"], [data-testid="nav_home"], div[class*="feed"], main[class*="feed"]';

    if (await page.locator(FEED_SEL_ALT).first().count()) {
        console.log("⚠️ Feed detected after forced nav — continuing.");
        return;
    }

    throw new Error("Login appears to have failed (feed not visible).");
}





/** Try to bypass the address interstitial without requiring NEXTDOOR_ADDRESS. */
async function skipAddressIfPresent(page) {
    // If a text input is present and you *want* to fill later, you can extend this.
    // For now, try to *skip* it.
    const skipBtns = [
        'button:has-text("Skip for now")',
        'button:has-text("Skip")',
        'button:has-text("Not now")',
        'button:has-text("Do this later")',
        'button:has-text("Continue")',
        '[data-testid="skip"], [data-testid="continue"], [data-test="skip"]',
    ];

    const findFirst = async (arr) => {
        for (const s of arr) if (await page.locator(s).first().count()) return s;
        return null;
    };

    const btnSel = await findFirst(skipBtns);
    if (btnSel) {
        await Promise.allSettled([ page.click(btnSel) ]);
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        return;
    }

    // Fallback: go to the feed explicitly
    await page.goto('https://nextdoor.com/news_feed/', { waitUntil: 'domcontentloaded' }).catch(() => {});
}

function normalizePostUrl(url) {
    try {
        const u = new URL(url);
        const id = u.pathname.split("/p/")[1]?.split("/")[0];
        return id ? `https://nextdoor.com/p/${id}` : url;
    } catch {
        return url;
    }
}


async function insertNextdoorMessage(pool, {
    author,
    location,
    description,
    post_url,
    city,
    state,
    lead_type
}) {
    try {
        const query = `
            INSERT INTO nextdoor_messages
            (author, location, description, post_url, city, state, lead_type, timestamp)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                ON CONFLICT (post_url) DO UPDATE
                                              SET author = COALESCE(EXCLUDED.author, nextdoor_messages.author),
                                              location = COALESCE(EXCLUDED.location, nextdoor_messages.location),
                                              city = COALESCE(EXCLUDED.city, nextdoor_messages.city),
                                              state = COALESCE(EXCLUDED.state, nextdoor_messages.state),
                                              lead_type = COALESCE(EXCLUDED.lead_type, nextdoor_messages.lead_type),
                                              description = COALESCE(EXCLUDED.description, nextdoor_messages.description);
        `;
        const values = [author, location, description, post_url, city, state, lead_type];
        await pool.query(query, values);
        console.log(`💾 Inserted: ${author} (${location}, ${city}, ${state}) — ${lead_type}`);
    } catch (err) {
        console.error("❌ DB insert failed:", err.message);
    }
}


function isValidPersonName(author = '') {
    if (!author) return false;

    // Normalize whitespace & punctuation
    const clean = author.replace(/\s+/g, ' ').trim();

    // Must have at least a space (first + last)
    if (!clean.includes(' ')) return false;

    // Reject anything with numbers, emojis, or non-standard characters
    // Allow Unicode letters (including accents) plus common punctuation
    if (/[^A-Za-zÀ-ÖØ-öø-ÿ .'-]/.test(clean)) return false;


    // 🔎 Split into parts
    const parts = clean.split(' ').filter(Boolean);
    const first = parts[0];
    const last = parts[parts.length - 1];

    // Reject very short first/last names
    if (first.length < 2 || last.length < 2) return false;

    // Reject if either is just a single letter (with or without a period)
    if (/^[A-Za-z]\.?$/.test(first) || /^[A-Za-z]\.?$/.test(last)) return false;

    // Reject names that are entirely initials (e.g., "A B", "A.B", "Y S")
    if (/^[A-Za-z]\.? ?[A-Za-z]\.?$/.test(clean)) return false;

    // Reject all-caps short names like "YS", "Y S", "AB"
    if (/^[A-Z]{1,2}( [A-Z]{1,2})?$/.test(clean)) return false;

    return true;
}



function detectCategories(text = "") {
    if (!text) return [];
    const t = text.toLowerCase();

    const keywordTighten = {
        pool: /\b(pool|spa|hot\s?tub|chlorine|pump|filter|algae|skimmer|leak\s?detection|vacuum|pool\s?(maintenance|repair|service))\b/i,
        plumber: /\b(plumb|pipe|leak|drain|sink|toilet|shower|heater|faucet|water\s?heater|clog)\b/i,
        handyman: /\b(handyman|repair|mount|install|door|window|drywall|patch|fix|replace)\b/i,
        lawn_care: /\b(lawn|mow|yard|grass|trim|edging|landscape|mulch|weeds?|sod|hedge|bush|tree\s?(trim|remov)|sprinkler)\b/i,
        electrician: /\b(electric|outlet|breaker|panel|wiring|ceiling\s?fan|light\s?(fixture|switch)|generator)\b/i,
        painter: /\b(paint|painter|painting|stain|drywall|texture|cabinet(ry)?|trim|fence)\b/i,
        roofer: /\b(roof|roofer|shingle|leak|gutter|hail|flashing|vent|soffit)\b/i,
        pest_control: /\b(pest|bug|termite|roach|ant|spider|mosquito|rodent|exterminat|wasp|bee|snake|squirrel|raccoon)\b/i,
        general_contractor: /\b(contractor|remodel|addition|renovation|construction|builder|home\s?improvement)\b/i,
        interior_designer: /\b(kitchen|bath(room)?|counter(top)?|cabinet(ry)?|flooring|backsplash|home\s?design|remodel|interior\s?design)\b/i,
        junk_removal: /\b(junk|trash|haul|debris|appliance|furniture|cleanout|remove|dump)\b/i,
        house_cleaner: /\b(cleaner|maid|housekeeping|deep\s?clean|window\s?clean|pressure\s?wash|power\s?wash)\b/i,
        christmas_lights: /\b(christmas|holiday|xmas|light\s?(install|hanger|decoration|decor))\b/i,
        pet_sitter: /\b(pet|dog|cat|walker|sitter|boarding|feed|kennel)\b/i,
        realtor: /\b(realtor|real\s?estate|broker|agent|listing|open\s?house|buy|sell)\b/i,
        mover: /\b(move|mover|moving|pack|unload|load|truck)\b/i,
        hvac: /\b(hvac|a\/c|air\s?conditioning|heater|furnace|thermostat|vent|cooling|heating)\b/i,
        // ✅ NEW CATEGORIES
        windows: /\b(window(s)?|window\s?clean|window\s?repair|window\s?screen|screens?|exterior\s?window|interior\s?window)\b/i,
        power_washing: /\b(power\s?wash|pressure\s?wash|driveway\s?clean|concrete\s?clean|exterior\s?wash|siding\s?wash)\b/i,
        fencing: /\b(fence(s)?|fencing|fence\s?(repair|install|remov)|gate(s)?|paint(ing)?\s?fence)\b/i,
        lawyer: /\b(lawyer|trial\s?lawyer|attourney|divorce|case|open\s?courthouse|defendant|plantiff)\b/i,

    };


    const matches = [];
    for (const [type, regex] of Object.entries(keywordTighten)) {
        if (regex.test(t)) matches.push(type);
    }
    return matches;
}


/* -------------------------- Messaging + Persistence ------------------------ */

/* =================== DISABLED: DM template & sending ===================
// const dmTemplate = (name, type = 'pool') => { ... }
// async function sendDMOnProfile(page, messageText) { ... }
*/

/**
 * Insert/Upsert post WITHOUT any message_sent fields.
 * Keeps enrichment fields updated on conflict.
 */
async function upsertMessage(
    table,
    { url, author, location, city = CITY, leadType, phone = null, email = null,  description = null,physical_address = null }
) {
    await pool.query(
        `INSERT INTO ${table}
         (post_url, author, location, city, lead_type, phone, email, description, physical_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (post_url) DO UPDATE
                                           SET author = COALESCE(EXCLUDED.author, ${table}.author),
                                           location = COALESCE(EXCLUDED.location, ${table}.location),
                                           city = COALESCE(EXCLUDED.city, ${table}.city),
                                           lead_type = COALESCE(EXCLUDED.lead_type, ${table}.lead_type),
                                           phone = COALESCE(EXCLUDED.phone, ${table}.phone),
                                           email = COALESCE(EXCLUDED.email, ${table}.email),
                                           description = COALESCE(EXCLUDED.description, ${table}.description),
                                           physical_address = COALESCE(EXCLUDED.physical_address, ${table}.physical_address)`,

        [url, author, location, city, leadType, phone, email, description, physical_address]
    );
}

async function saveMessagedPost(post) {
    const { url, author, location, leadType, description } = post;

    if (!isValidPersonName(post.author)) {
        console.log(`⏭️ Not saving weak name "${post.author}"`);
        return;
    }

    try {
        console.log(
            `💾 Saving (no DM logic): url=${url}, author=${author}, loc=${location}, leadType=${leadType},description=${description}`
        );
        await upsertMessage('nextdoor_messages', post);
        await upsertMessage('recent_nextdoor_messages', post);
    } catch (err) {
        console.error('❌ DB save failed:', err.message);
    }
}

/* ----------------------------- Search Utilities ---------------------------- */

async function clickMostRecentFilter(page) {
    console.log("🔁 Attempting to click 'Most Recent' filter...");
    try {
        const sortBy = page.locator('div[role="button"][aria-label="Sort By"]');
        await sortBy.waitFor({ timeout: 8000 });
        console.log("🖱️ Clicking 'Sort By' dropdown...");
        await sortBy.click();
        await page.waitForTimeout(800);

        const mostRecent = page.locator('div[role="menuitem"] span:text("Most Recent")');
        await mostRecent.waitFor({ timeout: 5000 });
        console.log("🖱️ Selecting 'Most Recent' option...");
        await mostRecent.click();

        await page.waitForTimeout(1500);
        console.log("✅ 'Most Recent' filter applied.");
    } catch (err) {
        console.warn("⚠️ Could not click 'Most Recent' filter:", err.message);
    }
}



async function clickDistanceFilter(page) {
    console.log("📍 Setting distance filter to 15 miles...");

    try {
        // Find the Distance label and climb to the clickable container
        const distanceTrigger = page
            .locator('span:has-text("Distance")')
            .first()
            .locator(
                'xpath=ancestor::button[1] | ' +
                'xpath=ancestor::div[contains(@class,"Touchable")][1] | ' +
                'xpath=ancestor::div[contains(@class,"BaseButton")][1]'
            )
            .first();

        await distanceTrigger.waitFor({ state: "visible", timeout: 12000 });
        await distanceTrigger.click();
        await page.waitForTimeout(600);

        // Select "15 miles"
        const option = page.locator('text=15 miles').first();
        await option.waitFor({ state: "visible", timeout: 8000 });
        await option.click();

        await page.waitForTimeout(1200);
        console.log("✅ Distance set to 15 miles.");
    } catch (err) {
        console.warn("⚠️ Distance filter failed:", err.message);
    }
}


async function clickTimeFilter(page) {
    console.log("🗓️ Setting time filter to This Week...");

    try {
        // Match any known time label (current state)
        const timeTrigger = page
            .locator(
                'span:has-text("All Time"), ' +
                'span:has-text("This Week"), ' +
                'span:has-text("Today"), ' +
                'span:has-text("This Month"), ' +
                'span:has-text("This Year")'
            )
            .first()
            .locator(
                'xpath=ancestor::button[1] | ' +
                'xpath=ancestor::div[contains(@class,"Touchable")][1] | ' +
                'xpath=ancestor::div[contains(@class,"BaseButton")][1]'
            )
            .first();

        await timeTrigger.waitFor({ state: "visible", timeout: 12000 });
        await timeTrigger.click();
        await page.waitForTimeout(600);

        // Select "This Week"
        const option = page.locator('text=This Week').first();
        await option.waitFor({ state: "visible", timeout: 8000 });
        await option.click();

        await page.waitForTimeout(1200);
        console.log("✅ Time set to This Week.");
    } catch (err) {
        console.warn("⚠️ Time filter failed:", err.message);
    }
}



async function goToPostsTab(page, searchTerm) {
    console.log("🧭 Navigating to 'Posts' tab...");

    const ariaTab = page.getByRole('tab', { name: /^Posts$/i });
    if (await ariaTab.count()) {
        console.log("🖱️ Clicking ARIA Posts tab");
        await ariaTab.first().click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1500);
        return;
    }

    const testId = page.locator('[data-testid="tab-posts"]');
    if (await testId.count()) {
        console.log("🖱️ Clicking data-testid tab-posts");
        await testId.first().click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1500);
        return;
    }

    const textLink = page.locator('a,button', { hasText: /^Posts$/i }).first();
    if (await textLink.count()) {
        console.log("🖱️ Clicking text-based 'Posts' tab");
        await textLink.click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1500);
        return;
    }

    console.log("⚠️ No visible Posts tab — navigating directly to search results page...");
    await page.goto(`https://nextdoor.com/search/posts/?query=${encodeURIComponent(searchTerm)}`, {
        waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(2000);
}


async function scrapePostsOnPage(page, limit = 30) {
    for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, 1600);
        await sleep(300);
    }

    const posts = await page.$$eval('a[href*="/p/"], a[href*="/posting/"]', (links) => {
        const seen = new Set();
        const out = [];

        for (const a of links) {
            const href = a.getAttribute('href');
            if (!href) continue;

            // ✅ Always resolve to absolute URL
            const abs = href.startsWith('http')
                ? href
                : new URL(href, location.origin).href;

            if (seen.has(abs)) continue;
            seen.add(abs);

            const root = a.closest('article') || a.closest('[role="article"]') || a;
            const text = (root?.innerText || '').replace(/\s+/g, ' ').trim();

            // ✅ Only push if we have both text and URL
            if (abs && text.length > 20) {
                out.push({ url: abs, text });
            }
        }
        return out;
    });

    // ✅ Defensive: ensure structure & trim down
    return posts
        .filter(p => p.url && p.text)
        .slice(0, limit)
        .map(p => ({
            url: p.url.trim(),
            text: p.text.trim(),
        }));
}

async function filterNewLeads(posts) {

    const urls = posts.map(p => normalizePostUrl(p.url));
    console.log("🔗 Checking these URLs against DB:", urls);
    const { rows } = await pool.query(
        'SELECT post_url FROM nextdoor_messages WHERE post_url = ANY($1)',
        [urls]
    );

    console.log("🧱 Found existing URLs in DB:", rows.map(r => r.post_url));

    const seen = new Set(rows.map(r => normalizePostUrl(r.post_url)));

    const filtered = posts.filter(p => !seen.has(normalizePostUrl(p.url)));

    console.log(`📊 After filterNewLeads: ${filtered.length}/${posts.length} new leads remain`);
    return filtered;
}


/* --------------------------- GPT Lead Classifier --------------------------- */


async function classifyPosts(posts) {
    if (!posts.length) return [];




    const SYSTEM_PROMPT = `
You are a classifier for neighborhood posts seeking home or personal services.

For each post, return structured JSON describing:
1️⃣ "label": "lead" if the author is seeking any service provider, otherwise "not_lead".
2️⃣ "categories": zero or more of the following if applicable:
   ["pool","plumber","handyman","lawn_care","electrician","painter","roofer","pest_control",
    "general_contractor","junk_removal","house_cleaner","pet_sitter","realtor","mover",
    "hvac","interior_designer","christmas_lights,"windows","power_washing","fencing","lawyer"]
3️⃣ "reason": one short sentence explaining your decision.

Output strictly as:
[{"label":"lead"|"not_lead","categories":["pool","plumber"],"reason":"..."}]
Return results in the same order as input.

---
CATEGORY GUIDELINES:

- "pool": Swimming-pool cleaning, maintenance, repair, pumps, filters, or equipment.
- "plumber": Leaks, drains, faucets, toilets, water heaters, or any plumbing issues.
- "handyman": Mounting, fixing, installing, drywall, doors, windows, small repairs.
- "lawn_care": Mowing, edging, trimming hedges, tree trimming, landscaping, sprinklers.
- "electrician": Outlets, lights, fans, switches, wiring, breakers, panels.
- "painter": Painting, staining, cabinets, fences, drywall prep, or touch-ups.
- "roofer": Roof leaks, shingles, gutters, storm damage.
- "pest_control": Bugs, insects, termites, rodents, snakes, wasps, etc.
- "general_contractor": Remodeling, additions, renovations, or new construction.
- "interior_designer": Kitchen/bath remodels, home design, flooring, countertops, cabinetry.
- "junk_removal": Hauling junk, debris, old furniture, or dump runs.
- "house_cleaner": Maid service, deep cleaning, window or pressure washing.
- "christmas_lights": Hanging or installing holiday lights or decorations.
- "pet_sitter": Dog walking, boarding, or animal care.
- "realtor": Buying, selling, or renting homes; real-estate agents/brokers.
- "mover": Moving, packing, loading, or unloading.
- "hvac": Air conditioning, heating, furnaces, thermostats, or vents.
- "windows": Window, window cleaning, exterior window, windowscreen, or interior window repair.
- "power_washing": Power washing, drywall prep, driveway cleaning..
- "fencing": Fence repair, fence, painting a fence, fencing installation, or fence removal.
- "lawyer": Family Law Lawyer, Divorce Lawyer, Personal Injury Lawyer; HOA lawyer.
---

Classify as "lead" only when the post clearly requests one of these services.
`;


    const userPrompt = `Posts:\n${posts
        .map((p, i) => `#${i + 1}\n${p.text}`)
        .join("\n")}`;

    console.log(`🧠 Sending ${posts.length} posts to OpenAI multi-category classifier...`);

    const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
        ],
    });

    const raw = resp.choices?.[0]?.message?.content || "[]";
    try {
        return JSON.parse(raw);
    } catch (err) {
        const m = raw.match(/\[[\s\S]*]/);
        return m ? JSON.parse(m[0]) : posts.map(() => ({ label: "not_lead", categories: [], reason: "parse error" }));
    }
}

/* --------------------------- Melissa (TX only) ---------------------------- */


async function melissaTX(author = {}) {
    const name = (author || '').trim();
    if (!name || name.split(' ').length < 2) {
        return { phone: null, email: null, physical_address: null };
    }

    let b;
    try {
        const headless = process.env.HEADLESS === '1' || process.env.HEADLESS === 'true' || process.env.HEADLESS === 1;
        console.log(`🧩 Headless mode: ${headless}`);

        const useChrome = process.env.USE_CHROME === '1';
        b = useChrome
            ? await chromium.launch({ channel: 'chrome', headless })
            : await chromium.launch({ headless });

        // 1) run your Melissa lookup
        const { phone, email, physical_address } =
        await personSearchAndScrape(b, { name, state: 'TX', city: '', zip: '' }) || {};

        // 2) fire the production alert (only if we have enough fields)


        return { phone, email, physical_address };
    } catch (e) {
        console.warn('⚠️ melissaTX failed:', e.message);
        return { phone: null, email: null, physical_address: null };
    } finally {
        if (b) await b.close();
    }
}

/* --------------------------------- Main ----------------------------------- */

const runNextdoorAutomation = async () => {
    console.log('🏡  Running Nextdoor Automation...');

    const useChrome = process.env.USE_CHROME === '1';

    // ✅ Safer headless handling (works across Railway & local)
    let headless = true;
    const headlessEnv = process.env.HEADLESS;
    if (headlessEnv !== undefined) {
        headless =
            headlessEnv === '1' ||
            headlessEnv === 'true' ||
            headlessEnv === 1 ||
            headlessEnv === true;
    }
    if (process.env.RAILWAY_ENVIRONMENT) {
        console.log('⚙️ Railway detected — forcing headless mode ON.');
        headless = true;
    }
    console.log(`🧩 Headless mode: ${headless ? 'ON' : 'OFF'}`);

    // --- slot-aware env (defaults to morning) ---
    const SLOT = (process.env.RUN_SLOT || 'morning').toLowerCase();

    // --- HARD DISABLE any proxies ---
    ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
        .forEach(k => { if (process.env[k]) delete process.env[k]; });

    // --- portable profile dir resolution ---
    const baseDefault = fs.existsSync('/data') ? '/data' : os.tmpdir();

    let ND_PROFILE_DIR =
        process.env[`ND_PROFILE_DIR_${SLOT.toUpperCase()}`] ||
        process.env.ND_PROFILE_DIR ||
        path.join(baseDefault, `.nd-profile-${SLOT}`);

    try {
        fs.mkdirSync(ND_PROFILE_DIR, { recursive: true });
    } catch (err) {
        console.error(`⚠️ Failed to ensure profile dir ${ND_PROFILE_DIR}:`, err);
        ND_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `.nd-profile-${SLOT}-`));
    }

    console.log(`🕒 Slot: ${SLOT}`);
    console.log('🌐 Proxy: disabled');
    console.log(`📁 Profile dir resolved: ${ND_PROFILE_DIR}`);

    const baseLaunchOpts = {
        headless,
        viewport: { width: 1400, height: 900 },
        geolocation: { latitude: 33.0602, longitude: -96.7349 },
        permissions: ['geolocation'],
        timezoneId: 'America/Chicago',
        locale: 'en-US',
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-dev-shm-usage',
        ],
    };

    const opts = useChrome ? { ...baseLaunchOpts, channel: 'chrome' } : baseLaunchOpts;
    opts.headless = true;

    const context = await chromium.launchPersistentContext(ND_PROFILE_DIR, opts);

    if (process.env.CLEAR_STORAGE_ON_START === '1') {
        await clearNextdoorStorage(context, 'startup');
    }

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = window.chrome || { runtime: {} };
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(60000);

    try {
        await ensureLoggedIn(page);console.log('🚀 Starting search/scrape sequence...');


        // -------------------- Utility Functions --------------------
        async function searchNextdoor(page, query) {
            await page.waitForSelector('input[aria-label="Search Nextdoor"]', { timeout: 15000 });
            await page.fill('input[aria-label="Search Nextdoor"]', query);
            await page.keyboard.press("Enter");
            await page.waitForLoadState("domcontentloaded");
            await sleep(3000);
        }
// --- openDetailPage(): navigate straight to the post detail and scrape ---
        async function openDetailPage(page, lead) {
            try {
                const shortId = lead.url.split("/p/")[1]?.split("?")[0];
                if (!shortId) {
                    console.log(`⚠️ Could not parse post ID from URL: ${lead.url}`);
                    return null;
                }

                const detailUrl = `https://www.nextdoor.com/p/${shortId}`;
                console.log(`🧭 Opening detail page: ${detailUrl}`);

                await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
                await page.waitForTimeout(2000);

                // 1️⃣ Expand long text if truncated
                try {
                    const seeMore = page.locator('button:has-text("See more"), [data-testid="see-more-text"]');
                    if (await seeMore.first().isVisible()) {
                        await seeMore.first().click({ timeout: 1500 }).catch(() => {});
                        await page.waitForTimeout(400);
                    }
                } catch {}

                // 2️⃣ Extract Author (handles delayed text rendering + avatar fallback)
                let author = "UNKNOWN";
                try {
                    const authorSel = 'a[href*="/profile/"][href*="is=detail_author"], a[href*="/profile/"][data-app="2"]';
                    await page.waitForSelector(authorSel, { timeout: 8000 });

                    const authorEl = page.locator(authorSel).first();
                    await authorEl.scrollIntoViewIfNeeded().catch(() => {});
                    await page.waitForTimeout(300);

                    // React hydration wait
                    for (let i = 0; i < 8; i++) {
                        const text = (await authorEl.innerText()).trim();
                        if (text && text.length > 2) {
                            author = text;
                            break;
                        }
                        await page.waitForTimeout(400);
                    }

                    // 🧩 Fallback 1: Avatar aria-label
                    if (author === "UNKNOWN" || author.length < 2) {
                        const avatarSel = 'a[href*="/profile/"] div[role="img"][aria-label*="Avatar for"]';
                        const avatarEl = page.locator(avatarSel).first();
                        if (await avatarEl.count()) {
                            const aria = await avatarEl.getAttribute("aria-label");
                            if (aria && aria.includes("Avatar for")) {
                                author = aria.replace(/^Avatar for\s*/i, "").trim();
                            }
                        }
                    }

                    // 🧩 Fallback 2: Embedded JSON state
                    if (author === "UNKNOWN" || author.length < 2) {
                        const nextData = await page.evaluate(() => {
                            const script = document.querySelector('script#__NEXT_DATA__');
                            if (!script) return null;
                            try { return JSON.parse(script.textContent); } catch { return null; }
                        });
                        const maybeName =
                            nextData?.props?.pageProps?.post?.author?.name ||
                            Object.values(nextData?.props?.apolloState || {}).find(v => v?.__typename === "User")?.name;
                        if (maybeName) author = maybeName.trim();
                    }

                    // 🧩 Log if still unknown
                    if (author === "UNKNOWN" || author.length < 2) {
                        const raw = await authorEl.evaluate(el => el.outerHTML);
                        console.log("🧩 Author HTML fallback snippet:", raw);
                    }
                } catch (err) {
                    console.warn("⚠️ Author extraction failed:", err.message);
                }

                // 3️⃣ Extract Location
                let location = "UNKNOWN";
                try {
                    const locSel = 'a[href*="/neighborhood/"]';
                    const locEl = page.locator(locSel).first();
                    if (await locEl.count()) {
                        location = (await locEl.innerText()).trim();
                    }
                } catch (err) {
                    console.warn("⚠️ Location extraction failed:", err.message);
                }

                // 4️⃣ Extract Description
                let description = "UNKNOWN";
                try {
                    const descCandidates = [
                        '[data-testid="post-body-text"]',
                        'span[data-testid="styled-text"]',
                        '.Text_body__',
                        '.postTextBodySpan',
                        '[data-testid="styled-text-wrapper"]',
                        'div[data-app="2"] span[data-testid="styled-text"]'
                    ].join(', ');

                    const descEl = page.locator(descCandidates).first();
                    if (await descEl.count()) {
                        const raw = await descEl.evaluate(el => (el.innerText || el.textContent || '').trim());
                        description = raw.replace(/\s+/g, ' ').trim();
                    }
                } catch (err) {
                    console.warn("⚠️ Description extraction failed:", err.message);
                }

                console.log(`👤 Author="${author}", 📍 Location="${location}", 📝 Desc length=${description.length}`);
                return { author, location, description };
            } catch (err) {
                console.error(`❌ Error loading detail for ${lead.url}:`, err.message);
                return null;
            }
        }


        async function handleLead({ page, lead, author, location, description, type, matchCity }) {
            let phone = null, email = null, physical_address = null;
            const descParts = [description].filter(Boolean);
            console.log(`📬 Calling Melissa enrichment for "${author}"...`);

            const r = await melissaTX(author);
            console.log("📇 Melissa:", r);
            console.log(`✅ Melissa lookup done for "${name}":`, { phone, email, physical_address });

            phone = r.phone; email = r.email; physical_address = r.physical_address;
            if (phone) descParts.push(`Possible: ${phone}`);

            await saveMessagedPost({
                url: lead.url,
                author,
                location,
                leadType: (lead.categories && lead.categories.length ? lead.categories.join(',') : type),
                phone,
                email,
                physical_address,
                description,
            });

            if (!phone) {
                console.log("ℹ️ No phone found, skipping alert.");
                return;
            }

            const resp = await postLeadAlert({
                name: author,
                phone,
                lead_type: type,
                city: matchCity,
                description: descParts.join(" | "),
                location,
                physical_address,
                message_sent_at: new Date().toISOString(),
            });

            if (!resp.ok) console.warn("⚠️ Lead notify failed:", resp.error || resp);
            else console.log("📣 Lead notify sent:", resp.data);
        }

        // -------------------- Main Scraper --------------------
        async function processSearchTerms(page, SEARCH_TERMS) {
            for (const { label, query, type, needsMostRecent } of SEARCH_TERMS) {
                console.log(`🔍 Searching for: ${label}`);
                await searchNextdoor(page, query);
                await goToPostsTab(page, query);
if (needsMostRecent) await clickMostRecentFilter(page);
await page.waitForTimeout(1500);
                await clickDistanceFilter(page); // 15 miles
                await clickTimeFilter(page);     // This Week
                await sleep(2000);
                console.log(`🕵️‍♂️ Collecting posts for '${label}' (${query})...`);

                const posts = await scrapePostsOnPage(page, 30);
                console.log(`🧾 Found ${posts.length} posts before classification.`);

                const generalTypes = [
                    "pool",
                    "handyman",
                    "plumber",
                    "roofer",
                    "electrician",
                    "painter",
                ];
                const classifierType = generalTypes.includes(type)
                    ? "general_home_services"
                    : type;

                const labels = await classifyPosts(posts);
                console.log(`🧠 Classification complete — ${labels.filter(l => l.label === 'lead').length}/${labels.length} labeled as leads.`);

                const normalizedPosts = posts.map(p => ({
                    ...p,
                    url: normalizePostUrl(p.url),
                }));

                const leads = normalizedPosts
                    .map((p, i) => {
                        const label = labels[i] || {};
                        const regexCats = detectCategories(p.text);
                        const combined = Array.from(new Set([...(label.categories || []), ...regexCats]));
                        return { ...p, ...label, categories: combined };
                    })
                    .filter(p => p.label === "lead");

                console.log(`📊 ${leads.length} leads retained after category tightening.`);

                const newLeads = await filterNewLeads(leads);
                if (!newLeads.length) {
                    console.log(`⚠️ No clear new leads for: ${label}`);
                    continue;
                }

                for (const [i, lead] of newLeads.entries()) {
                    console.log(`(${i + 1}/${newLeads.length}) Extracting from feed...`);
                    const result = await openDetailPage(page, lead);
                    if (!result) continue;

                    const { author, location, description } = result;

                    if (!isValidPersonName(author)) {
                        console.log(`⏭️ Skipping weak name "${author}"`);
                        continue;
                    }

                    const leadType = (lead.categories && lead.categories.length > 0)
                        ? lead.categories.join(", ")
                        : type;

                    await insertNextdoorMessage(pool, {
                        author,
                        location,
                        description,
                        post_url: normalizePostUrl(lead.url),
                        city: CITY,
                        state: STATE,
                        lead_type: leadType,
                    });
                }
            }
        }

        await processSearchTerms(page, SEARCH_TERMS);
    } catch (err) {
        console.error("❌ Fatal error during main automation:", err);
    } finally {
        console.log("🧹 Cleaning up browser context...");
        await clearNextdoorStorage(context, 'shutdown');
        await context.close().catch(() => {});
        console.log("✅ Browser closed and cleanup complete.");
    }
}





if (require.main === module) {
    runNextdoorAutomation()
        .then(() => {
            console.log('✅ Nextdoor automation completed.');
            process.exit(0);
        })
        .catch((err) => {
            console.error('❌ Fatal error in Nextdoor automation:', err);
            process.exit(1);
        });
}
module.exports = runNextdoorAutomation;

