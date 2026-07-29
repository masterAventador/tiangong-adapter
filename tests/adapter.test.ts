import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer, type Server } from 'node:http';
import test from 'node:test';

import {
  createAdapterServer,
  loadConfig,
  type AdapterConfig,
} from '../src/app.js';

type RecordedRequest = {
  authorization: string | undefined;
  body: unknown;
  method: string | undefined;
  path: string | undefined;
};

type UpstreamReply = {
  body: unknown;
  status: number;
};

const ADAPTER_API_KEY = 'adapter-secret';
const DASHSCOPE_API_KEY = 'dashscope-secret';
const IMAGE_URL = 'https://example.invalid/generated.png';

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

async function readJsonBody(request: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function startHarness(
  upstreamReply: UpstreamReply = {
    status: 200,
    body: {
      output: {
        choices: [{
          message: {
            content: [{ type: 'image', image: IMAGE_URL }],
          },
        }],
        finished: true,
      },
      request_id: 'req-success',
    },
  },
): Promise<{
  adapterUrl: string;
  closeAll: () => Promise<void>;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const upstream = createHttpServer(async (request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      body: await readJsonBody(request),
      method: request.method,
      path: request.url,
    });
    response.writeHead(upstreamReply.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(upstreamReply.body));
  });
  const upstreamUrl = await listen(upstream);

  const config: AdapterConfig = {
    adapterApiKey: ADAPTER_API_KEY,
    allowedModels: new Set(['wan2.7-image']),
    dashscopeApiKey: DASHSCOPE_API_KEY,
    dashscopeBaseUrl: upstreamUrl,
    maxBodyBytes: 25 * 1024 * 1024,
    requestTimeoutMs: 1_000,
  };
  const adapter = createAdapterServer(config);
  const adapterUrl = await listen(adapter);

  return {
    adapterUrl,
    requests,
    closeAll: async () => {
      await close(adapter);
      await close(upstream);
    },
  };
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  apiKey = ADAPTER_API_KEY,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('健康检查不需要鉴权，生图接口必须使用适配器令牌', async () => {
  const harness = await startHarness();
  try {
    const health = await fetch(`${harness.adapterUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      model: 'wan2.7-image',
      status: 'ok',
    });

    const unauthorized = await fetch(`${harness.adapterUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'wan2.7-image', prompt: '一只猫' }),
    });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), {
      error: {
        code: 'invalid_api_key',
        message: 'Invalid adapter API key',
        type: 'authentication_error',
      },
    });
    assert.equal(harness.requests.length, 0);
  } finally {
    await harness.closeAll();
  }
});

test('把 Open Design 文生图请求转换为 Wan 2.7 同步请求', async () => {
  const harness = await startHarness();
  try {
    const response = await postJson(
      harness.adapterUrl,
      '/v1/images/generations',
      {
        model: 'wan2.7-image',
        n: 1,
        prompt: '一座未来主义的中国园林',
        size: '1792x1024',
      },
    );

    assert.equal(response.status, 200);
    const responseBody = await response.json() as {
      created: number;
      data: Array<{ url: string }>;
    };
    assert.equal(typeof responseBody.created, 'number');
    assert.deepEqual(responseBody.data, [{ url: IMAGE_URL }]);
    assert.deepEqual(harness.requests, [{
      authorization: `Bearer ${DASHSCOPE_API_KEY}`,
      body: {
        input: {
          messages: [{
            content: [{ text: '一座未来主义的中国园林' }],
            role: 'user',
          }],
        },
        model: 'wan2.7-image',
        parameters: {
          n: 1,
          size: '1792*1024',
          thinking_mode: true,
          watermark: false,
        },
      },
      method: 'POST',
      path: '/api/v1/services/aigc/multimodal-generation/generation',
    }]);
  } finally {
    await harness.closeAll();
  }
});

