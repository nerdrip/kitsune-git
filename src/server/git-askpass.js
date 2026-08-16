#!/usr/bin/env node
const prompt = process.argv.slice(2).join(' ').toLowerCase();
if (prompt.includes('username')) process.stdout.write(process.env.KITSUNE_IMPORT_USERNAME || 'oauth2');
else process.stdout.write(process.env.KITSUNE_IMPORT_TOKEN || '');
