import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

const DASH_SCOPE_GENERATION_PATH =
  '/api/v1/services/aigc/multimodal-generation/generation';
const DEFAULT_MODEL = 'wan2.7-image';
const MAX_PROMPT_LENGTH = 5_000;
const MAX_REFERENCE_IMAGES = 9;

export type AdapterConfig = {
  adapterApiKey: string;
  allowedModels: ReadonlySet<string>;
  dashscopeApiKey: string;
  dashscopeBaseUrl: string;
  maxBodyBytes: number;
  requestTimeoutMs: number;
};

type ImageRequest = {
  images?: unknown;
  model?: unknown;
  n?: unknown;
  prompt?: unknown;
  size?: unknown;
};

type ErrorBody = {
  error: {
    code: string;
    message: string;
    param?: null;
    request_id?: string;
    type: string;
  };
};

class HttpError extends Error {
  readonly code: string;
  readonly status: number;
  readonly type: string;

  constructor(status: number, code: string, message: string, type = 'invalid_request_error') {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.type = type;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function errorBody(error: HttpError): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      type: error.type,
    },
  };
}

function secureTokenEquals(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function requireAuthorization(request: IncomingMessage, config: AdapterConfig): void {
  const authorization = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match?.[1] || !secureTokenEquals(match[1], config.adapterApiKey)) {
    throw new HttpError(
      401,
      'invalid_api_key',
      'Invalid adapter API key',
      'authentication_error',
    );
  }
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<ImageRequest> {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(
      415,
      'unsupported_media_type',
      'Content-Type must be application/json',
    );
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      throw new HttpError(413, 'request_too_large', 'Request body is too large');
    }
    chunks.push(buffer);
  }

  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value as ImageRequest;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object');
  }
}

function requirePrompt(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'invalid_prompt', 'prompt must be a non-empty string');
  }
  const prompt = value.trim();
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new HttpError(
      400,
      'invalid_prompt',
      `prompt must not exceed ${MAX_PROMPT_LENGTH} characters`,
    );
  }
  return prompt;
}

function requireModel(value: unknown, allowedModels: ReadonlySet<string>): string {
  if (typeof value !== 'string' || !allowedModels.has(value.trim())) {
    throw new HttpError(
      400,
      'unsupported_model',
      `model must be one of: ${[...allowedModels].join(', ')}`,
    );
  }
  return value.trim();
}

function requireSingleImage(value: unknown): 1 {
  if (value === undefined || value === 1) {
    return 1;
  }
  throw new HttpError(
    400,
    'invalid_image_count',
    'Only n=1 is supported to prevent accidental extra charges',
  );
}

function normalizeSize(value: unknown): string {
  if (value === undefined) {
    return '1024*1024';
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid_size', 'size must be a string');
  }
  const normalized = value.trim();
  if (/^(1K|2K)$/i.test(normalized)) {
    return normalized.toUpperCase();
  }
  if (/^\d{3,4}[x*]\d{3,4}$/.test(normalized)) {
    return normalized.replace('x', '*');
  }
  throw new HttpError(
    400,
    'invalid_size',
    'size must be 1K, 2K, or WIDTHxHEIGHT',
  );
}

function requireImages(value: unknown): Array<{ image: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REFERENCE_IMAGES) {
    throw new HttpError(
      400,
      'invalid_images',
      `images must contain between 1 and ${MAX_REFERENCE_IMAGES} items`,
    );
  }
  return value.map((item) => {
    if (
      !item
      || typeof item !== 'object'
      || !('image_url' in item)
      || typeof item.image_url !== 'string'
      || item.image_url.trim().length === 0
    ) {
      throw new HttpError(
        400,
        'invalid_images',
        'each image must contain a non-empty image_url',
      );
    }
    return { image: item.image_url.trim() };
  });
}

function dashscopeEndpoint(baseUrl: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  if (trimmedBase.endsWith('/api/v1')) {
    return `${trimmedBase}/services/aigc/multimodal-generation/generation`;
  }
  return `${trimmedBase}${DASH_SCOPE_GENERATION_PATH}`;
}

function toWanRequest(
  body: ImageRequest,
  isEdit: boolean,
  allowedModels: ReadonlySet<string>,
): object {
  const prompt = requirePrompt(body.prompt);
  const model = requireModel(body.model, allowedModels);
  const n = requireSingleImage(body.n);
  const size = normalizeSize(body.size);
  const images = isEdit ? requireImages(body.images) : [];

  return {
    model,
    input: {
      messages: [{
        role: 'user',
        content: [...images, { text: prompt }],
      }],
    },
    parameters: {
      size,
      n,
      watermark: false,
      ...(!isEdit ? { thinking_mode: true } : {}),
    },
  };
}

async function parseUpstreamJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(
      502,
      'invalid_upstream_response',
      'DashScope returned invalid JSON',
      'api_error',
    );
  }
}

