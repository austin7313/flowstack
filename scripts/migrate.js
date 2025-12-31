#!/usr/bin/env node

/**
 * Database Migration Runner
 * Executes migration files sequentially
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function runMigrations() {
  const client = await pool.connect();

  try {
    console.log('🔄 Running database migrations...\n');

    // Get all migration files
    const migrationsDir = path.join(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('ℹ️  No migration files found');
      return;
    }

    // Execute each migration
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      console.log(`⏳ Running ${file}...`);

      try {
        await client.query(sql);
        console.log(`✅ ${file} completed\n`);
      } catch (error) {
        console.error(`❌ ${file} failed:`, error.message);
        throw error;
      }
    }

    console.log('✅ All migrations completed successfully!');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);

  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
