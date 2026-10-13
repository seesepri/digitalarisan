const fs = await import('node:fs/promises');
const text = await fs.readFile('src/server/api-governance.ts', 'utf8');
const required = ['X-API-Version', 'application/vnd.digital-arisan.v', 'API_VERSION_NOT_SUPPORTED'];
for (const token of required) if (!text.includes(token)) throw new Error(`missing API contract token: ${token}`);
console.log('API contract governance: PASS');
