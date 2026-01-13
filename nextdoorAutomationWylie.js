// nextdoorAutomationWylie.js
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

        const option = page.locator('text=This Week').first();
        await option.waitFor({ state: "visible", timeout: 8000 });
        await option.click();

        await page.waitForTimeout(1200);
        console.log("✅ Time set to This Week.");
    } catch (err) {
        console.warn("⚠️ Time filter failed:", err.message);
    }
}
require('dotenv').config();
const path = require('path');
const { chromium } = require('playwright');
const OpenAI = require('openai');
const pool = require('./db/db');
const fs = require('fs');
const { personSearchAndScrape } = require('./melissaLookup');
const { postLeadAlert } = require('./leadAlertClient');
const { runFamilyTreeStealth } = require('./runFamilyTreeStealth');



const cloudinary = require('cloudinary').v2;
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const os = require("os");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =================== DISABLED: DM-related constants =================== */
// const MAX_DMS_PER_DAY = 7;
// const DM_PAUSE_MS = 1500;

const CITY = 'Wylie';

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

  // 🏠 Specialty Services
  { label: 'Interior Designer', query: 'kitchen remodel', type: 'interior_designer', needsMostRecent: true },
  { label: 'Bathroom Remodel', query: 'bathroom remodel', type: 'interior_designer', needsMostRecent: true },
  { label: 'Christmas Lights', query: 'christmas lights', type: 'christmas_lights', needsMostRecent: true },

  // 🐾 Personal / Real Estate
  { label: 'Pet Sitter', query: 'pet sitter', type: 'pet_sitter', needsMostRecent: true },
  { label: 'Realtor', query: 'realtor', type: 'realtor', needsMostRecent: true },
  { label: 'Mover', query: 'mover', type: 'mover', needsMostRecent: true },
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
    // 1) already signed in?
    await page.goto('https://nextdoor.com/news_feed/', { waitUntil: 'domcontentloaded' });
    if (await page.locator(FEED_SEL).first().count()) {
        console.log('✅ Already on feed');
        return;
    }

    // 2) go to login (force allow_login if splash)
    await page.goto('https://nextdoor.com/login/?next=/news_feed/', { waitUntil: 'domcontentloaded' });
    if (await page.locator('text=New here? Join Nextdoor').first().count()) {
        console.log('ℹ️ Got join splash, forcing login form…');
        await page.goto('https://nextdoor.com/login/?allow_login=true&next=/news_feed/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
    }

    // cookie consent (best-effort)
    try {
        await page.locator([
            'button:has-text("Accept")',
            'button:has-text("I agree")',
            'button:has-text("Allow all")',
            '[data-testid="cookie-accept"]'
        ].join(',')).first().click({ timeout: 1500 });
    } catch {}

    // selectors (flexible)
    const emailSel = await (async () => {
        for (const s of [
            'input[data-testid="email-address-input"]',
            'input[name="email"]',
            'input[type="email"]',
            'input[placeholder*="Email" i]'
        ]) if (await page.locator(s).first().count()) return s;
        return null;
    })();
    const passSel = await (async () => {
        for (const s of [
            'input[data-testid="password-input"]',
            'input[name="password"]',
            'input[type="password"]',
            'input[placeholder*="Password" i]'
        ]) if (await page.locator(s).first().count()) return s;
        return null;
    })();
    const btnSel = await (async () => {
        for (const s of [
            'button[data-testid="signin_button"]',
            'button:has-text("Log in")',
            'button:has-text("Sign in")',
            'button[type="submit"]'
        ]) if (await page.locator(s).first().count()) return s;
        return null;
    })();

    // if the form isn’t there, maybe we’ve been auto-signed in or blocked – try feed
    if (!emailSel || !passSel || !btnSel) {
        console.log('ℹ️ Login form not found, checking feed/interstitial…');
        if (await waitForFeed(page, 30_000)) {
            console.log('✅ Feed became visible without manual login');
            return;
        }
        throw new Error('Login form not found (and feed did not appear).');
    }
//Test
    console.log(`🔐 Filling login: email="${emailSel}", pass="${passSel}", btn="${btnSel}"`);

    await page.locator(emailSel).click();
    await page.keyboard.type(process.env.NEXTDOOR_USERNAME, { delay: 40 });
    await page.locator(passSel).click();
    await page.keyboard.type(process.env.NEXTDOOR_PASSWORD, { delay: 45 });

    // click and give the site a moment to start redirecting
    await Promise.allSettled([page.click(btnSel)]);
    await page.waitForTimeout(5_000);            // ← this was the missing piece

    // be patient and forgiving while we transition to the feed
    const ok = await waitForFeed(page, 90_000);
    console.log('➡️ Post-login URL:', page.url());
    if (ok) {
        console.log('✅ Feed visible after login');
        return;
    }

    // last try: push to feed and wait briefly, then soft-continue
    await page.goto('https://nextdoor.com/news_feed/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(5_000);
    if (await page.locator(FEED_SEL).first().count()) {
        console.log('⚠️ Feed detected after forced nav — continuing.');
        return;
    }



    throw new Error('Login appears to have failed (feed not visible).');
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


function parseName(author = '') {
    const parts = author.trim().split(/\s+/).filter(Boolean);
    const first = parts[0] || '';
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
    return { first, last };
}

function isValidPersonName(author = '') {
    if (!author) return false;

    // Normalize whitespace & punctuation
    const clean = author.replace(/\s+/g, ' ').trim();

    // Must have at least a space (first + last)
    if (!clean.includes(' ')) return false;

    // Reject anything with numbers, emojis, or non-standard characters
    if (/[^a-zA-Z .'-]/.test(clean)) return false;

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

        const option = page.locator('text=This Week').first();
        await option.waitFor({ state: "visible", timeout: 8000 });
        await option.click();

        await page.waitForTimeout(1200);
        console.log("✅ Time set to This Week.");
    } catch (err) {
        console.warn("⚠️ Time filter failed:", err.message);
    }
}
    console.log("🗓️ Setting time filter to This Week...");

    try {
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

        const option = page.locator('text=This Week').first();
        await option.waitFor({ state: "visible", timeout: 8000 });
        await option.click();

        await page.waitForTimeout(1200);
        console.log("✅ Time set to This Week.");
    } catch (err) {
        console.warn("⚠️ Time filter failed:", err.message);
    }
}

    try {
        const sortBy = page.locator('div[role="button"][aria-label="Sort By"]');
        await sortBy.waitFor({ timeout: 8000 });
        await sortBy.click();
        await page.waitForTimeout(800);
        const mostRecent = page.locator('div[role="menuitem"] span:text("Most Recent")');
        await mostRecent.waitFor({ timeout: 5000 });
        await mostRecent.click();
        await page.waitForTimeout(1500);
    } catch {
        /* non-fatal */
    }
}

async function goToPostsTab(page, searchTerm) {
    const ariaTab = page.getByRole('tab', { name: /^Posts$/i });
    if (await ariaTab.count()) {
        await ariaTab.first().click();
        return;
    }

    const testId = page.locator('[data-testid="tab-posts"]');
    if (await testId.count()) {
        await testId.first().click();
        return;
    }

    const textLink = page.locator('a,button', { hasText: /^Posts$/i }).first();
    if (await textLink.count()) {
        await textLink.click();
        return;
    }

    await page.goto(`https://nextdoor.com/search/posts/?query=${encodeURIComponent(searchTerm)}`, {
        waitUntil: 'domcontentloaded',
    });
}

async function scrapePostsOnPage(page, limit = 30) {
    for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, 1600);
        await sleep(300);
    }
    const posts = await page.$$eval('a[href*="/p/"], a[href*="/posting/"]', (links) => {
        const seen = new Set(), out = [];
        for (const a of links) {
            const href = a.getAttribute('href');
            if (!href) continue;
            const abs = href.startsWith('http') ? href : new URL(href, location.origin).href;
            if (seen.has(abs)) continue;
            seen.add(abs);
            const root = a.closest('article') || a.closest('[role="article"]') || a;
            const text = (root?.innerText || '').replace(/\s+/g, ' ').trim();
            if (text && text.length > 20) out.push({ url: abs, text });
        }
        return out;
    });
    return posts.slice(0, limit);
}

