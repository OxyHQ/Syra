import { publicOpenApi } from '../packages/contracts/src';
const file = Bun.file(new URL('../packages/contracts/openapi.json', import.meta.url));
const expected = `${JSON.stringify(publicOpenApi(), null, 2)}\n`;
if (process.argv.includes('--write')) await Bun.write(file, expected);
else if (JSON.stringify(await file.json()) !== JSON.stringify(publicOpenApi()))
  throw new Error('Public OpenAPI stale: bun scripts/check-public-openapi.ts --write');
