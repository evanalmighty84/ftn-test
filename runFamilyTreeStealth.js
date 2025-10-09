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

const TARGET = process.env.TARGET_URL || 'https://www.familytreenow.com/search/genealogy/results?first=Lauren&last=Stevens&citystatezip=Plano,+TX';
const PROXY_FILE = process.env.PROXY_FILE || './proxies.txt';
const RAW_PROXY = process.env.PROXY_LINE || null;
const TWO_KEY = process.env.TWOCAPTCHA_API_KEY || '';
const KEEP_OPEN = process.env.KEEP_BROWSER_OPEN === '1' || false;
const MAX_TRIES = Number(process.env.MAX_TRIES || 6);
const LOG_DIR = path.resolve(process.cwd(), 'ftn_debug');
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function ensureLogDir() {
    try { await fsp.mkdir(LOG_DIR, { recursive: true }); } catch (e) {}
}

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
    const candidates = [
        'table tbody tr',
        '.search-results .result',
        '.results .result',
        'ul.results > li',
        '.people-results li',
        '.content .result',
    ];

    const findSel = async () => {
        for (const sel of candidates) {
            try {
                const found = await page.locator(sel).first();
                if (await found.count()) return sel;
            } catch (e) {}
        }
        return null;
    };

    let resultsSel = await findSel();
    if (!resultsSel) {
        await page.waitForTimeout(800);
        const cur = await page.evaluate(() => location.href);
        await page.evaluate((url) => location.href = url, cur);
        await page.waitForTimeout(1000);
        resultsSel = await findSel();
    }
    if (!resultsSel) return false;

    const results = page.locator(resultsSel);
    const rCount = await results.count();
    if (!rCount) return false;

    const pref = (state || '').toUpperCase();
    for (let i = 0; i < Math.min(rCount, 50); i++) {
        const row = results.nth(i);
        const text = ((await row.innerText().catch(() => '')) || '').trim();
        if (!pref || text.includes(pref)) {
            const href = await row.locator(
                'a:has-text("View"), a:has-text("Details"), a:has-text("Profile"), a[href*="/record/"], a[href*="detail"], a[href*="profile"]'
            ).first().getAttribute('href').catch(() => null);
            if (href) {
                const url = new URL(href, await page.evaluate(() => location.href)).toString();
                await page.evaluate((u) => { location.href = u; }, url);
                await page.waitForTimeout(3000);
                return true;
            }
        }
    }

    // fallback: just use the first row's link if nothing matched
    const firstHref = await results.first().locator('a[href]').first().getAttribute('href').catch(() => null);
    if (firstHref) {
        const url = new URL(firstHref, await page.evaluate(() => location.href)).toString();
        await page.evaluate((u) => { location.href = u; }, url);
        await page.waitForTimeout(3000);
        return true;
    }

    return false;
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



