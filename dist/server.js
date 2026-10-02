import { app } from './app.js';
import { env } from './config.js';
import { pool } from './db.js';
async function startServer() {
    try {
        await pool.query('SELECT 1');
        console.log('PostgreSQL database connected.');
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown database connection error';
        console.error(`PostgreSQL database connection failed: ${message}`);
        await pool.end();
        process.exitCode = 1;
        return;
    }
    app.listen(env.PORT, () => {
        console.log(`LemonTrip API listening on http://localhost:${env.PORT}`);
    });
}
void startServer();