async function filterNewLeads(posts) {
    const urls = posts.map((p) => p.url);
    const { rows } = await pool.query('SELECT post_url FROM nextdoor_messages WHERE post_url = ANY($1)', [urls]);
    const seen = new Set(rows.map((r) => r.post_url));
    return posts.filter((p) => !seen.has(p. url));
}

/* --------------------------- GPT Lead Classifier --------------------------- */

async function getAuthorAndLocationAndDescription(page, postUrl) {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
    await sleep(2500);

    let author = 'UNKNOWN', location = 'UNKNOWN', description = 'UNKNOWN';

    // --- Expand "See more" if present
    try {
        const seeMore = page.locator('button:has-text("See more"), [data-testid="see-more-text"]');
        if (await seeMore.first().isVisible()) {
            await seeMore.first().click({ timeout: 1500 }).catch(() => {});
            await sleep(150);
        }
    } catch {}

    // --- Author extraction (robust multi-selector fallback)
    try {
        const authorSelectors = [
            'a[href*="/profile/"] span',            // common
            'a[href*="/profile/"] div',
            '[data-testid="actor-name"]',
            '[aria-label*="Profile of"]',           // sometimes present on links
            'header a[role="link"] span',           // feed header fallback
        ];

        for (const sel of authorSelectors) {
            const el = page.locator(sel).first();
            if (await el.count()) {
                author = (await el.innerText()).trim();
                if (author && !/^unknown$/i.test(author)) break;
            }
        }

        // Normalize capitalization and punctuation
        author = author
            .replace(/\s+/g, ' ')
            .replace(/\b([a-z])/g, (m) => m.toUpperCase())
            .replace(/\.$/, '')
            .trim();

        console.log('🧩 Extracted author:', author);
    } catch (err) {
        console.warn('⚠️ Failed to extract author:', err.message);
    }

    // --- Location
    try {
        const locSelectors = [
            'a[href*="/neighborhood/"] span',
            '[data-testid="neighborhood-link"] span',
            '[aria-label*="Neighborhood"] span',
        ];
        for (const sel of locSelectors) {
            const el = page.locator(sel).first();
            if (await el.count()) {
                location = (await el.innerText()).trim();
                if (location) break;
            }
        }
        console.log('📍 Extracted location:', location);
    } catch (err) {
        console.warn('⚠️ Failed to extract location:', err.message);
    }

    // --- Description (more resilient set of selectors)
    try {
        const descSelectors = [
            '[data-testid="styled-text-wrapper"]',
            '.postTextBodySpan',
            '.postTextBodySpan [data-testid="styled-text"]',
            'div[data-testid="post-text"]',
            'article div[role="paragraph"]',
        ];
        for (const sel of descSelectors) {
            const el = page.locator(sel).first();
            if (await el.count()) {
                const raw = await el.evaluate(el => (el.innerText || el.textContent || '').trim());
                const normalized = raw.replace(/\s+/g, ' ').trim();
                if (normalized) {
                    description = normalized;
                    break;
                }
            }
        }
        console.log('📝 Extracted description:', description.slice(0, 80) + '...');
    } catch (err) {
        console.warn('⚠️ Failed to extract description:', err.message);
    }

    return { author, location, description };
}