test('把 Open Design JSON 图像编辑请求转换为 Wan 2.7 多图输入', async () => {
  const harness = await startHarness();
  try {
    const response = await postJson(
      harness.adapterUrl,
      '/v1/images/edits',
      {
        images: [
          { image_url: 'data:image/png;base64,AAAA' },
          { image_url: 'https://example.invalid/reference.webp' },
        ],
        model: 'wan2.7-image',
        n: 1,
        prompt: '把图二的风格应用到图一',
        response_format: 'b64_json',
        size: '1024x1536',
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json() as { data: Array<{ url: string }> }).data,
      [{ url: IMAGE_URL }],
    );
    assert.deepEqual(harness.requests[0]?.body, {
      input: {
        messages: [{
          content: [
            { image: 'data:image/png;base64,AAAA' },
            { image: 'https://example.invalid/reference.webp' },
            { text: '把图二的风格应用到图一' },
          ],
          role: 'user',
        }],
      },
      model: 'wan2.7-image',
      parameters: {
        n: 1,
        size: '1024*1536',
        watermark: false,
      },
    });
  } finally {
    await harness.closeAll();
  }
});

test('拒绝未授权模型和多张输出，避免意外调用及额外费用', async () => {
  const harness = await startHarness();
  try {
    const invalidModel = await postJson(
      harness.adapterUrl,
      '/v1/images/generations',
      { model: 'wan2.7-image-pro', n: 1, prompt: '一只猫' },
    );
    assert.equal(invalidModel.status, 400);
    assert.equal(
      (await invalidModel.json() as { error: { code: string } }).error.code,
      'unsupported_model',
    );

    const invalidCount = await postJson(
      harness.adapterUrl,
      '/v1/images/generations',
      { model: 'wan2.7-image', n: 2, prompt: '一只猫' },
    );
    assert.equal(invalidCount.status, 400);
    assert.equal(
      (await invalidCount.json() as { error: { code: string } }).error.code,
      'invalid_image_count',
    );
    assert.equal(harness.requests.length, 0);
  } finally {
    await harness.closeAll();
  }
});

test('把百炼错误转换成 OpenAI 兼容错误并保留请求 ID', async () => {
  const harness = await startHarness({
    status: 429,
    body: {
      code: 'Throttling',
      message: 'Too many requests',
      request_id: 'req-throttled',
    },
  });
  try {
    const response = await postJson(
      harness.adapterUrl,
      '/v1/images/generations',
      { model: 'wan2.7-image', n: 1, prompt: '一只猫' },
    );
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'Throttling',
        message: 'Too many requests',
        param: null,
        request_id: 'req-throttled',
        type: 'dashscope_error',
      },
    });
  } finally {
    await harness.closeAll();
  }
});

test('百炼成功响应不含图片时返回网关错误', async () => {
  const harness = await startHarness({
    status: 200,
    body: {
      output: { choices: [], finished: true },
      request_id: 'req-empty',
    },
  });
  try {
    const response = await postJson(
      harness.adapterUrl,
      '/v1/images/generations',
      { model: 'wan2.7-image', n: 1, prompt: '一只猫' },
    );
    assert.equal(response.status, 502);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      'invalid_upstream_response',
    );
  } finally {
    await harness.closeAll();
  }
});

test('从环境变量加载安全默认配置', () => {
  const config = loadConfig({
    ADAPTER_API_KEY: ADAPTER_API_KEY,
    DASHSCOPE_API_KEY: DASHSCOPE_API_KEY,
    DASHSCOPE_BASE_URL: 'https://workspace.cn-beijing.maas.aliyuncs.com/',
  });

  assert.equal(config.adapterApiKey, ADAPTER_API_KEY);
  assert.equal(config.dashscopeApiKey, DASHSCOPE_API_KEY);
  assert.equal(
    config.dashscopeBaseUrl,
    'https://workspace.cn-beijing.maas.aliyuncs.com',
  );
  assert.deepEqual([...config.allowedModels], ['wan2.7-image']);
  assert.equal(config.maxBodyBytes, 30 * 1024 * 1024);
  assert.equal(config.requestTimeoutMs, 180_000);
});

test('缺少百炼配置时拒绝启动', () => {
  assert.throws(
    () => loadConfig({
      ADAPTER_API_KEY: ADAPTER_API_KEY,
      DASHSCOPE_BASE_URL: 'https://workspace.cn-beijing.maas.aliyuncs.com',
    }),
    /DASHSCOPE_API_KEY is required/,
  );
});
