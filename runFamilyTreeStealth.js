// Usage:
//   PROXY_FILE=./proxies.txt TWOCAPTCHA_API_KEY=yourkey node runFamilyTreeStealth.js
//   or: PROXY_LINE="http://user:pass@host:port" node runFamilyTreeStealth.js
//
// Behavior:
// - loads proxies from PROXY_FILE (or PROXY_LINE)
// - rotates proxies on failure (HTTP 403/503 or immediate challenge)
// - uses a fresh profile dir per run to avoid carrying cookies/storage between attempts
// - applies small stealth init script to hide navigator.webdriver and similar
// - attempts to hook window.turnstile.render; tries 2captcha if available
// - saves screenshots and storageState for inspection

require('dotenv').config();
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const axios = require('axios');
const { chromium } = require('playwright');
const { Solver } = require('@2captcha/captcha-solver');
const ONE_PROXY = process.env.ONE_PROXY;
const PROXY_LIST_ENV = process.env.PROXY_LIST;
const TWO_KEY = process.env.TWOCAPTCHA_API_KEY || '';
const KEEP_OPEN = process.env.KEEP_BROWSER_OPEN === '1' || false;
const MAX_TRIES = Number(process.env.MAX_TRIES || 6);
const LOG_DIR = path.resolve(process.cwd(), 'ftn_debug');
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';



