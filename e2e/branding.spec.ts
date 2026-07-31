import { expect, request, test } from '@playwright/test';

const DIRECT_GATEWAY_URL =
  process.env.TIANGONG_E2E_DIRECT_GATEWAY_URL ?? 'http://127.0.0.1:27456';
const LOGIN_USERNAME =
  process.env.TIANGONG_E2E_LOGIN_USERNAME ?? 'e2e@tiangong.invalid';
const LOGIN_PASSWORD =
  process.env.TIANGONG_E2E_LOGIN_PASSWORD ?? 'tiangong-e2e-password';
const ACTIVE_ARTIFACT_PREVIEW_SELECTOR =
  '[data-testid="artifact-preview-frame"]:visible, '
  + '[data-testid="artifact-preview-frame-url-load"]:visible, '
  + '[data-testid="artifact-preview-frame-srcdoc"]:visible, '
  + '[data-testid="live-artifact-preview-frame"]:visible';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('账号').fill(LOGIN_USERNAME);
  await page.getByLabel('密码').fill(LOGIN_PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL('/');
});

test('统一登录后的首页只展示天工品牌并保留 Qwen 与真实模型名称', async ({
  page,
}) => {
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);

  await expect(page).toHaveTitle(/天工/);
  await expect(page.getByText('天工', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: /本地 CLI.*Qwen Code.*qwen3-coder-plus/,
    }),
  ).toBeVisible();

  const visibleText = await page.locator('body').innerText();
  expect(visibleText).not.toMatch(
    /Open Design|Nexu Labs|HyperFrames|Remotion|GSAP|Excalidraw|HeyGen/,
  );
  await expect(
    page.locator('a[href*="github.com/nexu-io/open-design"]:visible'),
  ).toHaveCount(0);
  await expect(page.locator('link[rel~="icon"]')).toHaveAttribute(
    'href',
    '/_tiangong/brand.svg',
  );
});

