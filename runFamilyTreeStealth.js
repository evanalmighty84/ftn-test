// ftn_static_test.js
require('dotenv').config();
const { chromium } = require('playwright');
const { personSearchAndScrape } = require('./melissaLookup');
const { postLeadAlert } = require('./leadAlertClient');
const pool = require('./db/db');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const LOG_DIR = path.resolve(process.cwd(), 'ftn_debug');
async function ensureLogDir() { try { await fsp.mkdir(LOG_DIR, { recursive: true }); } catch {} }

// === helpers ===
function normalizeProxy(raw) {
    if (!raw) return null;
    raw = raw.trim();
    const m = raw.match(/^(https?|socks5):\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (m) return { proto: m[1], username: m[2], password: m[3], host: m[4], port: m[5] };
    throw new Error('Unrecognized proxy format: ' + raw);
}
async function loadProxyList() {
    const env = process.env.PROXY_LIST || '';
    return env.split(/[|,\n]+/).map(s => s.trim()).filter(Boolean);
}

// === improved stealth FTN lookup ===
async function runFamilyTreeStealth({ first, last, city }) {
    await ensureLogDir();
    const proxies = await loadProxyList();
    if (!proxies.length) throw new Error('No proxies provided via PROXY_LIST');

    const target = `https://www.familytreenow.com/search/genealogy/results?first=${encodeURIComponent(first)}&last=${encodeURIComponent(last)}&citystatezip=${encodeURIComponent(city)},+TX`;
    console.log(`🎯 Target URL: ${target}`);

    const stealthInit = `
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
  `;
    const turnstileHook = `
    (()=>{const i=setInterval(()=>{try{if(window.turnstile&&typeof window.turnstile.render==='function'){clearInterval(i);const o=window.turnstile.render.bind(window.turnstile);window.turnstile.render=(a,b)=>{try{window.__tsPayload=b;return o(a,b)}catch(e){return'err'}}}}catch(e){}},20)})();
  `;

    for (let i = 0; i < proxies.length; i++) {
        const raw = proxies[i];
        const p = normalizeProxy(raw);
        console.log(`--- Proxy ${i+1}/${proxies.length}: ${p.host}:${p.port} ---`);

        const headless = process.env.HEADLESS === '1' ? true : false;
        const opts = {
            headless,
            viewport: { width: 1366, height: 768 },
            args: [
                '--no-sandbox', '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1366,768',
            ],
            proxy: {
                server: `${p.proto}://${p.host}:${p.port}`,
                username: p.username,
                password: p.password
            }
        };

        const userDataDir = path.resolve(`./ftn-profile-${Date.now()}-${Math.floor(Math.random()*10000)}`);
        await fsp.mkdir(userDataDir, { recursive: true });

        let context, page;
        try {
            context = await chromium.launchPersistentContext(userDataDir, opts);
            await context.addInitScript(stealthInit);
            await context.addInitScript(turnstileHook);

            page = await context.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Upgrade-Insecure-Requests': '1'
            });

            console.log('Navigating...');
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // quick detection
            const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
            if (/Verify you are human/i.test(bodyText)) {
                console.warn('⚠️ Hit Turnstile challenge. rotating proxy...');
                await context.close(); continue;
            }

            // Find detail link and scrape
            const link = await page.evaluate(() => {
                const a = document.querySelector('a[href*="/search/people/results?rid="]');
                return a ? a.href : null;
            });
            if (!link) throw new Error('No RID link found');

            await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
            const phones = await page.$$eval('.panel-body .col-xs-12.col-md-6', els =>
                els.map(e => e.innerText).filter(Boolean)
            );
            const addr = await page.$eval('.panel.panel-primary a.linked-record', el => el.innerText).catch(()=>null);

            const parsed = {
                mobile_phones: phones.filter(t=>/Wireless/i.test(t)).map(t=>({ number: (t.match(/\\(\\d{3}\\).*\\d{4}/)||[])[0] })),
                phones: phones.filter(t=>!/Wireless/i.test(t)).map(t=>({ number: (t.match(/\\(\\d{3}\\).*\\d{4}/)||[])[0] })),
                address: addr
            };

            console.log('✅ Scraped:', parsed);
            await context.close();
            return { success: true, data: parsed };

        } catch (e) {
            console.warn('Proxy failed:', e.message);
            try { await context?.close(); } catch {}
        }
    }
    return { success: false };
}

// === nextdoor integrated runner ===
(async () => {
    const first = process.argv[2] || 'Michael';
    const last = process.argv[3] || 'Dressel';
    const city = process.argv[4] || 'Plano';
    console.log(`🕵️ Running FamilyTreeNow Stealth for ${first} ${last} (${city})...`);

    let phone=null,email=null,physical_address=null;
    const descParts=[];

    try {
        const ftn = await runFamilyTreeStealth({ first,last,city });
        if (ftn?.success && ftn.data) {
            console.log('✅ FTN lookup succeeded.');
            const data=ftn.data;
            const wireless=(data.mobile_phones||[]).map(p=>p.number);
            const landlines=(data.phones||[]).map(p=>p.number);
            const unique=[...new Set([...wireless,...landlines].filter(Boolean))];
            if(unique.length){phone=unique[0];descParts.push(`FTN Phones: ${unique.join(', ')}`);}
            if(data.address){physical_address=data.address;descParts.push(`FTN Address: ${data.address}`);}
        } else {
            console.log('⚠️ FTN returned no data, trying Melissa...');
            const mel=await personSearchAndScrape(null,{name:`${first} ${last}`,state:'TX',city});
            if(mel?.phone) phone=mel.phone;
            if(mel?.email) email=mel.email;
            if(mel?.physical_address) physical_address=mel.physical_address;
            descParts.push(`Melissa: ${phone||'none'}`);
        }

        const matchCity='Plano';
        console.log(`📍 Final City: ${matchCity}`);
        console.log(`📞 Final Phone: ${phone}`);
        console.log(`🏠 Address: ${physical_address}`);

        await pool.query(
            `INSERT INTO nextdoor_messages (post_url,author,location,city,lead_type,phone,email,description,physical_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (post_url) DO NOTHING`,
            [
                `ftn-test-${Date.now()}`,
                `${first} ${last}`,
                'Static Test',
                matchCity,
                'pool',
                phone,
                email,
                descParts.join(' | '),
                physical_address
            ]
        );
        console.log('💾 Saved test result to nextdoor_messages.');

        if(phone){
            const payload={name:`${first} ${last}`,phone,lead_type:'pool',city:matchCity,
                description:descParts.join(' | '),location:'Static Test',physical_address};
            console.log('📡 Sending lead alert:',payload);
            const resp=await postLeadAlert(payload);
            console.log('📬 Lead alert response:',resp);
        } else {
            console.log('ℹ️ No phone found — skipping alert.');
        }
    } catch(err){ console.error('❌ Static FTN test failed:',err); }
    finally{ await pool.end(); console.log('✅ Done.'); }
})();
