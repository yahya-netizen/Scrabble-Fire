const fs = require('fs');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function setup() {
    const config = {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || ''
    };

    try {
        const connection = await mysql.createConnection(config);
        console.log('Connected to MySQL.');

        const sql = fs.readFileSync('database.sql', 'utf8');
        const queries = sql.split(';').filter(q => q.trim() !== '');

        for (let query of queries) {
            await connection.query(query);
        }

        console.log('Database and tables created successfully.');
        await connection.end();
        process.exit(0);
    } catch (error) {
        console.error('Setup failed:', error);
        process.exit(1);
    }
}

setup();