// simple parse that accepts common forms from your dashboard
function normalizeProxy(raw) {
    if (!raw) return null;
    raw = raw.trim();
    let m;
    // scheme://user:pass@host:port
    m = raw.match(/^(https?|http|socks5):\/\/([^@]+)@([^:\/]+):(\d+)$/i);
    if (m) {
        const proto = m[1].toLowerCase();
        const [username, password] = m[2].split(':');
        return { proto, host: m[3], port: Number(m[4]), username, password };
    }
    // host:port:user:pass
    m = raw.match(/^([^:]+):(\d+):([^:]+):([^:]+)$/);
    if (m) return { proto: 'http', host: m[1], port: Number(m[2]), username: m[3], password: m[4] };
    // user:pass@host:port (no scheme)
    m = raw.match(/^([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (m) return { proto: 'http', username: m[1], password: m[2], host: m[3], port: Number(m[4]) };
    // fallback host:port
    m = raw.match(/^([^:]+):(\d+)$/);
    if (m) return { proto: 'http', host: m[1], port: Number(m[2]) };
    throw new Error('Unrecognized proxy format: ' + raw);
}

async function pickAndOpenDetail(page, state) {
    try {
        console.log('🔎 Looking for "View Details" link...');

        const detailSelectors = [
            'a:has-text("View Details")',
            'button:has-text("View Details")',
            'a[href*="/record/"]',
            'a[href*="rid="]'
        ];

        let clicked = false;
        let href = null;

        // Try clicking one of the common selectors
        for (const sel of detailSelectors) {
            const el = page.locator(sel).first();
            if (await el.count()) {
                href = await el.getAttribute('href');
                console.log(`➡️ Found detail link (${sel}): ${href || 'no href'}`);

                if (href && !href.startsWith('http')) {
                    const base = new URL(page.url());
                    href = base.origin + href;
                }

                try {
                    await el.scrollIntoViewIfNeeded();
                    await el.click({ delay: 200 });
                    clicked = true;
                    break;
                } catch (clickErr) {
                    console.warn(`⚠️ Click failed for ${sel}: ${clickErr.message}`);
                }
            }
        }

        // If click failed or no element found, try direct navigation
        if (!clicked && href) {
            console.log('🌐 Navigating directly to record URL:', href);
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
            clicked = true;
        }

        if (!clicked) {
            console.warn('⚠️ Could not find or click any detail link.');
            return false;
        }

        // Wait for navigation or new content
        await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2500);

        // Confirm that we’re now on a detail page
        const isDetail = await page.evaluate(() => {
            const txt = document.body?.innerText || '';
            return /Possible Primary Phone|Current Address|Public Records|Phone Type/i.test(txt);
        });

        if (isDetail) {
            console.log('✅ Reached detail page successfully!');
            return true;
        }

        console.warn('⚠️ Clicked but no detail page detected — maybe Cloudflare intervened.');
        return false;
    } catch (err) {
        console.error('pickAndOpenDetail() failed:', err.message);
        return false;
    }
}



async function scrapeBasicResult(page) {
    const out = { phone: null, email: null, physical_address: null };

    try {
        const phoneCand = [
            'a[href^="tel:"]',
            'a[href*="phone="]',
            'a:has-text("Phone")',
            'div:has(span:has-text("Phone")) a, div:has-text("Phone") a',
            'td:has-text("Phone") ~ td',
            'li:has-text("Phone")',
            '.phone, .phones a, .phones',
        ];
        for (const sel of phoneCand) {
            const el = page.locator(sel).first();
            if (await el.count()) {
                const t = (await el.innerText().catch(()=>'')) || (await el.getAttribute('href').catch(()=>'')) || '';
                const phone = t.replace(/^tel:/, '').trim();
                if (/\d{3}[-.\s)]?\d{3}[-.\s]?\d{4}/.test(phone)) { out.phone = phone; break; }
            }
        }
    } catch {}

    try {
        const emailCand = [
            'a[href^="mailto:"]',
            'a[href*="email="]',
            'a:has-text("@")',
            'td:has-text("Email") ~ td',
            'li:has-text("@")',
            '.email, .emails a, .emails',
        ];
        for (const sel of emailCand) {
            const el = page.locator(sel).first();
            if (await el.count()) {
                const t = (await el.innerText().catch(()=>'')) || (await el.getAttribute('href').catch(()=>'')) || '';
                const email = t.replace(/^mailto:/, '').trim();
                if (email.includes('@')) { out.email = email; break; }
            }
        }
    } catch {}

    try {
        const addrCand = [
            'td:has-text("Address") ~ td',
            'div:has(span:has-text("Address")) span:not(:has(*))',
            'address',
            'li:has-text("Address")',
            '[data-field="address"]',
            '.address, .addresses li, .addresses',
        ];
        for (const sel of addrCand) {
            const el = page.locator(sel).first();
            if (await el.count()) {
                const t = ((await el.innerText().catch(()=>'')) || '').trim();
                if (t && t.length > 6) { out.physical_address = t.replace(/\s*\n\s*/g, ', '); break; }
            }
        }
    } catch {}

    return out;
}

async function scrapeWirelessDetail(page) {
    const out = { mobile_phones: [], phones: [], address: null };

    try {
        // === PHONE PARSING ===
        const entries = await page.$$eval('.panel-body .col-xs-12.col-md-6', nodes => {
            const results = [];
            for (const el of nodes) {
                const text = el.innerText.trim();
                const numAnchor = el.querySelector('a[href*="phoneno="]');
                const number = numAnchor ? numAnchor.innerText.trim() : null;
                if (!number) continue;

                const typeMatch = text.match(/\b(Wireless|Landline|Voip)\b/i);
                const type = typeMatch ? typeMatch[1].toLowerCase() : 'unknown';
                const lastReported = (text.match(/Last reported\s+([A-Za-z]+\s+\d{4})/) || [])[1] || null;
                const carrier = (text.match(/\b(AT&T|Verizon|T-Mobile|Sprint|Metro|Cricket|Frontier|Southwestern Bell|Time Warner Cable)\b/i) || [])[0] || null;
                const isPrimary = /Possible Primary Phone/i.test(text);

                results.push({ number, type, carrier, lastReported, isPrimary, raw: text });
            }
            return results;
        });

        for (const r of entries) {
            if (r.type === 'wireless') out.mobile_phones.push(r);
            else out.phones.push(r);
        }

        // === ADDRESS PARSING ===
        try {
            // Look specifically for the "Current Address" panel
            const addrText = await page.evaluate(() => {
                const panel = Array.from(document.querySelectorAll('.panel.panel-primary'))
                    .find(p => p.querySelector('.panel-heading')?.innerText?.match(/Current Address/i));

                if (!panel) return null;

                // Get the address text (e.g. "1709 Hastings Ct Plano, TX 75023")
                const link = panel.querySelector('a.linked-record');
                if (!link) return null;

                // Flatten newlines and tags
                return link.innerText
                    .replace(/\s*\n\s*/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
            });

            if (addrText) {
                out.address = addrText;
                console.log('🏠 Detected address:', addrText);
            } else {
                console.log('⚠️ No address found on page.');
            }
        } catch (e) {
            console.warn('Address extraction failed:', e.message);
        }

        // === FINAL LOG ===
        console.log('📞 Parsed phone records:', out);
    } catch (e) {
        console.warn('scrapeWirelessDetail failed:', e.message);
    }

    return out;
}





async function probeExitIp(proxy) {
    try {
        // simple structure sanity check — no external HTTP requests
        if (!proxy || !proxy.host || !proxy.port) {
            return { ok: false, error: 'Invalid proxy object' };
        }

        console.log(`🧪 [Probe] Testing proxy format: ${proxy.proto || 'http'}://${proxy.host}:${proxy.port}`);
        if (proxy.username && proxy.password) {
            console.log(`🔐 [Probe] Proxy has authentication (user: ${proxy.username})`);
        } else {
            console.log('ℹ️ [Probe] Proxy has no authentication credentials.');
        }

        // Just return "ok" — assume valid unless Playwright later fails to connect
        return { ok: true, data: { host: proxy.host, port: proxy.port } };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

async function attemptWithProxy(rawProxy, tryIndex, target) {
    const cleaned = rawProxy.trim();
    let proxy;
    try {
        proxy = normalizeProxy(cleaned);
    } catch (e) {
        console.error('Proxy parse failed:', e.message);
        return { success: false, reason: 'parse', error: e.message };
    }

    console.log(`\n--- Attempt #${tryIndex} using proxy: ${proxy.host}:${proxy.port} (user: ${!!proxy.username}) ---`);

    const profileDir = path.resolve(`./ftn-profile-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
    await fsp.mkdir(profileDir, { recursive: true });

    const proxyForPlaywright = proxy
        ? {
            server:
                proxy.proto === 'socks5'
                    ? `socks5://${proxy.host}:${proxy.port}`
                    : `http://${proxy.host}:${proxy.port}`,
            username: proxy.username,
            password: proxy.password,
        }
        : undefined;

    const baseLaunchOpts = {
        headless: false, // must be headful for JS+WebGL checks
        channel: 'chrome',
        proxy: proxyForPlaywright,
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1366,768',
            '--enable-gpu',
            '--use-gl=egl',
            '--enable-webgl',
            '--ignore-certificate-errors',
            '--allow-running-insecure-content',
        ],
    };

    let browser, context, page;
    try {
        browser = await chromium.launch(baseLaunchOpts);
        context = await browser.newContext({ viewport: { width: 1366, height: 768 } });

        // --- Anti-detection fingerprint injection ---
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
            Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            window.chrome = { runtime: {} };
        });

        page = await context.newPage();

        console.log(`Navigating to target: ${target}`);
        await page.goto(target, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(7000 + Math.random() * 2000);

        // --- Detect Cloudflare JS block early ---
        const bodyText = await page.evaluate(() => document.body?.innerText || '');
        if (/Please enable JS/i.test(bodyText)) {
            console.warn('⚠️ Cloudflare JS block detected — rotating proxy...');
            await browser.close();
            return { success: false, reason: 'js_blocked' };
        }

        // --- Wait for FunCaptcha/ArkoseLabs iframe ---
// --- Wait for FunCaptcha/ArkoseLabs iframe ---
        let arkoseFrame = null;
        try {
            const iframeEl = await page.$('iframe[src*="arkoselabs"]');
            if (iframeEl) {
                arkoseFrame = iframeEl;
                console.log('🧩 ArkoseLabs FunCaptcha detected — solving via 2Captcha...');
            }
        } catch (e) {
            console.warn('ArkoseLabs iframe check failed:', e.message);
        }


        if (arkoseFrame) {
            console.log('🧩 ArkoseLabs FunCaptcha detected — solving via 2Captcha...');

            // Extract sitekey from iframe src
            const sitekey = await page.evaluate(() => {
                const ifr = document.querySelector('iframe[src*="arkoselabs"]');
                if (!ifr) return null;
                const m = ifr.src.match(/[?&]public_key=([\w-]+)/);
                return m ? m[1] : null;
            });

            if (sitekey) {
                console.log('🎯 FunCaptcha sitekey:', sitekey);
                const apiKey = process.env.TWOCAPTCHA_API_KEY;
                if (!apiKey) {
                    console.warn('❌ Missing TWOCAPTCHA_API_KEY');
                    return { success: false, reason: 'no_2captcha_key' };
                }

                const payload = {
                    clientKey: apiKey,
                    task: {
                        type: 'FunCaptchaTaskProxyless',
                        websiteURL: target,
                        websitePublicKey: sitekey,
                        funcaptchaApiJSSubdomain: 'client-api.arkoselabs.com',
                        userAgent: UA,
                    },
                };

                const create = await axios.post('https://api.2captcha.com/createTask', payload);
                const taskId = create.data.taskId;
                console.log('🪄 Created 2Captcha task ID:', taskId);

                // poll for result
                let token = null;
                for (let i = 0; i < 25; i++) {
                    await new Promise(r => setTimeout(r, 6000));
                    const res = await axios.post('https://api.2captcha.com/getTaskResult', {
                        clientKey: apiKey,
                        taskId,
                    });
                    if (res.data.status === 'ready') {
                        token = res.data.solution.token;
                        break;
                    }
                }

                if (!token) {
                    console.warn('❌ FunCaptcha solver timed out — rotating proxy...');
                    await browser.close();
                    return { success: false, reason: 'fun_captcha_timeout' };
                }

                console.log('✅ FunCaptcha solved — injecting token...');
                await page.evaluate(tok => {
                    const el = document.querySelector('input[name="fc-token"]');
                    if (el) el.value = tok;
                    const form = document.querySelector('form');
                    if (form) form.submit();
                }, token);

                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await page.waitForTimeout(5000);
            }
        }

        // --- Wait for DOM stabilization / FTN load ---
        console.log('⏳ Waiting up to 15 s for FTN DOM/text to stabilize...');
        await page.waitForFunction(
            () => document.querySelector('.panel-body') || /Results|record|Phone/i.test(document.body.innerText),
            { timeout: 15000 }
        );

        const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
        console.log('✅ Page text indicates results/challenge visible.\n', text);

        // --- Continue to detail extraction ---
        const detailOk = await pickAndOpenDetail(page, '');

        if (!detailOk) {
            console.warn('⚠️ Did not reach detail page, staying on results.');
            // Try basic fallback immediately on results
            const basic = await scrapeBasicResult(page);
            console.log('🧩 Basic scrape from results:', basic);
            await browser.close();
            return { success: true, data: basic, reason: 'basic_only' };
        }

// Proceed only if detail page confirmed
        await page.waitForTimeout(3000); // let content render

// === Primary scrape ===
        let detail = await scrapeWirelessDetail(page);

// === Fallback scrape if detail empty ===
        if (
            !detail ||
            ((!detail.mobile_phones?.length) && (!detail.phones?.length) && (!detail.address))
        ) {
            console.log('⚙️ Wireless detail empty — running basic scrape as fallback...');
            const basic = await scrapeBasicResult(page);
            detail = { ...detail, ...basic };
        }

        if (
            detail?.mobile_phones?.length ||
            detail?.phones?.length ||
            detail?.address ||
            detail?.phone ||
            detail?.email ||
            detail?.physical_address
        ) {
            console.log('✅ Got contact info:', detail);
            await browser.close();
            return { success: true, data: detail };
        }

        console.warn('⚠️ No data found even after fallback.');
        await browser.close();
        return { success: false, reason: 'no_data' };

    } catch (err) {
        console.error('❌ Attempt error:', err.message || err);
        try {
            await browser?.close();
        } catch {}
        return { success: false, reason: 'exception', error: err.message };
    }
}



// Async runner (IIFE)
; // ============================================================
// 🧩 Exportable Runner
// ============================================================

async function runFamilyTreeStealth({ first = '', last =  '', city = '' } = {}) {


    if (!first || !last || !city) {
        console.error('Missing required parameters for runFamilyTreeStealth:', { first, last, city });
        return { ok: false, reason: 'missing_params' };
    }

    async function loadProxyLines() {
        // ✅ Priority 1: explicit single ONE_PROXY line
        if (ONE_PROXY) {
            console.log('🌐 Using explicit ONE_PROXY.');
            return [ONE_PROXY.trim()];
        }

        // ✅ Priority 2: multi-line PROXY_LIST env var
        if (PROXY_LIST_ENV) {
            const list = PROXY_LIST_ENV
                .split(/\r?\n|[|,]+|\s+(?=http)/) // supports pipes, commas, or newlines
                .map(s => s.trim())
                .filter(Boolean);

            if (list.length) {
                console.log(`🌐 Loaded ${list.length} proxies from PROXY_LIST env.`);
                return list;
            }
        }

        // ✅ Priority 3: default Plano fallback
        console.warn('⚠️ No proxies found — defaulting to Plano proxy.');
        const DEFAULT_PLANO_PROXY =
            'http://u740e583c56c805ce-zone-custom-region-us-st-texas-city-plano-session-default:u740e583c56c805ce@170.106.118.114:2333';

        return [DEFAULT_PLANO_PROXY];
    }

    const lines = await loadProxyLines();

    if (!lines.length && !ONE_PROXY) {
        console.warn('No proxies found in PROXY_List and no ONE_PROXY provided. Exiting.');
        return { ok: false, reason: 'no_proxies' };
    }



    const pool = lines.length ? lines : [ONE_PROXY];

    // 🎯 Build dynamic FTN URL for the given person
    const target = `https://www.familytreenow.com/search/genealogy/results?first=${encodeURIComponent(first)}&last=${encodeURIComponent(last)}&citystatezip=${encodeURIComponent(city)},+CA`;

    console.log(`🎯 Target URL: ${target}`);

    // 🔁 Rotate proxies and attempt scraping
    for (let i = 0, tries = 0; tries < MAX_TRIES && i < pool.length; i = (i + 1) % pool.length, tries++) {
        const proxy = pool[i];
        console.log(`\n== Try ${tries + 1} of up to ${MAX_TRIES} using proxy index ${i} ==`);

        // 🧠 Pass the target directly
        const res = await attemptWithProxy(proxy, tries + 1, target);

        if (res.success) {
            console.log('✅ Success!', res);

            const inner = res.data || {};
            const data = {
                mobile_phones: inner.mobile_phones || [],
                phones: inner.phones || [],
                address: inner.address || null,
                provider: inner.mobile_phones?.[0]?.carrier || null,
                screenshot: res.screenshot,
                state: res.state,
            };

            return {
                success: true,
                reason: 'scraped_ok',
                proxyUsed: res.proxyUsed || null,
                data,
            };
        } else {
            console.warn('Proxy attempt failed:', res.reason || res.error || 'unknown', res);
        }
    }

    console.error('All attempts exhausted or max tries reached. Check logs under', LOG_DIR);
    return { ok: false, reason: 'exhausted' };







}

module.exports = { runFamilyTreeStealth };
