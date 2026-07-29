import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..');

test('仓库级名称统一为 tiangong-adapter，Wan 只作为生图子服务名称', async () => {
  const [packageRaw, lockRaw, readme, server] = await Promise.all([
    readFile(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'package-lock.json'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'README.md'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'src', 'server.ts'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageRaw) as {
    description?: string;
    name?: string;
  };
  const packageLock = JSON.parse(lockRaw) as {
    name?: string;
    packages?: Record<string, { name?: string }>;
  };

  assert.equal(packageJson.name, 'tiangong-adapter');
  assert.match(
    packageJson.description ?? '',
    /Tiangong integration layer for Open Design/,
  );
  assert.equal(packageLock.name, 'tiangong-adapter');
  assert.equal(packageLock.packages?.['']?.name, 'tiangong-adapter');
  assert.match(readme, /^# 天工 Open Design 适配层$/m);
  assert.doesNotMatch(readme, /tiangong-wan-adapter/);
  assert.match(readme, /tiangong-wan-image-adapter/);
  assert.doesNotMatch(server, /tiangong-wan-adapter/);
  assert.match(server, /tiangong-adapter image service listening/);
});
