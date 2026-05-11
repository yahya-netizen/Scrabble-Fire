const fs = require('fs');
const pool = require('./db');

async function migrate() {
    try {
        console.log('Starting migration...');

        // 1. Migrate Users
        const usersFile = 'data/users.json';
        if (fs.existsSync(usersFile)) {
            const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
            for (const user of users) {
                await pool.execute(
                    'INSERT IGNORE INTO users (username, password) VALUES (?, ?)',
                    [user.username, user.password]
                );
            }
            console.log(`Migrated ${users.length} users.`);
        }

        // 2. Migrate Soal (Categories and Questions)
        const soalFile = 'soal.json';
        if (fs.existsSync(soalFile)) {
            const data = JSON.parse(fs.readFileSync(soalFile, 'utf8'));
            const categories = data.categories || [];

            for (const cat of categories) {
                await pool.execute(
                    'INSERT IGNORE INTO categories (id, name, description) VALUES (?, ?, ?)',
                    [cat.id, cat.name, cat.description]
                );

                for (const q of cat.questions) {
                    await pool.execute(
                        'INSERT IGNORE INTO questions (id, category_id, number, answer, row_pos, col_pos, direction, clue) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        [q.id, cat.id, q.number, q.answer, q.row, q.col, q.direction, q.clue]
                    );
                }
            }
            console.log(`Migrated ${categories.length} categories.`);
        }

        console.log('Migration completed successfully.');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

migrate();
