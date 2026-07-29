import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_CONFIG_FILE = 'app-config.json';
const MEDIA_CONFIG_FILE = 'media-config.json';
const QWEN_SETTINGS_FILE = path.join('qwen-home', '.qwen', 'settings.json');
const QWEN_ENV_KEY = 'DASHSCOPE_API_KEY';

export type BootstrapConfig = {
  dataDir: string;
  imageAdapterBaseUrl: string;
  imageModel: string;
  qwenBaseUrl: string;
  qwenModel: string;
};

export type BootstrapResult = {
  changedFiles: string[];
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readObject(file: string, label: string): Promise<JsonObject> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) {
      throw new Error('root is not an object');
    }
    return parsed;
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
}

function serialized(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeObjectIfChanged(
  file: string,
  value: JsonObject,
): Promise<boolean> {
  const next = serialized(value);
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current === next) {
    await chmod(file, 0o600);
    return false;
  }

  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, next, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
  return true;
}

function qwenAgentConfig(current: JsonObject, qwenModel: string): JsonObject {
  const next: JsonObject = { ...current };
  if (!Object.hasOwn(current, 'agentId')) {
    next.agentId = 'qwen';
  }
  if (!Object.hasOwn(current, 'onboardingCompleted')) {
    next.onboardingCompleted = true;
  }

  const currentModels = isObject(current.agentModels)
    ? current.agentModels
    : {};
  const currentQwen = isObject(currentModels.qwen)
    ? currentModels.qwen
    : {};
  next.agentModels = {
    ...currentModels,
    qwen: {
      model: qwenModel,
      ...currentQwen,
    },
  };
  return next;
}

function mediaConfig(
  current: JsonObject,
  imageAdapterBaseUrl: string,
  imageModel: string,
): JsonObject {
  const currentProviders = isObject(current.providers)
    ? current.providers
    : {};
  const currentCustomImage = isObject(currentProviders['custom-image'])
    ? currentProviders['custom-image']
    : {};
  return {
    ...current,
    providers: {
      ...currentProviders,
      'custom-image': {
        ...currentCustomImage,
        baseUrl: imageAdapterBaseUrl,
        model: imageModel,
      },
    },
  };
}

function qwenSettings(
  current: JsonObject,
  qwenBaseUrl: string,
  qwenModel: string,
): JsonObject {
  const currentProviders = isObject(current.modelProviders)
    ? current.modelProviders
    : {};
  const currentOpenAi = Array.isArray(currentProviders.openai)
    ? currentProviders.openai.filter(isObject)
    : [];
  const provider = {
    id: qwenModel,
    name: qwenModel,
    baseUrl: qwenBaseUrl,
    envKey: QWEN_ENV_KEY,
  };
  const existingIndex = currentOpenAi.findIndex(
    (entry) => entry.id === qwenModel && entry.baseUrl === qwenBaseUrl,
  );
  const openai = [...currentOpenAi];
  if (existingIndex >= 0) {
    openai[existingIndex] = {
      ...openai[existingIndex],
      ...provider,
    };
  } else {
    openai.push(provider);
  }

  const currentSecurity = isObject(current.security) ? current.security : {};
  const currentAuth = isObject(currentSecurity.auth) ? currentSecurity.auth : {};
  const currentModel = isObject(current.model) ? current.model : {};
  return {
    ...current,
    modelProviders: {
      ...currentProviders,
      openai,
    },
    model: Object.hasOwn(currentModel, 'name')
      ? currentModel
      : { ...currentModel, name: qwenModel },
    security: {
      ...currentSecurity,
      auth: Object.hasOwn(currentAuth, 'selectedType')
        ? currentAuth
        : { ...currentAuth, selectedType: 'openai' },
    },
  };
}

export async function bootstrapTiangong(
  config: BootstrapConfig,
): Promise<BootstrapResult> {
  const appConfigPath = path.join(config.dataDir, APP_CONFIG_FILE);
  const mediaConfigPath = path.join(config.dataDir, MEDIA_CONFIG_FILE);
  const qwenSettingsPath = path.join(config.dataDir, QWEN_SETTINGS_FILE);

  const currentAppConfig = await readObject(appConfigPath, APP_CONFIG_FILE);
  const currentMediaConfig = await readObject(mediaConfigPath, MEDIA_CONFIG_FILE);
  const currentQwenSettings = await readObject(qwenSettingsPath, QWEN_SETTINGS_FILE);
  const changedFiles: string[] = [];

  const writes: Array<[string, JsonObject]> = [
    [appConfigPath, qwenAgentConfig(currentAppConfig, config.qwenModel)],
    [
      mediaConfigPath,
      mediaConfig(
        currentMediaConfig,
        config.imageAdapterBaseUrl,
        config.imageModel,
      ),
    ],
    [
      qwenSettingsPath,
      qwenSettings(currentQwenSettings, config.qwenBaseUrl, config.qwenModel),
    ],
  ];
  for (const [file, value] of writes) {
    if (await writeObjectIfChanged(file, value)) {
      changedFiles.push(path.relative(config.dataDir, file).split(path.sep).join('/'));
    }
  }
  return { changedFiles };
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback?: string,
): string {
  const value = environment[name]?.trim() || fallback;
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value.replace(/\/+$/, '');
}

export function bootstrapConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): BootstrapConfig {
  return {
    dataDir: requiredEnvironment(environment, 'TIANGONG_DATA_DIR'),
    imageAdapterBaseUrl: requiredEnvironment(
      environment,
      'TIANGONG_IMAGE_ADAPTER_BASE_URL',
      'http://wan-image-adapter:8080/v1',
    ),
    imageModel: requiredEnvironment(
      environment,
      'TIANGONG_IMAGE_MODEL',
      'wan2.7-image',
    ),
    qwenBaseUrl: requiredEnvironment(
      environment,
      'TIANGONG_QWEN_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    ),
    qwenModel: requiredEnvironment(
      environment,
      'TIANGONG_QWEN_MODEL',
      'qwen3-coder-plus',
    ),
  };
}

async function main(): Promise<void> {
  const config = bootstrapConfigFromEnvironment();
  const result = await bootstrapTiangong(config);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tiangong bootstrap failed: ${message}\n`);
    process.exitCode = 1;
  });
}
