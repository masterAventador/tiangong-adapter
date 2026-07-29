import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bootstrapTiangong,
  type BootstrapConfig,
} from '../src/bootstrap.js';

const QWEN_MODEL = 'qwen3-coder-plus';
const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const IMAGE_ADAPTER_BASE_URL = 'http://wan-image-adapter:8080/v1';
const IMAGE_MODEL = 'wan2.7-image';

async function withTempDataDir(
  callback: (dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tiangong-bootstrap-'));
  try {
    await callback(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function configFor(dataDir: string): BootstrapConfig {
  return {
    dataDir,
    imageAdapterBaseUrl: IMAGE_ADAPTER_BASE_URL,
    imageModel: IMAGE_MODEL,
    qwenBaseUrl: QWEN_BASE_URL,
    qwenModel: QWEN_MODEL,
  };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

test('首次启动时预置 Qwen 代理、Custom Image 和 Qwen Code 配置', async () => {
  await withTempDataDir(async (dataDir) => {
    const result = await bootstrapTiangong(configFor(dataDir));

    assert.deepEqual(result.changedFiles.sort(), [
      'app-config.json',
      'media-config.json',
      'qwen-home/.qwen/settings.json',
    ]);

    const appConfig = await readJson(path.join(dataDir, 'app-config.json'));
    assert.deepEqual(appConfig, {
      agentId: 'qwen',
      agentModels: {
        qwen: { model: QWEN_MODEL },
      },
      onboardingCompleted: true,
    });

    const mediaConfig = await readJson(path.join(dataDir, 'media-config.json'));
    assert.deepEqual(mediaConfig, {
      providers: {
        'custom-image': {
          baseUrl: IMAGE_ADAPTER_BASE_URL,
          model: IMAGE_MODEL,
        },
      },
    });

    const qwenSettingsPath = path.join(
      dataDir,
      'qwen-home',
      '.qwen',
      'settings.json',
    );
    const qwenSettings = await readJson(qwenSettingsPath);
    assert.deepEqual(qwenSettings, {
      modelProviders: {
        openai: [{
          baseUrl: QWEN_BASE_URL,
          envKey: 'DASHSCOPE_API_KEY',
          id: QWEN_MODEL,
          name: QWEN_MODEL,
        }],
      },
      model: { name: QWEN_MODEL },
      security: {
        auth: { selectedType: 'openai' },
      },
    });

    for (const file of [
      path.join(dataDir, 'app-config.json'),
      path.join(dataDir, 'media-config.json'),
      qwenSettingsPath,
    ]) {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  });
});

test('重复启动只补缺失项，不覆盖用户已有选择和其他提供商', async () => {
  await withTempDataDir(async (dataDir) => {
    await mkdir(path.join(dataDir, 'qwen-home', '.qwen'), { recursive: true });
    await writeFile(
      path.join(dataDir, 'app-config.json'),
      JSON.stringify({
        agentId: 'codex',
        agentModels: { codex: { model: 'gpt-5' } },
        customInstructions: '保留这段配置',
      }),
    );
    await writeFile(
      path.join(dataDir, 'media-config.json'),
      JSON.stringify({
        aliases: { logo: 'existing-model' },
        providers: {
          openai: { apiKey: 'existing-openai-key' },
          'custom-image': { apiKey: 'existing-adapter-key' },
        },
      }),
    );
    await writeFile(
      path.join(dataDir, 'qwen-home', '.qwen', 'settings.json'),
      JSON.stringify({
        model: { name: 'another-model' },
        modelProviders: {
          openai: [{
            id: 'another-model',
            name: 'another-model',
            envKey: 'ANOTHER_KEY',
            baseUrl: 'https://example.invalid/v1',
          }],
        },
        security: { auth: { selectedType: 'openai' } },
      }),
    );

    await bootstrapTiangong(configFor(dataDir));

    const appConfig = await readJson(path.join(dataDir, 'app-config.json'));
    assert.equal(appConfig.agentId, 'codex');
    assert.equal(appConfig.customInstructions, '保留这段配置');
    assert.deepEqual(appConfig.agentModels, {
      codex: { model: 'gpt-5' },
      qwen: { model: QWEN_MODEL },
    });

    const mediaConfig = await readJson(path.join(dataDir, 'media-config.json'));
    assert.deepEqual(mediaConfig, {
      aliases: { logo: 'existing-model' },
      providers: {
        openai: { apiKey: 'existing-openai-key' },
        'custom-image': {
          apiKey: 'existing-adapter-key',
          baseUrl: IMAGE_ADAPTER_BASE_URL,
          model: IMAGE_MODEL,
        },
      },
    });

    const qwenSettings = await readJson(
      path.join(dataDir, 'qwen-home', '.qwen', 'settings.json'),
    );
    assert.deepEqual(qwenSettings.model, { name: 'another-model' });
    assert.deepEqual(qwenSettings.modelProviders, {
      openai: [
        {
          baseUrl: 'https://example.invalid/v1',
          envKey: 'ANOTHER_KEY',
          id: 'another-model',
          name: 'another-model',
        },
        {
          baseUrl: QWEN_BASE_URL,
          envKey: 'DASHSCOPE_API_KEY',
          id: QWEN_MODEL,
          name: QWEN_MODEL,
        },
      ],
    });
  });
});

test('遇到损坏的既有配置时停止，不覆盖原文件', async () => {
  await withTempDataDir(async (dataDir) => {
    const appConfigPath = path.join(dataDir, 'app-config.json');
    await writeFile(appConfigPath, '{broken');

    await assert.rejects(
      () => bootstrapTiangong(configFor(dataDir)),
      /app-config\.json contains invalid JSON/,
    );
    assert.equal(await readFile(appConfigPath, 'utf8'), '{broken');
  });
});
