import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..');

test('托管网关只接受统一登录的内部请求并由服务端注入 OD_API_TOKEN', async () => {
  const template = await readFile(
    path.join(REPOSITORY_ROOT, 'gateway', 'nginx.conf.template'),
    'utf8',
  );

  assert.match(template, /\$http_x_tiangong_gateway_token/i);
  assert.match(template, /\$\{TIANGONG_GATEWAY_TOKEN\}/);
  assert.match(template, /map_hash_bucket_size 128;/);
  assert.match(template, /proxy_set_header Authorization "Bearer \$\{OD_API_TOKEN\}"/);
  assert.ok(template.includes('location ~* \\.(?:map)$'));
  assert.match(template, /proxy_hide_header X-Powered-By/i);
  assert.match(template, /proxy_hide_header X-Nextjs-/i);
  assert.match(template, /server_tokens off/);
});

test('Compose 不再把 Open Design 直接暴露给主机', async () => {
  const compose = await readFile(
    path.join(REPOSITORY_ROOT, 'compose.tiangong.yaml'),
    'utf8',
  );

  const openDesignSection = compose.match(
    /\n  open-design:\n(?<section>[\s\S]*?)(?=\n  [a-z][a-z0-9-]+:\n)/,
  )?.groups?.section;
  const gatewaySection = compose.match(
    /\n  tiangong-gateway:\n(?<section>[\s\S]*?)(?=\n  [a-z][a-z0-9-]+:\n|\nvolumes:)/,
  )?.groups?.section;

  assert.ok(openDesignSection);
  assert.doesNotMatch(openDesignSection, /\n    ports:/);
  assert.match(openDesignSection, /\n    expose:\n      - "7456"/);
  assert.ok(gatewaySection);
  assert.match(gatewaySection, /127\.0\.0\.1:\$\{OPEN_DESIGN_PORT:-7456\}:7457/);
  assert.match(gatewaySection, /TIANGONG_GATEWAY_TOKEN/);
  assert.match(gatewaySection, /OD_API_TOKEN/);
});

test('派生镜像覆盖上游版本控制和旧 Compose 元数据', async () => {
  const dockerfile = await readFile(
    path.join(REPOSITORY_ROOT, 'Dockerfile.tiangong'),
    'utf8',
  );

  assert.match(
    dockerfile,
    /org\.opencontainers\.image\.revision="tiangong-1\.0\.0"/,
  );
  assert.match(dockerfile, /com\.docker\.compose\.project=""/);
  assert.match(dockerfile, /com\.docker\.compose\.service=""/);
});