test('登录后可以打开真实项目工作台', async ({ page }) => {
  const projectId = crypto.randomUUID();
  const response = await page.request.post('/api/projects', {
    data: {
      conversationMode: 'design',
      designSystemId: null,
      id: projectId,
      metadata: { kind: 'prototype' },
      name: '天工项目工作台验收',
      pendingPrompt: null,
      skillId: null,
    },
  });
  expect(response.status()).toBe(200);

  await page.goto(`/projects/${projectId}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByTestId('chat-composer')).toBeVisible();
  await expect(page.getByTestId('chat-composer-input')).toBeVisible();
  await expect(page.getByTestId('file-workspace')).toBeVisible();
  await expect(page.getByText('This page couldn’t load')).toHaveCount(0);
});

test('远程托管的 WebGL2 文件回退到同域预览且不请求 localhost', async ({
  page,
}) => {
  const isolationResponse = await page.request.get('/api/preview/isolation');
  expect(isolationResponse.status()).toBe(200);
  expect(await isolationResponse.json()).toEqual({
    baseOrigin: null,
    pathPrefix: 'powered',
    supported: false,
  });

  const projectId = crypto.randomUUID();
  const projectResponse = await page.request.post('/api/projects', {
    data: {
      conversationMode: 'design',
      designSystemId: null,
      id: projectId,
      metadata: { kind: 'prototype' },
      name: '远程 WebGL2 预览验收',
      pendingPrompt: null,
      skillId: null,
    },
  });
  expect(projectResponse.status()).toBe(200);
  const { conversationId } = (await projectResponse.json()) as {
    conversationId: string;
  };

  const fileName = 'remote-webgl2-preview.html';
  const fileResponse = await page.request.post(
    `/api/projects/${projectId}/files`,
    {
      data: {
        artifactManifest: {
          entry: fileName,
          exports: ['html'],
          kind: 'html',
          renderer: 'html',
          title: fileName,
          version: 1,
        },
        content: [
          '<!doctype html>',
          '<html><body>',
          '<h1>WebGL2 remote preview</h1>',
          '<canvas id="surface"></canvas>',
          '<script>',
          "document.querySelector('#surface').getContext('webgl2');",
          '</script>',
          '</body></html>',
        ].join(''),
        name: fileName,
      },
    },
  );
  expect(fileResponse.status()).toBe(200);

  const applicationOrigin = new URL(page.url()).origin;
  const foreignLoopbackRequests: string[] = [];
  const recordLocalhostRequest = (request: { url(): string }) => {
    const url = new URL(request.url());
    if (
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
      && url.origin !== applicationOrigin
    ) {
      foreignLoopbackRequests.push(url.href);
    }
  };
  page.on('request', recordLocalhostRequest);
  try {
    await page.goto(
      `/projects/${projectId}/conversations/${conversationId}/files/${fileName}`,
      { waitUntil: 'domcontentloaded' },
    );
    await expect(
      page
        .frameLocator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR)
        .getByRole('heading', { name: 'WebGL2 remote preview' }),
    ).toBeVisible();

    const previewFrame = page
      .locator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR)
      .first();
    const previewSource = await previewFrame.getAttribute('src');
    expect(previewSource).toBeTruthy();
    expect(new URL(previewSource ?? '', page.url()).origin).toBe(
      applicationOrigin,
    );
    expect(foreignLoopbackRequests).toEqual([]);
  } finally {
    page.off('request', recordLocalhostRequest);
  }
});

test('设置入口不暴露上游社交账号和仓库链接', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const settingsButton = page.getByRole('button', { name: '打开设置' });
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();

  await expect(
    page.getByText('@opendesign.ai', { exact: false }).filter({ visible: true }),
  ).toHaveCount(0);
  const visibleLinks = await page.locator('a:visible').evaluateAll((links) =>
    links.map((link) => {
      const href = (link as HTMLAnchorElement).href;
      try {
        return decodeURIComponent(href);
      } catch {
        return href;
      }
    }),
  );
  expect(visibleLinks.join('\n')).not.toMatch(
    /github\.com\/nexu-io\/open-design|open-design\.ai|opendesign\.ai/i,
  );
});

test('设置详情只保留 Qwen Code 和当前媒体生成配置', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '打开设置' }).click();
  await page.getByRole('menuitem', { name: /设置.*详情/ }).click();

  await expect(
    page.getByRole('button', { name: /Qwen Code.*0\.18\.0/ }),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: '模型' })).toContainText(
    'qwen3-coder-plus',
  );
  for (const hiddenLabel of ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI']) {
    await expect(
      page.getByText(hiddenLabel, { exact: true }).filter({ visible: true }),
    ).toHaveCount(0);
  }

  await page.getByRole('button', { name: '媒体生成提供商' }).click();
  await expect(page.getByText('Custom Image API', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Custom Image API model' }),
  ).toHaveValue('wan2.7-image');
  for (const hiddenProvider of [
    'AIHubMix',
    'Codex Subscription',
    'ElevenLabs',
    'Fal.ai',
    'FishAudio',
    'ImageRouter',
    'Leonardo.ai',
    'MiniMax',
    'Nano Banana',
    'OpenAI',
    'OpenRouter',
    'SenseAudio',
    'Tavily Search',
    'Volcengine Ark (Doubao)',
    'xAI Grok Imagine',
  ]) {
    await expect(
      page.getByText(hiddenProvider, { exact: true }).filter({ visible: true }),
    ).toHaveCount(0);
  }
  const visibleControlLabels = await page
    .locator('input:visible,textarea:visible,button:visible')
    .evaluateAll((elements) =>
      elements.map((element) => [
        element.getAttribute('aria-label'),
        element.getAttribute('placeholder'),
        element.textContent,
      ].filter(Boolean).join(' ')),
    );
  expect(visibleControlLabels.join('\n')).not.toMatch(
    /AIHubMix|Codex Subscription|ElevenLabs|Fal\.ai|FishAudio|ImageRouter|Leonardo\.ai|MiniMax|Nano Banana|OpenAI API|OpenRouter|SenseAudio|Tavily Search|Volcengine Ark|xAI Grok Imagine/,
  );
});

test('托管网关阻断源码映射、清理响应头并隐藏上游版本信息', async ({
  page,
}) => {
  const homeResponse = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(homeResponse?.headers()['x-powered-by']).toBeUndefined();
  expect(homeResponse?.headers()['x-nextjs-cache']).toBeUndefined();

  const scriptSource = await page
    .locator('script[src*="/_next/static/"]')
    .first()
    .getAttribute('src');
  expect(scriptSource).toBeTruthy();
  const sourceMapResponse = await page.request.get(`${scriptSource}.map`);
  expect(sourceMapResponse.status()).toBe(404);

  const versionResponse = await page.request.get('/api/version');
  expect(versionResponse.status()).toBe(200);
  expect(await versionResponse.json()).toEqual({
    arch: 'server',
    channel: 'production',
    packaged: true,
    platform: 'web',
    version: '1.0.0',
  });

  const anonymousRequest = await request.newContext();
  try {
    const directResponse = await anonymousRequest.get(
      `${DIRECT_GATEWAY_URL}/api/health`,
    );
    expect(directResponse.status()).toBe(401);
  } finally {
    await anonymousRequest.dispose();
  }
});