async function classifyPosts(posts, labelType = 'pool') {
    if (!posts.length) return [];

    const SYSTEM_PROMPTS = {
        electrician: `You’re classifying neighborhood posts. Label "lead" ONLY if the author is seeking an electrician or electrical services (outlets, wiring, breaker panels, lights, switches, ceiling fans, generators, EV charger installs, new circuits, power outages, electrical inspections).
Label "not_lead" if it's about general handyman work, appliances, HVAC, or unrelated topics.
Return ONLY JSON in input order: [{"label":"lead"|"not_lead","reason":"..."}]. Be strict.`,

        general_contractor: `You’re classifying neighborhood posts. Label "lead" ONLY if the author is seeking a general contractor, builder, remodeler, or construction company for renovations, additions, remodels, or new home/commercial builds.
Label "not_lead" if the post is only about specific trades (plumbing, roofing, painting, flooring, etc.) or unrelated home services.
Return ONLY JSON in input order: [{"label":"lead"|"not_lead","reason":"..."}]. Be strict.`,

        roofer: `You’re classifying neighborhood posts. Label "lead" ONLY if the author is seeking roofing services (roof repair, replacement, leak detection, hail/wind damage, shingles, flashing, gutters tied to roofing).
Label "not_lead" if it's about general contracting, siding, gutters only, or interior repairs.
Return ONLY JSON in input order: [{"label":"lead"|"not_lead","reason":"..."}]. Be strict.`,

        junk_removal: `You’re classifying neighborhood posts. Label "lead" ONLY if the author is seeking junk removal, trash hauling, debris pickup, appliance/furniture removal, garage cleanouts, or moving cleanups.
Label "not_lead" if it’s about house cleaning, lawn care, or someone selling or giving away items.
Return ONLY JSON in input order: [{"label":"lead"|"not_lead","reason":"..."}]. Be strict.`,

        pet_sitter: `You’re classifying neighborhood posts. Label "lead" ONLY if the author is seeking a pet sitter, dog walker, boarding, feeding, or animal care service (cats, dogs, etc.).
Label "not_lead" if the post is about adopting, selling pets, lost/found animals, or general pet discussions.
Return ONLY JSON in input order: [{"label":"lead"|"not_lead","reason":"..."}]. Be strict.`,

        painter: `You’re classifying neighborhood posts. Label "lead" ONLY if the author is seeking painting services (interior, exterior, cabinets, fences, staining, drywall prep, texture, or quotes for a painter).
Label "not_lead" if it's about other trades like roofing, remodeling, handyman work, or decorative art.
Return ONLY JSON in input order: [{"label":"lead"|"not_lead","reason":"..."}]. Be strict.`,
        realtor: `You’re classifying neighborhood posts. Label "lead" ONLY if the author is seeking a realtor, real estate agent, or broker to help buy, sell, or rent a home/property.
Label "not_lead" if the post is advertising a realtor service, discussing market news, or unrelated to real estate transactions.
Return ONLY JSON in input order: [{"label":"lead"|"not_lead","reason":"..."}]. Be strict.`,

        mover: `You’re classifying neighborhood posts. Label "lead" ONLY if the author is seeking movers, moving companies, or help with loading, unloading, packing, or moving trucks.
Label "not_lead" if it’s about junk removal, storage, deliveries, or unrelated topics.
Return ONLY JSON in input order: [{"label":"lead"|"not_lead","reason":"..."}]. Be strict.`

    };


    const system = String(SYSTEM_PROMPTS[labelType] || SYSTEM_PROMPTS.pool);
    const user = `Posts:\n${posts.map((p, i) => `#${i + 1}\n${p.text}`).join('\n')}`;

    const resp = await openai.chat.completions.create({
        model: 'gpt-5o-mini',
        temperature: 0,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
        ]
    });


    const raw = resp.choices?.[0]?.message?.content || '[]';
    try {
        return JSON.parse(raw);
    } catch {
        const m = raw.match(/\[[\s\S]*]/);
        return m ? JSON.parse(m[0]) : posts.map(() => ({ label: 'not_lead', reason: 'parse error' }));
    }
}

