import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

const DEFAULT_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_COOKIE_NAME = 'tiangong_session';
const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FORM_BODY_LIMIT_BYTES = 8 * 1024;
const SESSION_TOKEN_BYTES = 32;
const SCRYPT_KEY_LENGTH = 64;

type Environment = Record<string, string | undefined>;

type PasswordHashParameters = {
  digest: Buffer;
  cost: number;
  parallelization: number;
  blockSize: number;
  salt: Buffer;
};

type FailedAttempt = {
  count: number;
  windowStartedAt: number;
};

export type LoginConfig = {
  attemptWindowMs: number;
  cookieName: string;
  cookieSecure: boolean;
  maxFailedAttempts: number;
  passwordHash: string;
  sessionTtlMs: number;
  username: string;
};

function requiredEnvironment(
  environment: Environment,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveIntegerEnvironment(
  environment: Environment,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parsePasswordHash(encoded: string): PasswordHashParameters {
  const [algorithm, costRaw, blockSizeRaw, parallelizationRaw, saltRaw, digestRaw] =
    encoded.split('$');
  const cost = Number(costRaw);
  const blockSize = Number(blockSizeRaw);
  const parallelization = Number(parallelizationRaw);
  if (
    algorithm !== 'scrypt'
    || !Number.isSafeInteger(cost)
    || cost < 2
    || (cost & (cost - 1)) !== 0
    || !Number.isSafeInteger(blockSize)
    || blockSize <= 0
    || !Number.isSafeInteger(parallelization)
    || parallelization <= 0
    || !saltRaw
    || !digestRaw
  ) {
    throw new Error(
      'TIANGONG_LOGIN_PASSWORD_HASH must use the scrypt$N$r$p$salt$digest format',
    );
  }

  const salt = Buffer.from(saltRaw, 'base64url');
  const digest = Buffer.from(digestRaw, 'base64url');
  if (salt.length < 16 || digest.length !== SCRYPT_KEY_LENGTH) {
    throw new Error(
      'TIANGONG_LOGIN_PASSWORD_HASH must contain a 16-byte salt and 64-byte scrypt digest',
    );
  }
  return { blockSize, cost, digest, parallelization, salt };
}

export function loadLoginConfig(
  environment: Environment = process.env,
): LoginConfig {
  const username = requiredEnvironment(
    environment,
    'TIANGONG_LOGIN_USERNAME',
  );
  const passwordHash = requiredEnvironment(
    environment,
    'TIANGONG_LOGIN_PASSWORD_HASH',
  );
  parsePasswordHash(passwordHash);

  const cookieSecureRaw =
    environment.TIANGONG_LOGIN_COOKIE_SECURE?.trim().toLowerCase();
  if (
    cookieSecureRaw
    && cookieSecureRaw !== 'true'
    && cookieSecureRaw !== 'false'
  ) {
    throw new Error('TIANGONG_LOGIN_COOKIE_SECURE must be true or false');
  }

  return {
    attemptWindowMs: positiveIntegerEnvironment(
      environment,
      'TIANGONG_LOGIN_ATTEMPT_WINDOW_SECONDS',
      DEFAULT_ATTEMPT_WINDOW_MS / 1000,
    ) * 1000,
    cookieName:
      environment.TIANGONG_LOGIN_COOKIE_NAME?.trim() || DEFAULT_COOKIE_NAME,
    cookieSecure: cookieSecureRaw !== 'false',
    maxFailedAttempts: positiveIntegerEnvironment(
      environment,
      'TIANGONG_LOGIN_MAX_FAILED_ATTEMPTS',
      DEFAULT_MAX_FAILED_ATTEMPTS,
    ),
    passwordHash,
    sessionTtlMs: positiveIntegerEnvironment(
      environment,
      'TIANGONG_LOGIN_SESSION_TTL_SECONDS',
      DEFAULT_SESSION_TTL_MS / 1000,
    ) * 1000,
    username,
  };
}

function deriveScrypt(
  password: string,
  parameters: PasswordHashParameters,
): Promise<Buffer> {
  const minimumMaxMemory =
    128 * parameters.cost * parameters.blockSize
    + 1024 * 1024;
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      parameters.salt,
      parameters.digest.length,
      {
        N: parameters.cost,
        maxmem: Math.max(32 * 1024 * 1024, minimumMaxMemory),
        p: parameters.parallelization,
        r: parameters.blockSize,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

function safeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

async function credentialsMatch(
  username: string,
  password: string,
  config: LoginConfig,
  passwordParameters: PasswordHashParameters,
): Promise<boolean> {
  const derived = await deriveScrypt(password, passwordParameters);
  const usernameMatches = safeTextEqual(username, config.username);
  const passwordMatches = timingSafeEqual(
    derived,
    passwordParameters.digest,
  );
  return usernameMatches && passwordMatches;
}

function sessionKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(request: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function requestSource(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const firstForwarded = raw?.split(',', 1)[0]?.trim();
  return (firstForwarded || request.socket.remoteAddress || 'unknown').slice(
    0,
    128,
  );
}

function secureHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeNextPath(value: string | null | undefined): string {
  if (
    !value
    || !value.startsWith('/')
    || value.startsWith('//')
    || /[\r\n]/u.test(value)
  ) {
    return '/';
  }
  return value;
}

function loginPage(next: string, message?: string): string {
  const alert = message
    ? `<div class="alert" role="alert">${escapeHtml(message)}</div>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>登录 · 天工</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090b10;color:#f5f7fb;padding:24px}
    main{width:min(100%,420px);padding:38px;border:1px solid #242936;border-radius:22px;background:#11141b;box-shadow:0 24px 80px #0008}
    .brand{display:flex;align-items:center;gap:12px;margin-bottom:30px}
    .mark{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:linear-gradient(145deg,#8b5cf6,#2563eb);font-size:20px;font-weight:800}
    h1{font-size:24px;margin:0}.sub{color:#929aab;margin:5px 0 0;font-size:14px}
    label{display:block;margin:18px 0 8px;color:#cbd1dc;font-size:14px}
    input{width:100%;height:48px;border:1px solid #303747;border-radius:12px;background:#0b0e14;color:#fff;padding:0 14px;font:inherit;outline:none}
    input:focus{border-color:#7c6df2;box-shadow:0 0 0 3px #7c6df226}
    button{width:100%;height:48px;margin-top:24px;border:0;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;font:600 15px inherit;cursor:pointer}
    .alert{margin:0 0 16px;padding:12px 14px;border:1px solid #7f1d1d;border-radius:10px;background:#2b1014;color:#fecaca;font-size:14px}
    .foot{margin:20px 0 0;text-align:center;color:#687083;font-size:12px}
  </style>
</head>
<body>
  <main>
    <div class="brand"><div class="mark">天</div><div><h1>登录天工</h1><p class="sub">仅限授权账号访问</p></div></div>
    ${alert}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <label for="username">账号</label>
      <input id="username" name="username" type="email" autocomplete="username" required autofocus>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">登录</button>
    </form>
    <p class="foot">登录状态仅保存在当前设备</p>
  </main>
</body>
</html>`;
}

function sendHtml(
  response: ServerResponse,
  status: number,
  next: string,
  message?: string,
): void {
  secureHeaders(response);
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(loginPage(next, message));
}

function sessionCookie(
  config: LoginConfig,
  value: string,
  maxAgeSeconds: number,
): string {
  return [
    `${config.cookieName}=${value}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    config.cookieSecure ? 'Secure' : '',
    'SameSite=Strict',
  ].filter(Boolean).join('; ');
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw new Error('unsupported_content_type');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > FORM_BODY_LIMIT_BYTES) {
      throw new Error('form_too_large');
    }
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function createLoginServer(config: LoginConfig): Server {
  const passwordParameters = parsePasswordHash(config.passwordHash);
  const sessions = new Map<string, number>();
  const failedAttempts = new Map<string, FailedAttempt>();

  function purgeExpiredSessions(now: number): void {
    for (const [key, expiresAt] of sessions) {
      if (expiresAt <= now) sessions.delete(key);
    }
  }

  function validSession(request: IncomingMessage, now: number): boolean {
    purgeExpiredSessions(now);
    const token = parseCookies(request).get(config.cookieName);
    if (!token) return false;
    const expiresAt = sessions.get(sessionKey(token));
    return expiresAt !== undefined && expiresAt > now;
  }

  function blockedSeconds(source: string, now: number): number {
    const attempt = failedAttempts.get(source);
    if (!attempt) return 0;
    const remaining =
      attempt.windowStartedAt + config.attemptWindowMs - now;
    if (remaining <= 0) {
      failedAttempts.delete(source);
      return 0;
    }
    return attempt.count >= config.maxFailedAttempts
      ? Math.ceil(remaining / 1000)
      : 0;
  }

  function recordFailedAttempt(source: string, now: number): void {
    const current = failedAttempts.get(source);
    if (
      !current
      || current.windowStartedAt + config.attemptWindowMs <= now
    ) {
      failedAttempts.set(source, { count: 1, windowStartedAt: now });
      return;
    }
    current.count += 1;
  }

  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://login.internal');
      const now = Date.now();

      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"status":"ok"}');
        return;
      }

      if (
        request.method === 'GET'
        && requestUrl.pathname === '/_auth/verify'
      ) {
        secureHeaders(response);
        response.writeHead(validSession(request, now) ? 204 : 401);
        response.end();
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/login') {
        if (validSession(request, now)) {
          secureHeaders(response);
          response.writeHead(303, {
            Location: safeNextPath(requestUrl.searchParams.get('next')),
          });
          response.end();
          return;
        }
        sendHtml(
          response,
          200,
          safeNextPath(requestUrl.searchParams.get('next')),
        );
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/login') {
        const source = requestSource(request);
        const retryAfter = blockedSeconds(source, now);
        if (retryAfter > 0) {
          response.setHeader('Retry-After', String(retryAfter));
          sendHtml(
            response,
            429,
            '/',
            '登录尝试过于频繁，请稍后再试',
          );
          return;
        }

        const form = await readForm(request);
        const next = safeNextPath(form.get('next'));
        const username = form.get('username') ?? '';
        const password = form.get('password') ?? '';
        if (
          !(await credentialsMatch(
            username,
            password,
            config,
            passwordParameters,
          ))
        ) {
          recordFailedAttempt(source, now);
          sendHtml(response, 401, next, '账号或密码错误');
          return;
        }

        failedAttempts.delete(source);
        purgeExpiredSessions(now);
        const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
        sessions.set(sessionKey(token), now + config.sessionTtlMs);
        secureHeaders(response);
        response.writeHead(303, {
          Location: next,
          'Set-Cookie': sessionCookie(
            config,
            token,
            Math.floor(config.sessionTtlMs / 1000),
          ),
        });
        response.end();
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/logout') {
        const token = parseCookies(request).get(config.cookieName);
        if (token) sessions.delete(sessionKey(token));
        secureHeaders(response);
        response.writeHead(303, {
          Location: '/login',
          'Set-Cookie': sessionCookie(config, '', 0),
        });
        response.end();
        return;
      }

      secureHeaders(response);
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    } catch (error) {
      const status =
        error instanceof Error && error.message === 'unsupported_content_type'
          ? 415
          : error instanceof Error && error.message === 'form_too_large'
            ? 413
            : 500;
      secureHeaders(response);
      response.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end(status === 500 ? 'Internal server error' : 'Invalid request');
    }
  });
}

export async function hashLoginPassword(password: string): Promise<string> {
  if (!password) {
    throw new Error('password must not be empty');
  }
  const salt = randomBytes(16);
  const parameters: PasswordHashParameters = {
    blockSize: 8,
    cost: 16384,
    digest: Buffer.alloc(SCRYPT_KEY_LENGTH),
    parallelization: 1,
    salt,
  };
  const digest = await deriveScrypt(password, parameters);
  return [
    'scrypt',
    String(parameters.cost),
    String(parameters.blockSize),
    String(parameters.parallelization),
    salt.toString('base64url'),
    digest.toString('base64url'),
  ].join('$');
}
