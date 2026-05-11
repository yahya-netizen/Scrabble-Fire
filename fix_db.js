const pool = require('./db');

async function fix() {
    try {
        console.log('Checking users table columns...');
        
        const [columns] = await pool.execute('SHOW COLUMNS FROM users');
        const columnNames = columns.map(c => c.Field);

        if (!columnNames.includes('google_id')) {
            console.log('Adding google_id column...');
            await pool.execute('ALTER TABLE users ADD COLUMN google_id VARCHAR(255) UNIQUE AFTER password');
            console.log('Column google_id added.');
        } else {
            console.log('Column google_id already exists.');
        }

        console.log('Ensuring password column is nullable...');
        await pool.execute('ALTER TABLE users MODIFY COLUMN password VARCHAR(255) NULL');

        console.log('Database schema updated successfully.');
        process.exit(0);
    } catch (error) {
        console.error('Update failed:', error);
        process.exit(1);
    }
}

fix();