async function loadProxyLines() {
    const RAW_PROXY = process.env.RAW_PROXY;
    const PROXY_FILE_ENV = process.env.PROXY_FILE;
    const PROXY_LIST_ENV = process.env.PROXY_LIST;

    // ✅ Priority 1: explicit single RAW_PROXY line
    if (RAW_PROXY) return [RAW_PROXY.trim()];

    // ✅ Priority 2: multi-line PROXY_LIST env var
    if (PROXY_LIST_ENV) {
        return PROXY_LIST_ENV
            .split(/\r?\n|[|,]+|\s+(?=http)/)   // support pipes, commas, newlines, or spaces before "http"
            .map(s => s.trim())
            .filter(Boolean);
    }


    // ✅ Priority 3: load from file path (absolute or local)
    // Detect local vs Railway
    const isRailway = !!process.env.RAILWAY_ENVIRONMENT;
    const defaultPath = isRailway
        ? '/app/proxies.txt'
        : path.resolve('./proxies.txt');

    const proxyPath = PROXY_FILE_ENV
        ? path.resolve(PROXY_FILE_ENV)
        : defaultPath;

    try {
        if (fs.existsSync(proxyPath)) {
            const txt = await fsp.readFile(proxyPath, 'utf8');
            return txt
                .split(/\r?\n/)
                .map(s => s.trim())
                .filter(Boolean);
        } else {
            console.warn(`⚠️ Proxy file not found at ${proxyPath}`);
            return [];
        }
    } catch (e) {
        console.warn(`⚠️ Could not read proxy file at ${proxyPath}:`, e.message);
        return [];
    }
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

async function attemptWithProxy(rawProxy, tryIndex) {
    const cleaned = rawProxy.trim();
    let proxy;
    try {
        proxy = normalizeProxy(cleaned);
    } catch (e) {
        console.error('Proxy parse failed:', e.message);
        return {success: false, reason: 'parse', error: e.message};
    }

    console.log(`\n--- Attempt #${tryIndex} using proxy: ${proxy.host}:${proxy.port} (user: ${!!proxy.username}) ---`);
    // probe
    const probe = await probeExitIp(proxy);
    if (!probe.ok) {
        console.warn('Exit IP probe failed:', probe.error);
        // still continue: sometimes ipinfo blocks but browser will still work
    } else {
        console.log('Exit IP probe success:', probe.data);
    }

    // new fresh profile directory
    const profileDir = path.resolve(`./ftn-profile-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
    await fsp.mkdir(profileDir, {recursive: true});

    // stealth init script to hide webdriver and some flags (keeps it minimal)
    const stealthInit = `
    // minimal stealth adjustments
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    // mimic Chrome permissions
    const originalQuery = window.navigator.permissions.query;
    try {
      window.navigator.permissions.__query = originalQuery;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : originalQuery(parameters)
      );
    } catch(e) {}
    // small helper for controlled navigation
    window.__rtNavigate = async function (url) {
      try {
        location.href = url;
        return true;
      } catch(e) { return false; }
    };
  `;

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

    let browser, context, page;

    try {
        // === Environment flags ===
        const useChrome = process.env.USE_CHROME === '1';
        // 🚫 Force headless in Railway or Docker — no X11


        // --- Base Chromium launch options ---
        const isRailway = !!process.env.RAILWAY_ENVIRONMENT;
        const headless = isRailway ? false : true;

        const baseLaunchOpts = {
            headless,
            viewport: { width: 1366, height: 768 },
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--use-gl=swiftshader',
                '--disable-software-rasterizer',
                '--window-size=1366,768',
            ],
        };



        if (proxyForPlaywright) baseLaunchOpts.proxy = proxyForPlaywright;

        const opts = useChrome ? { ...baseLaunchOpts, channel: 'chrome' } : baseLaunchOpts;
        const profileDir2 = path.resolve(
            `./ftn-profile-${Date.now()}-${Math.floor(Math.random() * 10000)}`
        );

        context = await chromium.launchPersistentContext(profileDir2, opts);

        console.log(
            `✅ Chromium launched (${useChrome ? 'chrome channel' : 'default'}) in headless mode.`
        );


        // --- turnstile hook injected BEFORE navigation ---
// Note: this must be added before page.goto(); we assume `context` exists
        const turnstileHook = `
(() => {
  // Poll and intercept turnstile.render as early as possible
  const i = setInterval(() => {
    try {
      if (window.turnstile && typeof window.turnstile.render === 'function') {
        clearInterval(i);
        const orig = window.turnstile.render.bind(window.turnstile);
        window.turnstile.render = (a, b) => {
          try {
            // capture the important fields Cloudflare docs ask for
            const payload = {
              type: 'TurnstileTaskProxyless',
              websiteKey: b && b.sitekey ? b.sitekey : null,
              websiteURL: window.location.href,
              data: b && b.cData ? b.cData : null,
              pagedata: b && b.chlPageData ? b.chlPageData : null,
              action: b && b.action ? b.action : null,
              userAgent: navigator.userAgent || null
            };
            // expose for page.evaluate to pick up
            try { window.__tsPayload = payload; } catch (e) {}
            try { window.__tsCallback = b && b.callback ? b.callback : null; } catch (e) {}
            // keep page behavior: call original render so UI still shows
            try { return orig(a, b); } catch(e) { /* ignore */ }
            return 'hooked';
          } catch (e) { return 'error'; }
        };
      }
    } catch (e) { /* ignore injection errors */ }
  }, 20);

  // also expose a small nav helper so pickAndOpenDetail / other code can reuse it
  try {
    if (!window.__rtNavigate) {
      window.__rtNavigate = async function (url) {
        try { window.location.href = url; return true; } catch(e) { return false; }
      };
    }
  } catch (e) {}
})();
`;

// add the init script to the context so it's present before any page JS runs
        try {
            await context.addInitScript(turnstileHook);
        } catch (e) {
            console.warn('addInitScript failed:', e && e.message ? e.message : e);
        }

        // Block new tabs/popups from being opened by JS (e.g. window.open)
        await context.addInitScript(() => {
            window.open = (...args) => {
                console.warn('⚠️ Blocked window.open attempt:', args);
                return null;
            };
        });

// now create/open page and navigate
        console.log('Navigating to target (with pre-injected Turnstile hook)...');
        const page = await context.newPage();

// Use a slightly stronger wait strategy: try networkidle first (if it completes quickly),
// but fall back to domcontentloaded to avoid long stalls.
        try {
            await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
            console.warn('domcontentloaded goto failed (falling back to domcontentloaded):', e?.message || e);
            try {
                await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch (err) {
                console.warn('domcontentloaded goto also had an error (continuing):', err?.message || err);
            }
        }

// ---------- SMART WAIT FOR PAGE RENDER ----------
        try {
            await Promise.race([
                page.waitForSelector('.panel-body', { timeout: 10000 }), // FTN results panel
                page.waitForSelector('iframe[src*="captcha"], iframe[src*="turnstile"], div[data-sitekey]', { timeout: 10000 }) // Cloudflare challenge
            ]);
            console.log('✅ Results or Turnstile detected — continuing...');
        } catch {
            console.warn('⚠️ Neither results nor Turnstile detected within 10s — continuing anyway...');
        }

// Give the page an extra 3 seconds for FTN JS to finish rendering
        await page.waitForTimeout(3000);

// Capture partial body for debugging
        const htmlSnippet = await page.evaluate(() => document.body.innerText.slice(0, 400));
        console.log('🧩 BODY SNIPPET:\n', htmlSnippet);
        // 🔍 Try to follow the "View Details" link
        const ridLink = await page.evaluate(() => {
            const link = document.querySelector('a[href*="/search/people/results?rid="]');
            return link ? link.href : null;
        });

        // after we find and goto the ridLink
        if (ridLink) {
            console.log('➡️ Found RID link:', ridLink);
            await page.goto(ridLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForSelector('.panel-body', { timeout: 8000 });

            // instead of manually $$eval() here, call the real parser:
            const detail = await scrapeWirelessDetail(page);
            console.log('📞 Wireless Detail Extracted:', JSON.stringify(detail, null, 2));
        }
        else {
            console.warn('⚠️ No RID link detected.');
        }


// ---------- IMMEDIATE RID NAVIGATION SNIPPET ----------
        console.log('Trying immediate RID navigation (top-level + frames) and hard-stubbing window.open...');


        const forcedNav = await page.evaluate(async () => {
            try {
                // prevent new tabs/windows from being opened by page scripts
                try {
                    window.open = function () {
                        return null;
                    };
                    // also catch hyperlink targets that try to open new windows
                    const origCreateElement = document.createElement;
                    // don't override further if env is hostile — keep minimal
                } catch (e) {
                }

                function findRidInDoc(doc) {
                    try {
                        // prefer absolute href on anchor nodes
                        const a = doc.querySelector('a[href*="rid="]');
                        if (a && a.href) return a.href;
                        // sometimes links are in buttons with data-href
                        const b = doc.querySelector('[data-href*="rid="], [href*="rid="]');
                        if (b) {
                            return b.getAttribute('href') || b.getAttribute('data-href') || null;
                        }
                        return null;
                    } catch (e) {
                        return null;
                    }
                }

                // 1) top-level
                let url = findRidInDoc(document);
                if (url) return url;

                // 2) quick scan of iframes (try to access top-level frames first)
                for (const fr of Array.from(window.frames || [])) {
                    try {
                        const fd = fr.document || (fr.contentDocument ? fr.contentDocument : null);
                        if (fd) {
                            const found = findRidInDoc(fd);
                            if (found) return (new URL(found, location.href)).toString();
                        }
                    } catch (e) {
                        // cross-origin frames will throw — ignore
                    }
                }

                // 3) scan all iframe elements and try safe access
                for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
                    try {
                        const idoc = iframe.contentDocument;
                        if (idoc) {
                            const found = findRidInDoc(idoc);
                            if (found) return (new URL(found, location.href)).toString();
                        }
                    } catch (e) { /* ignore cross-origin frames */
                    }
                }

                return null;
            } catch (err) {
                return null;
            }
        });

// If we found a rid URL, navigate to it immediately (location.href so it's consistent)
        if (forcedNav) {
            console.log('Found RID link — forcing navigation to:', forcedNav);
            try {
                console.log('Navigating directly to RID URL:', forcedNav);

                // navigate via JS
                await page.evaluate(u => (window.location.href = u), forcedNav).catch(() => {});
                // wait explicitly for navigation to settle
                await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
                await page.waitForTimeout(2000); // small buffer for scripts/images to load

                // ✅ check for phone data once page is stable
                const hasPhones = await page.$('div.panel-body, .phones, a[href*="phoneno="]');
                if (hasPhones) {
                    console.log('✅ Detected phone data already visible — skipping Turnstile and solver phase.');

                    const scraped = await scrapeWirelessDetail(page).catch(err => {
                        console.warn('scrapeWirelessDetail failed:', err.message);
                        return {mobile_phones: [], phones: []};
                    });

                    console.log('📞 Parsed wireless detail immediately:', scraped);

                    // save artifacts & close
                    const hasData =
                        (scraped.mobile_phones && scraped.mobile_phones.length > 0) ||
                        (scraped.phones && scraped.phones.length > 0) ||
                        scraped.address;

                    if (hasData) {
                        console.log('🎯 Success — valid data found, returning to parent function.');

                        const shot = path.join(LOG_DIR, `phones-visible-${Date.now()}.png`);
                        await page.screenshot({path: shot, fullPage: true}).catch(() => {
                        });
                        const statePath = path.join(LOG_DIR, `state-visible-${Date.now()}.json`);
                        await context.storageState({path: statePath}).catch(() => {
                        });


                        try {
                            await page?.close();
                        } catch {
                        }
                        try {
                            await context?.close();
                        } catch {
                        }
                        try {
                            await browser?.close();
                        } catch {
                        }

                        // ✅ Return full structured object to parent
                        return {
                            success: true,
                            reason: 'scraped_ok',
                            proxyUsed: proxy.host,
                            data: scraped,
                            screenshot: shot,
                            state: statePath
                        };
                    }
                }

            } catch (e) {
                console.warn('Forced navigation attempt failed:', e && e.message ? e.message : e);
            }

        } else {
            console.log('No RID link found on initial scan.');
        }

// short pause to give in-page scripts a chance to execute / redirect complete
        await page.waitForTimeout(1200);

// Wait for a Turnstile-like iframe (if any) to appear — many Cloudflare flows put the widget in an iframe.
// Don't fail if it doesn't appear; just continue after the timeout.
        try {
            await page.waitForSelector('iframe[src*="turnstile"], iframe[src*="challenge"], iframe[src*="cloudflare"]', {timeout: 10000});
            console.log('Turnstile-like iframe appeared (or at least an iframe matched the selector).');
        } catch (e) {
            console.log('No obvious Turnstile iframe found within timeout; will still attempt to read payload from frames.');
        }

// Helper: attempt to read __tsPayload; robust to navigation/context-destroyed by retrying a few times
        async function readPayloadFromFrames(retries = 3, delayMs = 500) {
            for (let attempt = 1; attempt <= retries; attempt++) {
                try {
                    // First, try top-level frame
                    const top = await page.evaluate(() => {
                        try {
                            return window.__tsPayload || null;
                        } catch (e) {
                            return null;
                        }
                    });
                    if (top) return top;

                    // If nothing in top, check child frames
                    const frames = page.frames();
                    for (const f of frames) {
                        try {
                            const p = await f.evaluate(() => {
                                try {
                                    return window.__tsPayload || null;
                                } catch (e) {
                                    return null;
                                }
                            });
                            if (p) return p;
                        } catch (frameErr) {
                            // frame might be navigating/blocked; ignore and continue
                        }
                    }

                    // not found this attempt
                    if (attempt < retries) await page.waitForTimeout(delayMs);
                } catch (err) {
                    // Typical error: "Execution context was destroyed" when a navigation happened.
                    const msg = err && err.message ? err.message : String(err);
                    console.warn(`readPayloadFromFrames attempt ${attempt} failed: ${msg}`);
                    if (attempt < retries) {
                        await page.waitForTimeout(delayMs);
                        continue;
                    } else {
                        return null;
                    }
                }
            }
            return null;
        }

// Try reading payload with retries (covers mid-navigation race conditions)
        const payload = await readPayloadFromFrames(6, 500);

        if (!payload) {
            console.warn('No Turnstile payload captured (could be in iframe or Cloudflare used different flow).');
            // save screenshot + storage to help debugging
            try {
                const shotPath = path.join(LOG_DIR, `no-payload-${Date.now()}.png`);
                await page.screenshot({path: shotPath, fullPage: true}).catch(() => {
                });
                const statePath = path.join(LOG_DIR, `no-payload-state-${Date.now()}.json`);
                await context.storageState({path: statePath}).catch(() => {
                });
                console.log('Saved artifacts for inspection:', shotPath, statePath);
            } catch (e) { /* ignore */
            }
        } else {
            console.log('Captured Turnstile payload:', {
                websiteKey: payload.websiteKey || payload.sitekey || null,
                websiteURL: payload.websiteURL || payload.url || null,
                action: payload.action || null,
                userAgent: payload.userAgent ? String(payload.userAgent).slice(0, 80) : null
            });
        }


// also capture a short snippet of body text for logging / heuristics
        const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '').catch(() => '');

        if (!payload) {
            console.warn('No Turnstile payload captured (could be in iframe or Cloudflare used different flow).');
            // save screenshot + storage to help debugging
            try {
                const shotPath = path.join(LOG_DIR, `no-payload-${Date.now()}.png`);
                await page.screenshot({path: shotPath, fullPage: true}).catch(() => {
                });
                const statePath = path.join(LOG_DIR, `no-payload-state-${Date.now()}.json`);
                await context.storageState({path: statePath}).catch(() => {
                });
                console.log('Saved artifacts for inspection:', shotPath, statePath);
            } catch (e) { /* ignore */
            }
        } else {
            console.log('Captured Turnstile payload:', {
                websiteKey: payload.websiteKey,
                websiteURL: payload.websiteURL,
                action: payload.action,
                userAgent: payload.userAgent ? payload.userAgent.slice(0, 80) : null
            });
        }


        if (!payload) {
            console.warn('No Turnstile payload captured (could be in iframe or non-Turnstile challenge). Saving screenshot and storage for inspection.');
            const s1 = path.join(LOG_DIR, `screenshot-no-payload-${Date.now()}.png`);
            await page.screenshot({path: s1, fullPage: true}).catch(() => {
            });
            const statePath = path.join(LOG_DIR, `storage-no-payload-${Date.now()}.json`);
            await context.storageState({path: statePath}).catch(() => {
            });
            console.log('Saved screenshot/state:', s1, statePath);
            await context.close().catch(() => {
            });
            await browser.close().catch(() => {
            });
            return {success: false, reason: 'no_payload', probe, profileDir, screenshot: s1, state: statePath};
        }

        console.log('Turnstile sitekey detected:', payload.websiteKey);

        // If 2captcha key is not set, bail to manual solve path
        if (!TWO_KEY) {
            console.warn('TWOCAPTCHA_API_KEY not set. Pausing for manual solve. Press ENTER in terminal when done.');
            // leave browser open for manual solve
            await new Promise((resolve) => {
                process.stdin.resume();
                process.stdin.once('data', () => {
                    process.stdin.pause();
                    resolve();
                });
            });
            const s2 = path.join(LOG_DIR, `screenshot-manual-${Date.now()}.png`);
            await page.screenshot({path: s2, fullPage: true}).catch(() => {
            });
            const statePath2 = path.join(LOG_DIR, `storage-manual-${Date.now()}.json`);
            await context.storageState({path: statePath2}).catch(() => {
            });
            console.log('Saved after manual solve:', s2, statePath2);
            if (!KEEP_OPEN) {
                await context.close().catch(() => {
                });
                await browser.close().catch(() => {
                });
            }
            return {success: true, manual: true, screenshot: s2, state: statePath2};
        }

        // prepare 2captcha solver and solver proxy string (matching browser exit IP ideally)
        const solver = new Solver(TWO_KEY);
        const solverProxyString = proxy.username ? (proxy.proto === 'socks5' ? `socks5://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}` : `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`) : null;

        // build tasks to try: prefer proxy-enabled TurnstileTask if we have solver proxy string
        const variants = [];
        if (solverProxyString) variants.push({
            type: 'TurnstileTask',
            websiteKey: payload.websiteKey,
            websiteURL: payload.websiteURL,
            proxy: solverProxyString
        });
        variants.push({type: 'TurnstileTaskProxyless', websiteKey: payload.websiteKey, websiteURL: payload.websiteURL});

        let token = null, lastErr = null;
        for (const v of variants) {
            try {
                console.log('Submitting to 2captcha with type:', v.type, v.proxy ? '(with proxy)' : '(proxyless)');
                const res = await solver.solve(v);
                // library often returns { data: '...' } or string
                const t = res?.data || res?.token || (typeof res === 'string' ? res : null);
                if (t) {
                    token = t;
                    break;
                }
            } catch (err) {
                lastErr = err;
                console.warn('Solver attempt failed:', err && err.message ? err.message : err);
            }
        }

        if (!token) {
            console.warn('Solver did not return a token. Saving artifacts and returning failure for this proxy.');
            const s3 = path.join(LOG_DIR, `screenshot-solver-fail-${Date.now()}.png`);
            await page.screenshot({path: s3, fullPage: true}).catch(() => {
            });
            const statePath3 = path.join(LOG_DIR, `storage-solver-fail-${Date.now()}.json`);
            await context.storageState({path: statePath3}).catch(() => {
            });
            await context.close().catch(() => {
            });
            await browser.close().catch(() => {
            });
            return {
                success: false,
                reason: 'solver_failed',
                error: lastErr && lastErr.message,
                screenshot: s3,
                state: statePath3
            };
        }

        console.log('Token acquired (truncated):', String(token).slice(0, 30));

        // inject token and call callback if present
        await page.evaluate((token) => {
            try {
                const input = document.querySelector('input[name="cf-turnstile-response"], input[name="g-recaptcha-response"]');
                if (input) input.value = token;

                if (window.__tsCallback && typeof window.__tsCallback === 'function') {
                    window.__tsCallback(token);
                } else {
                    // fallback: try triggering form
                    const form = document.querySelector('form');
                    if (form) {
                        form.dispatchEvent(new Event('submit', {bubbles: true}));
                    }
                }
            } catch (e) {
            }
        }, token);

        // ✅ Extracted modifications only — insert into your existing script after token injection

// wait a little to allow page to solve Turnstile
        await page.waitForTimeout(4000);

// dismiss cookie banner if it exists
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button, div')].find(el =>
                el.textContent?.trim().match(/accept|got it|okay|close/i)
            );
            if (btn) btn.click();
        });

