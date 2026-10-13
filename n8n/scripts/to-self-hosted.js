// Makes self-hosted copies of the n8n Cloud workflow exports.
// Usage: node n8n/scripts/to-self-hosted.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'workflows');
const DEST = path.join(__dirname, '..', 'workflows-self-hosted');
const CLOUD_API = 'https://snipeit-api.jkdeleon.net/api/v1';
const INTERNAL_API = 'http://app/api/v1';

fs.mkdirSync(DEST, { recursive: true });
for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.json'))) {
  const wf = JSON.parse(fs.readFileSync(path.join(SRC, file), 'utf8'));
  let switched = 0;
  for (const node of wf.nodes) {
    const p = node.parameters || {};
    if (typeof p.url === 'string' && p.url.includes(CLOUD_API)) {
      p.url = p.url.replace(CLOUD_API, INTERNAL_API);
      delete p.provideSslCertificates;
      if (node.credentials) delete node.credentials.httpSslAuth;
      switched++;
    }
    if (typeof p.jsCode === 'string') {
      p.jsCode = p.jsCode.replace(' // TEST VALUE: set back to 3 after the test', '');
    }
  }
  // The error workflow gets a new ID on import; it's set again in the editor.
  if (wf.settings) delete wf.settings.errorWorkflow;
  fs.writeFileSync(path.join(DEST, file), JSON.stringify(wf, null, 2) + '\n');
  console.log(`${file}: ${switched} Snipe-IT URL(s) switched`);
}
