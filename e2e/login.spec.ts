import { expect, request, test } from '@playwright/test';

const LOGIN_USERNAME =
  process.env.TIANGONG_E2E_LOGIN_USERNAME ?? 'e2e@tiangong.invalid';
const LOGIN_PASSWORD =
  process.env.TIANGONG_E2E_LOGIN_PASSWORD ?? 'tiangong-e2e-password';
const E2E_BASE_URL =
  process.env.TIANGONG_E2E_BASE_URL ?? 'http://127.0.0.1:27456';

test('未登录被拦截，正确账密建立会话，退出后会话立即失效', async ({
  page,
}) => {
  const anonymousRequest = await request.newContext({ baseURL: E2E_BASE_URL });
  try {
    const apiResponse = await anonymousRequest.get('/api/health');
    expect(apiResponse.status()).toBe(401);
  } finally {
    await anonymousRequest.dispose();
  }

  await page.goto('/login');
  await expect(page).toHaveTitle('登录 · 天工');
  await expect(page.getByText('仅限授权账号访问')).toBeVisible();

  await page.getByLabel('账号').fill(LOGIN_USERNAME);
  await page.getByLabel('密码').fill('wrong-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('alert')).toHaveText('账号或密码错误');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('账号').fill(LOGIN_USERNAME);
  await page.getByLabel('密码').fill(LOGIN_PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL('/');
  await expect(page).toHaveTitle(/天工/);

  const sessionCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'tiangong_session',
  );
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.sameSite).toBe('Strict');

  const authenticatedHealth = await page.request.get('/api/health');
  expect(authenticatedHealth.status()).toBe(200);

  const logout = await page.request.post('/logout', {
    maxRedirects: 0,
  });
  expect(logout.status()).toBe(303);
  const loggedOutHealth = await page.request.get('/api/health');
  expect(loggedOutHealth.status()).toBe(401);
});
