// ftn_static_test.js
require('dotenv').config();
const { runFamilyTreeStealth } = require('./runFamilyTreeStealth');
const { personSearchAndScrape } = require('./melissaLookup');
const { postLeadAlert } = require('./leadAlertClient');
const pool = require('./db/db');

(async () => {
    // 🧩 Static test parameters
    const first = process.argv[2] || 'Michael';
    const last = process.argv[3] || 'Dressel';
    const city = process.argv[4] || 'Plano';

    console.log(`🕵️ Running FamilyTreeNow static test for ${first} ${last} (${city})`);

    let phone = null, email = null, physical_address = null;
    const descParts = [];

    try {
        // ===================== FTN LOOKUP =====================
        const ftn = await runFamilyTreeStealth({ first, last, city });

        if (ftn?.success && ftn.data) {
            console.log('✅ FTN lookup succeeded.');

            const data = ftn.data;
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

        } else {
            // ===================== MELISSA FALLBACK =====================
            console.log('⚠️ FTN returned no data, trying Melissa...');
            const mel = await personSearchAndScrape(null, {
                name: `${first} ${last}`,
                state: 'TX',
                city: 'Plano'
            });

            if (mel?.phone) phone = mel.phone;
            if (mel?.email) email = mel.email;
            if (mel?.physical_address) physical_address = mel.physical_address;

            descParts.push(`Melissa: ${phone || 'none'}`);
        }

        // Always hardcode Plano for now
        const matchCity = 'Plano';

        console.log(`📍 Final City: ${matchCity}`);
        console.log(`📞 Final Phone: ${phone}`);
        console.log(`🏠 Address: ${physical_address}`);

        // ===================== SAVE TO DB =====================
        await pool.query(
            `INSERT INTO nextdoor_messages (post_url, author, location, city, lead_type, phone, email, description, physical_address)
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

        // ===================== ALERT POST =====================
// ===================== ALERT POST =====================
        if (phone) {
            console.log('📡 Sending lead alert with payload:');
            console.log({
                name: `${first} ${last}`,
                phone,
                lead_type: 'pool',
                city: matchCity,
                description: descParts.join(' | '),
                location: 'Static Test',
                physical_address
            });

            const resp = await postLeadAlert({
                name: `${first} ${last}`,
                phone,
                lead_type: 'pool',
                city: matchCity,
                description: descParts.join(' | '),
                location: 'Static Test',
                physical_address
            });

            console.log('📬 Lead alert response:', resp);

            if (resp.ok) {
                console.log('📣 Lead alert sent successfully:', resp.data);
            } else {
                console.warn('⚠️ Lead alert failed:', resp.error || resp);
            }
        } else {
            console.log('ℹ️ No phone found — skipping alert.');
        }


    } catch (err) {
        console.error('❌ Static FTN test failed:', err);
    } finally {
        await pool.end();
        console.log('✅ Done.');
    }

})();