// try to pick and navigate to a result
        // Step: Auto-dismiss cookie banners
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button, div')].find(el =>
                el.textContent?.trim().match(/accept|got it|okay|close/i)
            );
            if (btn) btn.click();
        });

// Step: Try locating the rid= link and navigating directly
        const ridUrl = await page.evaluate(() => {
            try {
                const link = document.querySelector('a[href*="rid="]');
                if (link && link.href) {
                    return new URL(link.getAttribute('href'), location.href).toString();
                }
            } catch (e) {
            }
            return null;
        });

        if (!ridUrl) {
            console.warn('❌ Could not find RID result link — saving screenshot');
            const shot = path.join(LOG_DIR, `no-rid-link-${Date.now()}.png`);
            await page.screenshot({path: shot, fullPage: true}).catch(() => {
            });
        } else {
            console.log('📍 Navigating directly to RID URL:', ridUrl);
            await page.evaluate((u) => {
                window.location.href = u;
            }, ridUrl);
            await page.waitForTimeout(5000); // let navigation finish

            const scraped = await scrapeBasicResult(page).catch((e) => {
                console.warn('scrape Basic view results page failed:', e?.message || e);
                return {phone: null, email: null, physical_address: null};
            });

            console.log('Scraped detail:', scraped);

            const finalShot = path.join(LOG_DIR, `final-scrape-${Date.now()}.png`);
            await page.screenshot({path: finalShot, fullPage: true}).catch(() => {
            });
            const finalState = path.join(LOG_DIR, `final-state-${Date.now()}.json`);
            await context.storageState({path: finalState}).catch(() => {
            });
            console.log('Saved final artifacts:', finalShot, finalState);
        }


        // wait and capture
        // wait a little to allow navigation to clear CAPTCHA
        await page.waitForTimeout(4000);
        // auto-dismiss cookie banners or overlays
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button, div')].find(el =>
                el.textContent?.trim().match(/accept|got it|okay|close/i)
            );
            if (btn) btn.click();
        });


        try {
            // wait briefly to ensure results are visible
            await page.waitForTimeout(1200);

            // define possible containers and link selectors
            const resultsSelectors = [
                'table tbody tr',
                '.search-results .result',
                '.results .result',
                'ul.results > li',
                '.people-results li',
                '.content .result',
            ];
            const viewLinkSelectors = [
                'a:has-text("View Details")',
                'a:has-text("View")',
                'a:has-text("Details")',
                'a:has-text("Profile")',
                'a[href*="/record/"]',
                'a[href*="detail"]',
                'a[href*="profile"]'
            ];

            let targetUrl = null;

            // try finding a detail link from the first result row
            for (const resSel of resultsSelectors) {
                const row = page.locator(resSel).first();
                if (await row.count()) {
                    for (const linkSel of viewLinkSelectors) {
                        const link = row.locator(linkSel).first();
                        if (await link.count()) {
                            const href = await link.getAttribute('href').catch(() => null);
                            if (href) {
                                targetUrl = new URL(href, await page.evaluate(() => location.href)).toString();
                                break;
                            }
                        }
                    }
                }
                if (targetUrl) break;
            }

            if (!targetUrl) {
                console.warn('❌ Could not resolve View Details link — saving screenshot');
                const shot = path.join(LOG_DIR, `no-details-link-${Date.now()}.png`);
                await page.screenshot({path: shot, fullPage: true}).catch(() => {
                });
            } else {
                console.log('🌐 Navigating via location.href to:', targetUrl);
                await page.evaluate((u) => {
                    window.location.href = u;
                }, targetUrl);
                await page.waitForTimeout(5000); // wait for navigation to complete

                try {
                    // prevent link auto-click chaos before scraping
                    await page.evaluate(() => {
                        document.querySelectorAll('a[href*="phoneno="]').forEach(a => {
                            a.addEventListener('click', e => e.preventDefault());
                        });
                    });

                    console.log('🔍 Extracting all phone data (wireless + landline)...');
                    const scraped = await scrapeWirelessDetail(page).catch((e) => {
                        console.warn('scrapeWirelessDetail failed:', e?.message || e);
                        return { mobile_phones: [], phones: [] };
                    });

                    console.log('📞 Scraped phone data:', scraped);

                    // Save screenshots and browser state for debugging
                    const finalShot = path.join(LOG_DIR, `final-scrape-${Date.now()}.png`);
                    await page.screenshot({ path: finalShot, fullPage: true }).catch(() => {});
                    const finalState = path.join(LOG_DIR, `final-state-${Date.now()}.json`);
                    await context.storageState({ path: finalState }).catch(() => {});
                    console.log('💾 Saved final artifacts:', finalShot, finalState);

                    // Return structured data (no external post)
                    return {
                        success: true,
                        screenshot: finalShot,
                        state: finalState,
                        phones: scraped.phones,
                        mobile_phones: scraped.mobile_phones,
                    };
                } catch (err) {
                    console.error('Error in view-details + scrape phase:', err?.message || err);
                    return { success: false, reason: 'scrape_error', error: err?.message };
                } finally {
                    if (!KEEP_OPEN) {
                       try {
  await page?.close();
  await context?.close();
} catch (e) {
  console.warn('⚠️ Close skipped (undefined page/context):', e.message);
}

                        await browser.close().catch(() => {});
                    } else {
                        console.log('KEEP_OPEN enabled - leaving browser open for inspection.');
                    }
                }


                return {success: true, screenshot: s4, state: statePath4, resultPresent};
            } // closes if (!targetUrl)


// outer try/catch below remains untouched
        } catch (err) {
            console.error('Attempt error:', err && err.message ? err.message : err);
            try {
                if (page) {
                    const errShot = path.join(LOG_DIR, `screenshot-error-${Date.now()}.png`);
                    await page.screenshot({path: errShot}).catch(() => {
                    });
                }
            } catch (e) {
            }
            try {
                if (context) await context.close();
            } catch (e) {
            }
            try {
                if (browser) await browser.close();
            } catch (e) {
            }
            return { success: false, reason: 'exception', error: err && err.message };
            // closes outer catch
        } }
    catch (err) {
        console.error('Attempt error:', err && err.message ? err.message : err);
        try {
            if (page) {
                const errShot = path.join(LOG_DIR, `screenshot-error-${Date.now()}.png`);
                await page.screenshot({ path: errShot }).catch(() => {});
            }
        } catch (e) {}
        try {
            if (context) await context.close();
        } catch (e) {}
        try {
            if (browser) await browser.close();
        } catch (e) {}

        return { success: false, reason: 'exception', error: err && err.message };
    } // closes outer catch
}



