#!/usr/bin/env node
const prompt = process.argv.slice(2).join(' ').toLowerCase();
if (prompt.includes('username')) process.stdout.write('git');
else process.stdout.write(process.env.KITSUNE_ASKPASS_TOKEN || '');