/* --------------------------- Melissa (TX only) ---------------------------- */
function extractCityFromAddress(addr = '') {
    const match = addr.match(/\b([A-Z][a-z]+)\s*,?\s*TX\b/);
    return match ? match[1] : null;
}

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
    let headless = true; // default to safe
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
    const SLOT = (process.env.RUN_SLOT || 'morning').toLowerCase(); // "morning" | "afternoon"

    // --- HARD DISABLE any proxies (even if inherited from the shell) ---
    ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
        .forEach(k => { if (process.env[k]) delete process.env[k]; });



    // --- portable profile dir resolution (Railway uses /data, local uses OS tmp) ---
    const baseDefault = fs.existsSync('/data') ? '/data' : os.tmpdir();

    let ND_PROFILE_DIR =
        process.env[`ND_PROFILE_DIR_${SLOT.toUpperCase()}`] ||
        process.env.ND_PROFILE_DIR ||
        path.join(baseDefault, `.nd-profile-${SLOT}`);

    try {
        fs.mkdirSync(ND_PROFILE_DIR, { recursive: true });
    } catch (err) {
        console.error(`⚠️ Failed to ensure profile dir ${ND_PROFILE_DIR}:`, err);
        // Last-resort: unique temp dir
        ND_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `.nd-profile-${SLOT}-`));
    }

    console.log(`🕒 Slot: ${SLOT}`);
    console.log('🌐 Proxy: disabled'); // guaranteed
    console.log(`📁 Profile dir resolved: ${ND_PROFILE_DIR}`);

    // --- shared launch options (no proxy field at all) ---
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
        // 👇 no "proxy" key here at all
    };

    // --- always use a persistent context with the resolved dir ---
    const opts = useChrome ? { ...baseLaunchOpts, channel: 'chrome' } : baseLaunchOpts;

    // ✅ Defensive: ensure headless true even if env mis-set
    opts.headless = true;

    const context = await chromium.launchPersistentContext(ND_PROFILE_DIR, opts);

    if (process.env.CLEAR_STORAGE_ON_START === '1') {
        await clearNextdoorStorage(context, 'startup');
    }

    // --- small stealth tweaks ---
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // Supply minimal chrome object to reduce detection
        // @ts-ignore
        window.chrome = window.chrome || { runtime: {} };
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(60000);

    try {
        await ensureLoggedIn(page);for (const { label, query, type, needsMostRecent } of SEARCH_TERMS) {
            console.log(`🔍 Searching for: ${label}`);

            await page.waitForSelector('input[aria-label="Search Nextdoor"]', { timeout: 15000 });
            await page.fill('input[aria-label="Search Nextdoor"]', query);
            await page.keyboard.press('Enter');
            await page.waitForLoadState('domcontentloaded');
            await sleep(3000);

            await goToPostsTab(page, query);
if (needsMostRecent) await clickMostRecentFilter(page);
await page.waitForTimeout(1500);
await clickDistanceFilter(page); // 15 miles
await clickTimeFilter(page);     // This Week
            await sleep(2000);

            const posts = await scrapePostsOnPage(page, 30);
            const labels = await classifyPosts(posts, type);
            const enriched = posts.map((p, i) => ({ ...p, ...(labels[i] || {}) }));
            const leads = enriched.filter((p) => p.label === 'lead');
            const keywordTighten = {
                pool: (p) =>
                    /\b(pool|spa|chlorine|skimmer|pump|filter|backwash|algae|acid|resurface|pebble|tile|saltwater|clean\S*|maintenance)\b/i.test(p.text),

                handyman: (p) =>
                    /\b(handyman|fix|repair|mount|install|honey-do|leak|hole|drywall|tv|fence|gate|door|cabinet|window|shelf|hinge|caulk|patch)\b/i.test(p.text),

                plumber: (p) =>
                    /\b(plumber|plumbing|pipe|leak|toilet|sink|drain|shower|water heater|faucet|clog|sewer|burst|slow drain)\b/i.test(p.text),

                house_cleaner: (p) =>
                    /\b(cleaner|housekeep|maid|scrub|vacuum|mop|dust|tidy|sanitize|deep clean|residential cleaning|cleaning lady|weekly clean)\b/i.test(p.text),

                lawn_care: (p) =>
                    /\b(lawn|mow|yard|grass|edging|trim|landscape|mulch|sod|fertiliz|aeration|weeds?|bush trimming|leaf)\b/i.test(p.text),

                pest_control: (p) =>
                    /\b(pest|termite|roach|mosquito|bug|insect|ant|spider|exterminator|wasp|bee|bed bug|infestation|critters?)\b/i.test(p.text),

                electrician: (p) =>
                    /\b(electrician|outlet|breaker|panel|re-wire|rewire|short circuit|electrical|light fixture|install lighting|ceiling fan|surge|GFCI)\b/i.test(p.text),

                general_contractor: (p) =>
                    /\b(general contractor|remodel|renovate|home addition|kitchen remodel|bathroom remodel|demo|drywall|flooring|construction|framing|build)\b/i.test(p.text),

                roofer: (p) =>
                    /\b(roofer|roofing|shingle|leak|repair roof|re-roof|gutter|vent|roof damage|hail damage|roof inspection|flashing|soffit|ridge)\b/i.test(p.text),

                junk_removal: (p) =>
                    /\b(junk removal|trash pickup|haul away|garage cleanout|debris|old furniture|appliance removal|dump run|bulk pickup|demo cleanup)\b/i.test(p.text),

                realtor: (p) =>
                    /\b(realtor|real estate agent|buying house|selling house|list my home|showing|zillow|MLS|property|house for sale|home value|realty)\b/i.test(p.text),

                mover: (p) =>
                    /\b(moving company|movers|move boxes|relocate|move help|load truck|packers|move service|uhaul help|apartment move|furniture movers)\b/i.test(p.text),

                pet_sitter: (p) =>
                    /\b(pet sitter|dog walker|cat sitter|dog boarding|overnight pet care|puppy visits|feed pets|walk dog|animal care|doggy daycare)\b/i.test(p.text),

                painter: (p) =>
                    /\b(painter|painting|interior paint|exterior paint|touch up|drywall paint|repaint|cabinet paint|baseboard|trim|roller|brush)\b/i.test(p.text)
            };

            const tighten = keywordTighten[type] || (() => true);
            const newLeads = await filterNewLeads(leads.filter(tighten));

            if (!newLeads.length) {
                console.log(`⚠️ No clear new leads for: ${label}`);
                continue;
            }

            for (const [i, lead] of newLeads.entries()) {
                console.log(`(${i + 1}/${newLeads.length}) Visiting -> ${lead.url}`);

                const { author, location, description } = await getAuthorAndLocationAndDescription(page, lead.url);
                lead.author = author;
                lead.location = location;
                lead.leadType = type;
                lead.description = description;

                if (!isValidPersonName(author)) {
                    console.log(`⏭️ Skipping weak name "${author}" (needs a real last name)`);
                    continue;
                }

                let phone = null, email = null, physical_address = null;
                const descParts = [description].filter(Boolean);
// 🧱 Safe default objects to avoid null-reference errors downstream
                let ftn = { success: false, mobile_phones: [], phones: [], provider: null, address: null };
                let melissa = { phone: null, email: null, physical_address: null, source: null };



                try {
                    console.log(`🕵️ Running FamilyTreeNow Stealth for ${author} (${CITY})...`);
                    const [first, last] = (author || '').split(/\s+/, 2);

                    // ✅ Always define ftnResult, even if scraper crashes
                    const ftnResult = await runFamilyTreeStealth({ first, last, city: CITY }) || {};

                    if (ftnResult.success && ftnResult.data) {
                        console.log('✅ FTN lookup succeeded.');

                        const data = ftnResult.data;
                        const wireless = (data.mobile_phones || []).map(p => p.number);
                        const landlines = (data.phones || []).map(p => p.number);
                        const uniquePhones = [...new Set([...wireless, ...landlines].filter(Boolean))];

                        if (uniquePhones.length) {
                            phone = uniquePhones[0];
                            descParts.push(`FTN Phones: ${uniquePhones.join(', ')}`);
                        }

                        if (data.address) {
                            physical_address = data.address;
                            descParts.push(`FTN Address: ${data.address}`);
                        }

                        if (data.provider) {
                            descParts.push(`Provider: ${data.provider}`);
                        }

                        // ✅ If you want to propagate the FTN result to the parent caller:
                        ftn = { success: true, ...ftnResult };

                    } else {
                        console.warn(`⚠️ FTN returned no data for ${author} — falling back to Melissa.`);

                        melissa = await personSearchAndScrape(null, {
                            name: `${first} ${last}`,
                            state: 'TX',
                            city: CITY
                        });

                        if (melissa?.phone) phone = melissa.phone;
                        if (melissa?.email) email = melissa.email;
                        if (melissa?.physical_address) physical_address = melissa.physical_address;

                        descParts.push(`Melissa: ${phone || 'none'}`);

                        // ✅ Even in fallback, define ftn to avoid undefined references downstream
                        ftn = { success: false, reason: ftnResult.reason || 'no_data', data: null };
                    }

                } catch (err) {
                    console.error(`❌ FTN/Melissa enrichment failed for ${author}:`, err?.message || err);
                    ftn = { success: false, reason: 'exception', error: err?.message || String(err) };
                }





                // FTN doesn't always include city in the address — try to extract it if possible
                let matchCity = CITY;
                if (physical_address) {
                    const extractedCity = extractCityFromAddress(physical_address);
                    if (extractedCity) {
                        matchCity = extractedCity;
                        console.log(`📍 Overriding CITY with FTN address: ${matchCity}`);
                    }
                }

                // 📇 Try Melissa only if FTN fails
                if (!phone) {
                    const r = await melissaTX(author);
                    console.log('📇 Melissa:', r);
                    phone = r.phone; email = r.email;
                    if (!physical_address) physical_address = r.physical_address;
                    if (phone) descParts.push(`Melissa: ${phone}`);
                }

                // 💾 Save Post after all enrichment
                await saveMessagedPost({
                    url: lead.url,
                    author,
                    location,
                    city: matchCity,
                    leadType: type,
                    phone,
                    email,
                    physical_address,
                    description
                });

                // 📣 Notify if we have a number
                // -------------------------------------------
// 📣 Notify if we have a number (FTN + Melissa cross-check)
// -------------------------------------------
                try {
                    // Always declare FTN result so it’s defined even if FTN failed
                    ftn = ftn || { success: false, mobile_phones: [], phones: [], provider: null, address: null };

                    const allPhones = [];

                    // ✅ Collect FTN phones (wireless first)
                    if (Array.isArray(ftn.mobile_phones) && ftn.mobile_phones.length) {
                        allPhones.push(...ftn.mobile_phones.map(p => p.number).filter(Boolean));
                    }

                    // ✅ Collect FTN landlines if present
                    if (Array.isArray(ftn.phones) && ftn.phones.length) {
                        const landlines = ftn.phones
                            .filter(p => p.type !== 'wireless')
                            .map(p => p.number)
                            .filter(Boolean);
                        allPhones.push(...landlines);
                    }

                    // ✅ Add Melissa fallback if FTN failed or returned nothing
                    if (melissa?.phone && !allPhones.includes(melissa.phone)) {
                        allPhones.push(melissa.phone);
                    }

                    const uniquePhones = [...new Set(allPhones)].filter(Boolean);
                    phone = phone || uniquePhones[0] || null; // pick best available

                    // ✅ Skip if still no phone at all
                    if (!phone) {
                        console.log('ℹ️ No phone after FTN + Melissa; skipping SMS notify.');
                        continue;
                    }

                    // ✅ Pick best address: prefer FTN, fallback to Melissa
                    physical_address = ftn?.address || melissa?.physical_address || physical_address || null;

                    // ✅ Build rich description summary
                    const providerText = ftn?.provider ? `Provider: ${ftn.provider}` : null;
                    const phoneSummary =
                        uniquePhones.length > 1
                            ? `Phones: ${uniquePhones.join(', ')}`
                            : `Phone: ${uniquePhones[0]}`;

                    const melissaTag = melissa?.source ? `Source: ${melissa.source}` : 'Source: Melissa';
                    const ftnTag = ftn?.success ? 'Source: FamilyTreeNow' : null;

                    descParts.push(
                        ...(providerText ? [providerText] : []),
                        phoneSummary,
                        ...(ftnTag ? [ftnTag] : []),
                        ...(melissaTag && !ftnTag ? [melissaTag] : [])
                    );

                    // ✅ Post to alert service
                    const resp = await postLeadAlert({
                        name: author,
                        phone,
                        lead_type: type, // canonIndustry runs inside postLeadAlert
                        city: matchCity,
                        description: descParts.length ? descParts.join(' | ') : null,
                        location,
                        physical_address,
                        message_sent_at: new Date().toISOString()
                    });

                    if (!resp.ok) {
                        console.warn('⚠️ Lead notify failed:', resp.error || resp);
                    } else {
                        console.log('📣 Lead notify sent:', resp.data);
                    }
                } catch (e) {
                    console.warn('⚠️ Lead notify failed:', e.message);
                }

            }
        }
    } catch (err) {
        console.error('❌ Fatal error:', err);
    } finally {
        // 🔴 NEW: also wipe on shutdown
        await clearNextdoorStorage(context, 'shutdown');

        console.log('🧼 Closing browser...');
        await new Promise(r => setTimeout(r, 30_000));
        await context.close();
        console.log('✅ All automations completed');
    }
};


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