// Async runner (IIFE)
; // ============================================================
// 🧩 Exportable Runner
// ============================================================

async function runFamilyTreeStealth({ first = 'Lauren', last = 'Stevens', city = 'Plano' } = {}) {
    await ensureLogDir();
    const lines = await loadProxyLines();
    if (!lines.length && !RAW_PROXY) {
        console.warn('No proxies found in PROXY_FILE and no PROXY_LINE provided. Exiting.');
        return { ok: false, reason: 'no_proxies' };
    }

    const pool = lines.length ? lines : [RAW_PROXY];
    const target = `https://www.familytreenow.com/search/genealogy/results?first=${encodeURIComponent(first)}&last=${encodeURIComponent(last)}&citystatezip=${encodeURIComponent(city)},+TX`;
    process.env.TARGET_URL = target;

    console.log(`🎯 Target URL: ${target}`);

    for (let i = 0, tries = 0; tries < MAX_TRIES && i < pool.length; i = (i + 1) % pool.length, tries++) {
        const raw = pool[i];
        console.log(`\n== Try ${tries + 1} of up to ${MAX_TRIES} using proxy index ${i} ==`);
        const res = await attemptWithProxy(raw, tries + 1);
        if (res.success) {
            console.log('✅ Success!', res);

            // normalize structure for FTN static test integration
            const inner = res.data || {};
            const data = {
                mobile_phones: inner.mobile_phones || [],
                phones: inner.phones || [],
                address: inner.address || null,
                provider: inner.mobile_phones?.[0]?.carrier || null,
                screenshot: res.screenshot,
                state: res.state,
            };


            // ✅ match test script expectation
            return {
                success: true,
                reason: 'scraped_ok',
                proxyUsed: res.proxyUsed || null,
                data,
            };
        }
        else {
            console.warn('Proxy attempt failed:', res.reason || res.error || 'unknown', res);
        }
    }

    console.error('All attempts exhausted or max tries reached. Check logs under', LOG_DIR);
    return { ok: false, reason: 'exhausted' };
}

// ------------------------------------------------------------
// 🧱 Dual-mode export / CLI
// ------------------------------------------------------------
if (require.main === module) {
    // CLI mode (stand-alone)
    const first = process.argv[2] || 'Lauren';
    const last = process.argv[3] || 'Stevens';
    const city = process.argv[4] || 'Plano';

    runFamilyTreeStealth({ first, last, city })
        .then(r => {
            console.log('Final result:', r);
            process.exit(r.ok ? 0 : 1);
        })
        .catch(err => {
            console.error('Fatal error:', err);
            process.exit(1);
        });
} else {
    // Exported function mode
    module.exports = { runFamilyTreeStealth };
}


