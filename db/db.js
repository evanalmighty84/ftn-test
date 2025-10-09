const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER || 'u33njb102j0u34',
    host: process.env.DB_HOST || 'cd27da2sn4hj7h.cluster-czrs8kj4isg7.us-east-1.rds.amazonaws.com',
    database: process.env.DB_NAME || 'd65u30168cmrfd',
    password: process.env.DB_PASSWORD || 'p5b557ec255a19888a4da1ae53d1408d0167f02c01e289c9f74f54af2515419e8',
    port: process.env.DB_PORT || 5432,
    ssl: { rejectUnauthorized: false },
    max: 50, // Allow 50 concurrent connections
    idleTimeoutMillis: 30000, // Keep connections open for 30 seconds
    connectionTimeoutMillis: 30000, // Prevent early termination
});



pool.connect((err, client, release) => {
    if (err) {
        console.error('Error acquiring client', err.stack);
    } else {
        console.log('Successfully connected to Heroku PostgreSQL database');
    }
    release();
});

module.exports = pool;
