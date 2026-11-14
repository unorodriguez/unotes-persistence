import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
assert.equal(manifest.license, 'MIT');
assert.equal(lock.packages[''].license, manifest.license);
assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
const records = Object.entries(lock.packages).filter(([path]) => path !== '').sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, entry]) => {
    if (entry.resolved) {
        const url = new URL(entry.resolved);
        assert.equal(url.hostname, 'registry.npmjs.org');
        assert.equal(url.protocol, 'https:');
        assert.ok(!url.username && !url.password);
        assert.ok(entry.integrity, `Missing lock integrity: ${path}`);
    }
    return { path, version: entry.version, scope: 'development-only', declaredLicense: entry.license ?? null, optional: entry.optional === true };
});
const inventory = JSON.stringify({ scope: 'Locked development tools only; the distributed library has zero third-party runtime dependencies. Metadata is not legal clearance.', records }, null, 2) + '\n';
if (process.argv.includes('--write')) fs.writeFileSync('docs/DEPENDENCY_LICENSES.json', inventory);
else assert.equal(fs.readFileSync('docs/DEPENDENCY_LICENSES.json', 'utf8'), inventory, 'Dependency inventory differs. Review before refreshing.');
const missingInstalledEvidence = [];
const supplemental = JSON.parse(fs.readFileSync('docs/DEVELOPMENT_LICENSE_EVIDENCE.json', 'utf8')).records;
for (const item of supplemental) {
    assert.equal(createHash('sha256').update(fs.readFileSync(item.file)).digest('hex'), item.sha256);
    assert.ok(new URL(item.source).hostname === 'raw.githubusercontent.com');
}
let inspected = 0;
for (const record of records) {
    if (!fs.existsSync(`${record.path}/package.json`)) {
        assert.ok(record.optional, `Required package missing: ${record.path}`);
        continue;
    }
    const pkg = JSON.parse(fs.readFileSync(`${record.path}/package.json`, 'utf8'));
    assert.equal(pkg.version, record.version);
    inspected += 1;
    const licenses = fs.readdirSync(record.path).filter(name => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name));
    const externalText = supplemental.find(item => item.package === pkg.name && item.version === pkg.version);
    if (!pkg.license || (!licenses.length && !externalText)) missingInstalledEvidence.push(record.path);
}
console.log(JSON.stringify({ locked: records.length, installedInspected: inspected, missingInstalledEvidence, runtimeDependencies: 0, projectLicenseSelected: true }, null, 2));
assert.deepEqual(missingInstalledEvidence, [], 'Review missing installed development license evidence.');
