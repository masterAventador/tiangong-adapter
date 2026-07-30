import { stdin } from 'node:process';

import {
  createLoginServer,
  hashLoginPassword,
  loadLoginConfig,
} from './login.js';

async function readPasswordFromStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '');
}

async function main(): Promise<void> {
  if (process.argv.includes('--hash-password')) {
    process.stdout.write(
      `${await hashLoginPassword(await readPasswordFromStandardInput())}\n`,
    );
    return;
  }

  const port = Number(process.env.PORT ?? '8081');
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }
  const host = process.env.HOST?.trim() || '0.0.0.0';
  const server = createLoginServer(loadLoginConfig());
  server.listen(port, host, () => {
    console.log(`tiangong temporary login listening on ${host}:${port}`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
