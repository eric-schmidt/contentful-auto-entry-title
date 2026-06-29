import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createRequire } from 'node:module';
import { stdin as input, stdout as output } from 'node:process';

// `contentful-import`'s published ESM build has a broken `lodash/object` named-import.
// The package's own `node` export condition maps to the CJS build, so load it that way.
const require = createRequire(import.meta.url);
const contentfulImport: typeof import('contentful-import').default = require('contentful-import');

const useColor = output.isTTY && process.env.NO_COLOR === undefined;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  green: wrap('32'),
  red: wrap('31'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  gray: wrap('90'),
  bold: wrap('1'),
};

const tag = c.cyan('[import-content-model]');
const log = (msg: string) => console.log(`${tag} ${msg}`);
const err = (msg: string) => console.error(`${tag} ${msg}`);

const { CONTENTFUL_ACCESS_TOKEN } = process.env;

if (!CONTENTFUL_ACCESS_TOKEN) {
  err(c.red('Missing CONTENTFUL_ACCESS_TOKEN.'));
  err(c.red('Populate it in .env at the repo root, then re-run.'));
  process.exit(1);
}

if (!input.isTTY) {
  err(c.red('This script prompts for the space and environment IDs interactively.'));
  err(c.red('Re-run it in an interactive terminal.'));
  process.exit(1);
}

const dir = join(process.cwd(), 'exports/space');

let candidates: string[];
try {
  candidates = readdirSync(dir).filter((f) => f.endsWith('.json'));
} catch (e) {
  err(c.red(`Could not read directory ${dir}: ${(e as Error).message}`));
  process.exit(1);
}

if (candidates.length === 0) {
  err(c.red(`No .json files found in ${dir}. Nothing to import.`));
  process.exit(1);
}

const skipConfirm = process.argv.includes('--yes') || process.argv.includes('-y');

const rl = createInterface({ input, output });
let chosenFile: string;
let spaceId: string;
let environmentId: string;
let confirmed = skipConfirm;
try {
  if (candidates.length === 1) {
    chosenFile = candidates[0];
    log(`Found one export: ${c.bold(chosenFile)}`);
  } else {
    log(`Found ${c.bold(String(candidates.length))} exports in ${c.bold('exports/space')}:`);
    candidates.forEach((f, i) => log(`  ${c.bold(`[${i + 1}]`)} ${f}`));
    const answer = (
      await rl.question(`${tag} ${c.bold('Select an export')} ${c.gray(`(1-${candidates.length})`)}: `)
    ).trim();
    const idx = Number(answer) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
      err(c.red(`Invalid selection: ${answer}`));
      process.exit(1);
    }
    chosenFile = candidates[idx];
  }

  spaceId = (await rl.question(`${tag} ${c.bold('Space ID')}: `)).trim();
  if (!spaceId) {
    err(c.red('Space ID is required.'));
    process.exit(1);
  }
  environmentId = (
    await rl.question(`${tag} ${c.bold('Environment ID')} ${c.gray('(e.g. master)')}: `)
  ).trim();
  if (!environmentId) {
    err(c.red('Environment ID is required.'));
    process.exit(1);
  }
  if (!confirmed) {
    const answer = (
      await rl.question(
        `${tag} ${c.yellow('Proceed with full import of')} ${c.bold(chosenFile)} ${c.yellow('into')} space=${c.bold(spaceId)} env=${c.bold(environmentId)}${c.yellow('?')} ${c.gray('(y/N)')}: `,
      )
    )
      .trim()
      .toLowerCase();
    confirmed = answer === 'y' || answer === 'yes';
  }
} finally {
  rl.close();
}

const contentFile = join(dir, chosenFile);

if (!confirmed) {
  log(c.yellow('Aborted.'));
  process.exit(0);
}

log(
  `Importing ${c.bold(`exports/space/${chosenFile}`)} into space=${c.bold(spaceId)} env=${c.bold(environmentId)}`,
);

try {
  await contentfulImport({
    contentFile,
    spaceId,
    environmentId,
    managementToken: CONTENTFUL_ACCESS_TOKEN,
    useVerboseRenderer: true,
  });
  log(`${c.green('Done.')} Import completed successfully.`);
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  err(`${c.red('FAIL')} ${msg}`);
  const data =
    (e as { errors?: unknown }).errors ??
    (e as { response?: { data?: unknown } }).response?.data ??
    (e as { data?: unknown }).data;
  if (data) {
    err(c.gray(`     details: ${JSON.stringify(data, null, 2)}`));
  }
  process.exit(1);
}
