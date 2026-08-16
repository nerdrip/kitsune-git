#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { SqliteStore } = require('./sqlite-store');

const [action] = process.argv.slice(2);
if (action !== 'migrate-to-sqlite') { console.error('Usage: metadata-cli.js migrate-to-sqlite'); process.exit(2); }
const dataPath = path.resolve(process.env.KITSUNE_DATA_PATH || path.join(process.cwd(), '.kitsune-web'));
const source = path.join(dataPath, 'database.json'); const destination = path.join(dataPath, 'database.sqlite');
if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error('JSON metadata database was not found');
if (fs.existsSync(destination)) throw new Error('SQLite destination already exists');
const state = JSON.parse(fs.readFileSync(source, 'utf8'));
const store = new SqliteStore(destination);
try { store.update(draft => { for (const key of Object.keys(draft)) delete draft[key]; Object.assign(draft, state); return null; }); }
catch (error) { store.close(); fs.rmSync(destination, { force: true }); throw error; }
store.close();
console.log(destination);
