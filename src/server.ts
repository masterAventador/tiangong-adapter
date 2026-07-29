import { createAdapterServer, loadConfig } from './app.js';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8_080;

function listenPort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

const config = loadConfig();
const host = process.env.HOST?.trim() || DEFAULT_HOST;
const port = listenPort(process.env.PORT);
const server = createAdapterServer(config);

server.listen(port, host, () => {
  process.stdout.write(
    `tiangong-adapter image service listening on http://${host}:${port}; models=${[...config.allowedModels].join(',')}\n`,
  );
});

function shutdown(signal: NodeJS.Signals): void {
  process.stdout.write(`received ${signal}, shutting down\n`);
  server.close((error) => {
    if (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
