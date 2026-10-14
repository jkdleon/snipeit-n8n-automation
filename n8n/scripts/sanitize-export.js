// Cleans n8n workflow exports before they're committed: removes pinned data
// and replaces any Gmail address with the example.com placeholder.
// Usage: node n8n/scripts/sanitize-export.js <file.json> [...]
const fs = require('fs');

for (const file of process.argv.slice(2)) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete wf.pinData;
  const text = JSON.stringify(wf, null, 2)
    .replace(/[A-Za-z0-9._-]+(\+[A-Za-z0-9._-]+)?@gmail\.com/g, (_, tag) => `it-admin${tag || ''}@example.com`);
  fs.writeFileSync(file, text + '\n');
  console.log(`sanitized ${file}`);
}
