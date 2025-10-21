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
                                                      pollIntervalMs = 2500,
                                                      pollTimeoutMs = 90000,
                                                      fromCandidates = ['nextdoor', 'no-reply@nextdoor.com', 'hello@nextdoor.com'],
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
            tlsOptions: { rejectUnauthorized: false }, // 👈 fix self-signed cert
            authTimeout: 30000,
        },
    });


    // Try Inbox → Spam → Junk (cross-provider compatible)
    const boxesToTry = ['INBOX', '[Gmail]/Spam', 'SPAM', 'Junk'];
    let boxOpened = false;

    for (const box of boxesToTry) {
        try {
            await connection.openBox(box);
            console.log(`📬 Opened mailbox: ${box}`);
            boxOpened = true;
            break;
        } catch {
            console.log(`⚠️ Mailbox not found: ${box}`);
        }
    }

    if (!boxOpened) {
        throw new Error('Unable to open any mailbox (INBOX/SPAM/Junk).');
    }

    const start = Date.now();
    try {
        while (Date.now() - start < pollTimeoutMs) {
            const results = await connection.search(
                ['UNSEEN', ['SINCE', new Date(Date.now() - 1000 * 60 * 60)]],
                { bodies: [''], markSeen: true }
            );

            for (let i = results.length - 1; i >= 0; i--) {
                const raw = results[i].parts?.[0]?.body;
                if (!raw) continue;

                const mail = await simpleParser(raw);
                const from = (mail.from?.value?.[0]?.address || '').toLowerCase();
                const subject = (mail.subject || '').toLowerCase();
                const text = (mail.text || '') + ' ' + (mail.html ? mail.html.replace(/<[^>]+>/g, '') : '');
                const isNextdoor =
                    fromCandidates.some((c) => from.includes(c)) || /nextdoor/.test(subject + text);

                if (!isNextdoor) continue;

                const m = text.match(/\b(\d{6})\b/);
                if (m) {
                    console.log(`✅ Found code ${m[1]} in email from ${from}`);
                    await connection.end();
                    return m[1];
                }
            }

            await new Promise((r) => setTimeout(r, pollIntervalMs));
        }

        await connection.end();
        throw new Error('Timed out waiting for verification email.');
    } catch (err) {
        if (connection && connection.state !== 'disconnected') {
            try {
                await connection.end();
            } catch {}
        }
        throw err;
    }
}

module.exports = { getLatestVerificationCodeFromEmail };
