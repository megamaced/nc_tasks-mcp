import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Single source of truth for the server's advertised version: package.json.
 *
 * Read at runtime through `createRequire` rather than a bundled `import ...
 * with { type: 'json' }` so it resolves identically from `src/` under tsx and
 * from `dist/` after `tsc`, without pulling package.json into the build output.
 */
const pkg = require('../package.json') as { version: string };

export const VERSION: string = pkg.version;
