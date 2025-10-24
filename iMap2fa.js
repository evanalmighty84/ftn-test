const Imap = require('imap-simple');
const { simpleParser } = require('mailparser');

const configDefaults = {
    host: process.env.NEXTDOOR_MAIL_HOST || 'imap.gmail.com',
    port: parseInt(process.env.NEXTDOOR_MAIL_PORT || '993', 10),
    tls: (process.env.NEXTDOOR_MAIL_TLS || 'true') === 'true',
    user: process.env.NEXTDOOR_MAIL_USER,
    password: process.env.NEXTDOOR_MAIL_PASS,
};

async function getLatestVerificationCodeFromEmail({
                                                      pollIntervalMs = 4000,      // check every 4s
                                                      pollTimeoutMs = 180000,     // 3 minute total wait
                                                      debugMode = false
                                                  } = {}) {
    if (!configDefaults.user || !configDefaults.password) {
        throw new Error('Mail creds missing in env (NEXTDOOR_MAIL_USER / NEXTDOOR_MAIL_PASS).');
    }

    const connection = await Imap.connect({
        imap: {
            user: configDefaults.user,
            password: configDefaults.password,
            host: configDefaults.host,
            port: configDefaults.port,
            tls: configDefaults.tls,
            tlsOptions: { rejectUnauthorized: false },
            authTimeout: 30000,
        },
    });

    // Try multiple folders (for Gmail + Zoho)
    const boxesToTry = ['INBOX', '[Gmail]/All Mail', '[Gmail]/Spam', 'Spam', 'SPAM', 'Junk'];
    let boxOpened = false;

    for (const box of boxesToTry) {
        try {
            await connection.openBox(box);
            console.log(`📬 Opened mailbox: ${box}`);
            boxOpened = true;
            break;
        } catch {
            console.log(`⚠️ Mailbox not found or inaccessible: ${box}`);
        }
    }

    if (!boxOpened) throw new Error('Unable to open any mailbox (INBOX/All Mail/Spam/Junk).');

    // Allow mailbox sync lag
    await new Promise(r => setTimeout(r, 5000));

    const start = Date.now();
    try {
        while (Date.now() - start < pollTimeoutMs) {
            const results = await connection.search(
                [['SINCE', new Date(Date.now() - 1000 * 60 * 60 * 3)]], // last 3 hours
                { bodies: ['HEADER', 'TEXT'], markSeen: false }
            );

            if (debugMode) console.log(`📨 Found ${results.length} recent emails`);

            for (let i = results.length - 1; i >= 0; i--) {
                const raw = results[i].parts?.[0]?.body;
                if (!raw) continue;

                const mail = await simpleParser(raw);
                const from = (mail.from?.value?.[0]?.address || '').toLowerCase();
                const subject = (mail.subject || '').toLowerCase();
                const text = (mail.text || '') + ' ' + (mail.html ? mail.html.replace(/<[^>]+>/g, '') : '');

                if (debugMode) console.log(`✉️ ${from} | ${subject}`);

                // ✅ match any Nextdoor mail domain variant
                const isNextdoor = /nextdoor\.com/.test(from) || /nextdoor/i.test(subject + text);

                if (!isNextdoor) continue;

                // Extract 6-digit code
                const match = text.match(/\b(\d{6})\b/);
                if (match) {
                    const code = match[1];
                    console.log(`✅ Found Nextdoor login code: ${code} (from ${from})`);
                    await connection.end();
                    return code;
                }
            }

            await new Promise(r => setTimeout(r, pollIntervalMs));
        }

        await connection.end();
        throw new Error('Timed out waiting for verification email.');
    } catch (err) {
        console.error('❌ Email polling error:', err.message);
        if (connection && connection.state !== 'disconnected') {
            try {
                await connection.end();
            } catch {}
        }
        throw err;
    }
}

module.exports = { getLatestVerificationCodeFromEmail };
