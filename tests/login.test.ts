import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import test from 'node:test';

import {
  createLoginServer,
  loadLoginConfig,
  type LoginConfig,
} from '../src/login.js';

const USERNAME = 'test-user@tiangong.invalid';
const PASSWORD = 'test-password';
const PASSWORD_SALT = Buffer.from('tiangong-test-salt');
const PASSWORD_HASH = [
  'scrypt',
  '16384',
  '8',
  '1',
  PASSWORD_SALT.toString('base64url'),
  scryptSync(PASSWORD, PASSWORD_SALT, 64, {
    N: 16384,
    p: 1,
    r: 8,
  }).toString('base64url'),
].join('$');

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

function config(overrides: Partial<LoginConfig> = {}): LoginConfig {
  return {
    attemptWindowMs: 15 * 60 * 1000,
    cookieName: 'tiangong_session',
    cookieSecure: false,
    maxFailedAttempts: 5,
    passwordHash: PASSWORD_HASH,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    username: USERNAME,
    ...overrides,
  };
}

async function postLogin(
  baseUrl: string,
  username: string,
  password: string,
  next = '/',
  forwardedFor = '203.0.113.10',
): Promise<Response> {
  return fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': forwardedFor,
    },
    body: new URLSearchParams({ next, password, username }),
    redirect: 'manual',
  });
}

test('登录配置要求账号、scrypt 密码摘要并默认使用安全 Cookie', () => {
  const loaded = loadLoginConfig({
    TIANGONG_LOGIN_PASSWORD_HASH: PASSWORD_HASH,
    TIANGONG_LOGIN_USERNAME: USERNAME,
  });

  assert.deepEqual(loaded, {
    attemptWindowMs: 15 * 60 * 1000,
    cookieName: 'tiangong_session',
    cookieSecure: true,
    maxFailedAttempts: 5,
    passwordHash: PASSWORD_HASH,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    username: USERNAME,
  });
  assert.throws(
    () => loadLoginConfig({ TIANGONG_LOGIN_USERNAME: USERNAME }),
    /TIANGONG_LOGIN_PASSWORD_HASH/,
  );
  assert.throws(
    () => loadLoginConfig({
      TIANGONG_LOGIN_PASSWORD_HASH: 'plain-text-password',
      TIANGONG_LOGIN_USERNAME: USERNAME,
    }),
    /scrypt/,
  );
});

test('未登录只能看到安全的登录页，内部校验接口返回 401', async () => {
  const server = createLoginServer(config());
  const baseUrl = await listen(server);
  try {
    const page = await fetch(`${baseUrl}/login`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(
      page.headers.get('content-security-policy') ?? '',
      /default-src 'none'/,
    );
    const html = await page.text();
    assert.match(html, /天工/);
    assert.match(html, /name="username"/);
    assert.match(html, /name="password"/);
    assert.doesNotMatch(html, new RegExp(PASSWORD, 'i'));

    const verification = await fetch(`${baseUrl}/_auth/verify`);
    assert.equal(verification.status, 401);
  } finally {
    await close(server);
  }
});

test('错误账密不创建会话，正确账密创建 HttpOnly 会话并允许内部校验', async () => {
  const server = createLoginServer(config());
  const baseUrl = await listen(server);
  try {
    const rejected = await postLogin(baseUrl, USERNAME, 'wrong-password');
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('set-cookie'), null);
    assert.match(await rejected.text(), /账号或密码错误/);

    const accepted = await postLogin(
      baseUrl,
      USERNAME,
      PASSWORD,
      '/projects/demo?tab=files',
    );
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.get('location'), '/projects/demo?tab=files');
    const cookie = accepted.headers.get('set-cookie');
    assert.ok(cookie);
    assert.match(cookie, /^tiangong_session=[A-Za-z0-9_-]+;/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//i);
    assert.match(cookie, /Max-Age=43200/i);

    const verification = await fetch(`${baseUrl}/_auth/verify`, {
      headers: { cookie: cookie.split(';', 1)[0] ?? '' },
    });
    assert.equal(verification.status, 204);
    assert.equal(await verification.text(), '');
  } finally {
    await close(server);
  }
});

test('登录后拒绝站外跳转，退出会使原会话立即失效', async () => {
  const server = createLoginServer(config());
  const baseUrl = await listen(server);
  try {
    const accepted = await postLogin(
      baseUrl,
      USERNAME,
      PASSWORD,
      '//attacker.example/path',
    );
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.get('location'), '/');
    const cookie = accepted.headers.get('set-cookie');
    assert.ok(cookie);
    const requestCookie = cookie.split(';', 1)[0] ?? '';

    const logout = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { cookie: requestCookie },
      redirect: 'manual',
    });
    assert.equal(logout.status, 303);
    assert.equal(logout.headers.get('location'), '/login');
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/i);

    const verification = await fetch(`${baseUrl}/_auth/verify`, {
      headers: { cookie: requestCookie },
    });
    assert.equal(verification.status, 401);
  } finally {
    await close(server);
  }
});

test('同一来源连续输错达到阈值后被临时限速', async () => {
  const server = createLoginServer(config({ maxFailedAttempts: 2 }));
  const baseUrl = await listen(server);
  try {
    const first = await postLogin(baseUrl, USERNAME, 'wrong-1');
    const second = await postLogin(baseUrl, USERNAME, 'wrong-2');
    const blocked = await postLogin(baseUrl, USERNAME, PASSWORD);

    assert.equal(first.status, 401);
    assert.equal(second.status, 401);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '900');
    assert.equal(blocked.headers.get('set-cookie'), null);
  } finally {
    await close(server);
  }
});