function upstreamError(status: number, body: Record<string, unknown>): {
  body: ErrorBody;
  status: number;
} {
  const code = typeof body.code === 'string' ? body.code : 'dashscope_error';
  const message = typeof body.message === 'string'
    ? body.message
    : `DashScope request failed with HTTP ${status}`;
  const requestId = typeof body.request_id === 'string' ? body.request_id : undefined;
  return {
    status,
    body: {
      error: {
        code,
        message,
        param: null,
        ...(requestId ? { request_id: requestId } : {}),
        type: 'dashscope_error',
      },
    },
  };
}

function extractImageUrls(body: Record<string, unknown>): string[] {
  const output = body.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return [];
  }
  const choices = 'choices' in output ? output.choices : undefined;
  if (!Array.isArray(choices)) {
    return [];
  }

  const urls: string[] = [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object' || !('message' in choice)) {
      continue;
    }
    const message = choice.message;
    if (!message || typeof message !== 'object' || !('content' in message)) {
      continue;
    }
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const item of message.content) {
      if (
        item
        && typeof item === 'object'
        && 'image' in item
        && typeof item.image === 'string'
        && item.image.length > 0
      ) {
        urls.push(item.image);
      }
    }
  }
  return urls;
}

async function callDashScope(
  wanBody: object,
  config: AdapterConfig,
): Promise<{ body: unknown; status: number }> {
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(dashscopeEndpoint(config.dashscopeBaseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.dashscopeApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(wanBody),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    if (
      error instanceof Error
      && (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      throw new HttpError(
        504,
        'upstream_timeout',
        'DashScope request timed out',
        'api_error',
      );
    }
    throw new HttpError(
      502,
      'upstream_unavailable',
      'Could not connect to DashScope',
      'api_error',
    );
  }

  const upstreamBody = await parseUpstreamJson(upstreamResponse);
  if (!upstreamResponse.ok) {
    return upstreamError(upstreamResponse.status, upstreamBody);
  }
  if (typeof upstreamBody.code === 'string') {
    return upstreamError(502, upstreamBody);
  }

  const imageUrls = extractImageUrls(upstreamBody);
  if (imageUrls.length === 0) {
    throw new HttpError(
      502,
      'invalid_upstream_response',
      'DashScope response did not contain an image',
      'api_error',
    );
  }
  return {
    status: 200,
    body: {
      created: Math.floor(Date.now() / 1_000),
      data: imageUrls.map((url) => ({ url })),
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: AdapterConfig,
): Promise<void> {
  const pathname = new URL(request.url ?? '/', 'http://adapter.local').pathname;
  if (request.method === 'GET' && pathname === '/health') {
    sendJson(response, 200, {
      status: 'ok',
      model: [...config.allowedModels][0] ?? DEFAULT_MODEL,
    });
    return;
  }

  const isGeneration = pathname === '/v1/images/generations';
  const isEdit = pathname === '/v1/images/edits';
  if (request.method !== 'POST' || (!isGeneration && !isEdit)) {
    throw new HttpError(404, 'not_found', 'Route not found');
  }

  requireAuthorization(request, config);
  const body = await readJson(request, config.maxBodyBytes);
  const wanBody = toWanRequest(body, isEdit, config.allowedModels);
  const result = await callDashScope(wanBody, config);
  sendJson(response, result.status, result.body);
}

export function createAdapterServer(config: AdapterConfig): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, config).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(response, error.status, errorBody(error));
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'internal_error',
          message: 'Internal server error',
          type: 'api_error',
        },
      });
    });
  });
}

function requiredEnv(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const dashscopeBaseUrl = requiredEnv(environment, 'DASHSCOPE_BASE_URL').replace(/\/+$/, '');
  const parsedBaseUrl = new URL(dashscopeBaseUrl);
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
    throw new Error('DASHSCOPE_BASE_URL must use http or https');
  }
  const allowedModels = new Set(
    (environment.ALLOWED_MODELS ?? DEFAULT_MODEL)
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean),
  );
  if (allowedModels.size === 0) {
    throw new Error('ALLOWED_MODELS must contain at least one model');
  }

  return {
    adapterApiKey: requiredEnv(environment, 'ADAPTER_API_KEY'),
    allowedModels,
    dashscopeApiKey: requiredEnv(environment, 'DASHSCOPE_API_KEY'),
    dashscopeBaseUrl,
    maxBodyBytes: positiveInteger(
      environment.MAX_BODY_BYTES,
      30 * 1024 * 1024,
      'MAX_BODY_BYTES',
    ),
    requestTimeoutMs: positiveInteger(
      environment.REQUEST_TIMEOUT_MS,
      180_000,
      'REQUEST_TIMEOUT_MS',
    ),
  };
}
