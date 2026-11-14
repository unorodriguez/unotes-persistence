import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(pkg.private, true, 'npm publishing must remain disabled.');
assert.equal(pkg.license, 'MIT', 'The approved standalone license must be retained.');
const license = fs.readFileSync('LICENSE', 'utf8');
assert.ok(license.startsWith('MIT License\n\nCopyright (c) 2026 unorodriguez\n'));
assert.ok(license.includes('Permission is hereby granted, free of charge'));
assert.ok(license.includes('THE SOFTWARE IS PROVIDED \"AS IS\"'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
assert.equal(lock.packages[''].license, 'MIT');
assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
assert.deepEqual(Object.keys(pkg.exports), ['.']);
for (const file of ['dist/index.js', 'dist/index.d.ts']) assert.ok(fs.existsSync(file));
const api = await import('../dist/index.js');
assert.equal(typeof api.createNotebookStore, 'function');
// Node import must have no Window dependency or automatic storage/network effects.
assert.throws(() => api.createNotebookStore({ namespace: 'node-probe' }), /browser Window/);
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
// npm 9 returns an array; npm 12 returns an object keyed by package name.
const pack = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
assert.ok(pack.files.length > 0);
assert.ok(pack.files.some(file => file.path === 'LICENSE'), 'Consumer package must include its license.');
for (const { path } of pack.files) {
    assert.ok(path === 'LICENSE' || path === 'package.json' || path === 'README.md' || path === 'THIRD_PARTY_NOTICES.md' || path === 'docs/BROWSER_ACCEPTANCE.md' || path === 'docs/API.md' || path === 'docs/PROVENANCE.md' || /^dist\/[A-Za-z]+\.(js|d\.ts)$/.test(path), `Unexpected package file: ${path}`);
}
for (const path of fs.readdirSync('dist').filter(path => path.endsWith('.js'))) {
    const source = fs.readFileSync(`dist/${path}`, 'utf8');
    assert.ok(!/\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\bconsole\./.test(source));
}
console.log(JSON.stringify({ exports: Object.keys(api).sort(), packedFiles: pack.files.map(file => file.path), runtimeDependencies: 0, serverImport: 'passed', license: pkg.license }, null, 2));
