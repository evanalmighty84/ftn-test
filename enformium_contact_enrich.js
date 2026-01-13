require('dotenv').config();
const axios = require('axios');
const { randomUUID } = require('crypto');
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Enformion credentials and headers
const URL = 'https://devapi.enformion.com/Contact/Enrich';
const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'galaxy-ap-name': (process.env.ENFORMION_AP_NAME || '').trim(),
    'galaxy-ap-password': (process.env.ENFORMION_AP_PASSWORD || '').trim(),
    'galaxy-search-type': 'DevAPIContactEnrich',
    'galaxy-client-type': 'JavaScript',
    'galaxy-client-session-id': randomUUID(),
};
async function inferZipFromNeighborhood(neighborhood, city) {
    const prompt = `Using Zillow data, what is the ZIP code for the "${neighborhood}" neighborhood in ${city}, Texas? Return only the 5-digit ZIP code.`;
    const { choices } = await openai.chat.completions.create({
        model: 'gpt-5o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2
    });
    const zip = choices[0].message.content.trim();
    return /^\d{5}$/.test(zip) ? zip : null;
}
// ✅ Base enrichment call
async function enrichWithEnformion({
                                       name,
                                       phone = '',
                                       lead_type,
                                       city,
                                       physical_address = '',
                                       description = '',
                                       location = '',
                                       message_sent_at = null
                                   }) {
    const splitName = (full = '') => {
        const parts = full.trim().split(/\s+/);
        if (parts.length === 1) return { FirstName: parts[0], MiddleName: '', LastName: '' };
        if (parts.length === 2) return { FirstName: parts[0], MiddleName: '', LastName: parts[1] };
        return { FirstName: parts[0], MiddleName: parts.slice(1, -1).join(' '), LastName: parts.at(-1) };
    };

    const { FirstName, MiddleName, LastName } = splitName(name);
    const body = {
        FirstName,
        MiddleName,
        LastName,
        Dob: '',
        Age: '',
        Address: {
            addressLine1: physical_address || '',
            addressLine2: `${city}, TX`
        },
        Phone: phone,
        Email: ''
    };

    try {
        const { data } = await axios.post(URL, body, { headers, timeout: 30000 });
        const person = data?.person || {};
        const phones = Array.isArray(person.phones) ? person.phones : [];
        const mobiles = phones
            .filter(p => String(p.type).toLowerCase() === 'mobile')
            .sort((a, b) =>
                (Date.parse(b.lastReportedDate || 0) || 0) - (Date.parse(a.lastReportedDate || 0) || 0)
            );

        const addresses = Array.isArray(person.addresses) ? person.addresses : [];
        const cityMatches = addresses.filter(
            a => String(a.city || '').toLowerCase() === String(city || '').toLowerCase()
        );
        const closestAddress = cityMatches.length
            ? [cityMatches[0].street, cityMatches[0].city, cityMatches[0].state, cityMatches[0].zip]
                .filter(Boolean)
                .join(' ')
            : null;

        return {
            ok: true,
            bestMobile: mobiles[0]?.number || null,
            suggestedMobile: mobiles[1]?.number || null,
            allMobiles: mobiles.map(m => m.number),
            closestAddress,
            match: {
                identityScore: data?.identityScore ?? null,
                name: person?.name ?? null
            },
            raw: data
        };
    } catch (err) {
        return {
            ok: false,
            error: err?.response?.data || err.message
        };
    }
}

// ✅ Helper: Get how common a name is (1–100)
async function getNameCommonnessScore(name) {
    const prompt = `On a scale from 1 to 100, how common is the name "${name}" in the United States? Respond with just a number.`;
    const { choices } = await openai.chat.completions.create({
        model: 'gpt-5o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2
    });
    return parseInt(choices[0].message.content.trim(), 10);
}

// ✅ Helper: Get 7 closest cities to ZIP
async function get7ClosestCities(zip, city) {
    const prompt = `Give me the 7 cities geographically closest to ZIP code ${zip} in Texas (including ${city} itself). Return only a JSON array of city names.`;
    const { choices } = await openai.chat.completions.create({
        model: 'gpt-5o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2
    });

    try {
        const arr = JSON.parse(choices[0].message.content.trim());
        if (Array.isArray(arr)) return arr;
    } catch (err) {
        console.warn('⚠️ Failed to parse OpenAI closest cities JSON:', err.message);
    }

    return [city]; // fallback
}




// ✅ Main: Smart Enformion wrapper
async function enrichSmartlyWithOpenAI({
                                           name,
                                           phone = '',
                                           lead_type,
                                           city,
                                           zip = '',
                                           physical_address = '',
                                           description = '',
                                           location = '',
                                           message_sent_at = null
                                       }) {
    const nameScore = await getNameCommonnessScore(name);
    console.log(`📊 Name score for "${name}":`, nameScore);

    // 🔍 ZIP fallback using location (neighborhood)
    if (!zip && location) {
        zip = await inferZipFromNeighborhood(location, city);
        if (!zip) {
            console.warn(`⚠️ Could not infer ZIP from neighborhood "${location}" in ${city}`);
            return { ok: false, error: 'Could not determine ZIP from location' };
        }
        console.log(`📬 Inferred ZIP for ${location}, ${city}: ${zip}`);
    }

    const cityList = await get7ClosestCities(zip, city);
    console.log('📍 Closest cities to search:', cityList);

    const useAddress = nameScore < 70;
    let tries = 0; // ✅ Track how many API calls were made

    for (const candidateCity of cityList) {
        tries += 1;

        const enrich = await enrichWithEnformion({
            name,
            phone,
            lead_type,
            city: candidateCity,
            physical_address: useAddress ? physical_address : '',
            description,
            location,
            message_sent_at
        });

        if (enrich?.ok && enrich.closestAddress) {
            const matchCity = extractCityFromAddress(enrich.closestAddress);
            const validCities = cityList.map(c => c.toLowerCase());

            if (validCities.includes(matchCity.toLowerCase())) {
                console.log(`✅ Match found in ${candidateCity} after ${tries} Enformion request(s)`);
                return enrich;
            } else {
                console.log(`⚠️ Address "${enrich.closestAddress}" not in allowed cities`);
            }
        }
    }

    console.log(`❌ No match found after ${tries} Enformion request(s)`);
    return { ok: false, error: 'No match from closest cities' };
}

// ✅ Optional CLI
// ✅ Optional CLI (for dev use only — doesn’t interfere with app)
if (require.main === module) {
    const getArg = (flag, def = '') => {
        const i = process.argv.indexOf(flag);
        return i > -1 ? (process.argv[i + 1] || def) : def;
    };

    const name = getArg('--name');
    const location = getArg('--location');
    const city = getArg('--city');
    const zip = getArg('--zip', '');
    const physical_address = getArg('--address', '');

    if (!name || !city || !location) {
        console.error('Usage: node enformium_contact_enrich.js --name "Full Name" --location "Neighborhood" --city "City" [--zip "75034"] [--address "123 Main St"]');
        process.exit(1);
    }

    enrichSmartlyWithOpenAI({
        name,
        phone: '',
        city,
        zip,
        location,
        physical_address,
        lead_type: 'manual-test'
    }).then(result => {
        console.log('🧪 CLI Result:', JSON.stringify(result, null, 2));
    });
}


// ✅ Exports
module.exports = {
    enrichWithEnformion,
    enrichSmartlyWithOpenAI,
    inferZipFromNeighborhood
};
