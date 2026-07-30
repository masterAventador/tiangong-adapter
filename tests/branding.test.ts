import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Script } from 'node:vm';

import {
  patchBrandingArtifacts,
  type BrandingReport,
} from '../src/branding.js';

async function withTempArtifacts(
  callback: (root: string, webRoot: string, daemonRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tiangong-branding-'));
  const webRoot = path.join(root, 'apps', 'web', 'out');
  const daemonRoot = path.join(root, 'apps', 'daemon', 'dist');
  await mkdir(path.join(webRoot, '_next', 'static', 'chunks'), { recursive: true });
  await mkdir(daemonRoot, { recursive: true });
  try {
    await callback(root, webRoot, daemonRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function allFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test('构建时保留程序字符串、删除源码映射并注入安全的运行时白标', async () => {
  await withTempArtifacts(async (_root, webRoot, daemonRoot) => {
    const chunkFile = path.join(
      webRoot,
      '_next',
      'static',
      'chunks',
      'app.js',
    );
    await writeFile(
      path.join(webRoot, 'index.html'),
      [
        '<!doctype html><html><head><title>Open Design</title>',
        '<link rel="icon" href="/app-icon.png"></head><body>',
        '<h1>Open Design</h1>',
        '<p>由 Nexu Labs 出品</p>',
        '<button>HyperFrames</button>',
        '<p>Remotion · GSAP · Excalidraw · HeyGen</p>',
        '<span>Qwen Code</span><span>qwen3-coder-plus</span>',
        '<span>wan2.7-image</span>',
        '</body></html>',
      ].join(''),
    );
    await writeFile(
      chunkFile,
      [
        'const brand = "Open Design";',
        'const feature = "HyperFrames";',
        'const vendor = "Nexu Labs";',
        'const competitor = "Claude Design";',
        'const agent = "Qwen Code";',
        'const model = "qwen3-coder-plus";',
        'function isHyperFrames(value) { return value === "hyperframes-html"; }',
        'class OpenDesignHost {}',
        '//# sourceMappingURL=app.js.map',
      ].join('\n'),
    );
    await writeFile(`${chunkFile}.map`, '{"sourcesContent":["private source"]}');
    await writeFile(
      path.join(daemonRoot, 'cli.js'),
      'const title = "Open Design";\n//# sourceMappingURL=cli.js.map\n',
    );
    await writeFile(
      path.join(daemonRoot, 'cli.js.map'),
      '{"sourcesContent":["daemon private source"]}',
    );

    const report: BrandingReport = await patchBrandingArtifacts({
      artifactRoots: [webRoot, daemonRoot],
      webRoot,
    });

    const html = await readFile(path.join(webRoot, 'index.html'), 'utf8');
    assert.match(html, /<title>Open Design<\/title>/);
    assert.match(html, /href="\/_tiangong\/brand\.svg"/);
    assert.match(html, /<h1>Open Design<\/h1>/);
    assert.match(html, /由 Nexu Labs 出品/);
    assert.match(html, /<button>HyperFrames<\/button>/);
    assert.match(html, /Remotion · GSAP · Excalidraw · HeyGen/);
    assert.match(
      html,
      /<script defer src="\/_tiangong\/managed-branding\.js"><\/script>/,
    );
    assert.match(html, /Qwen Code/);
    assert.match(html, /qwen3-coder-plus/);
    assert.match(html, /wan2\.7-image/);

    const chunk = await readFile(chunkFile, 'utf8');
    assert.match(chunk, /const brand = "Open Design"/);
    assert.match(chunk, /const feature = "HyperFrames"/);
    assert.match(chunk, /const vendor = "Nexu Labs"/);
    assert.match(chunk, /const competitor = "Claude Design"/);
    assert.match(chunk, /const agent = "Qwen Code"/);
    assert.match(chunk, /const model = "qwen3-coder-plus"/);
    assert.match(chunk, /function isHyperFrames/);
    assert.match(chunk, /class OpenDesignHost/);
    assert.match(chunk, /"hyperframes-html"/);
    assert.doesNotMatch(chunk, /sourceMappingURL/);

    const files = [
      ...(await allFiles(webRoot)),
      ...(await allFiles(daemonRoot)),
    ];
    assert.equal(files.some((file) => file.endsWith('.map')), false);
    assert.equal(report.sourceMapsRemoved, 2);
    assert.equal(report.textReplacements, 0);

    const runtime = await readFile(
      path.join(webRoot, '_tiangong', 'managed-branding.js'),
      'utf8',
    );
    assert.doesNotThrow(() => new Script(runtime));
    assert.match(runtime, /github\.com\/nexu-io\/open-design/);
    assert.match(runtime, /decodeURIComponent/);
    assert.match(runtime, /attributes: true/);
    assert.match(
      runtime,
      /setProperty\('display', 'none', 'important'\)/,
    );
    assert.match(runtime, /discord\.gg/);
    assert.match(runtime, /AIHubMix/);
    assert.match(runtime, /Custom Image API/);
    assert.match(runtime, /\.media-provider-row/);
    assert.match(runtime, /Qwen Code/);
    assert.match(runtime, /qwen3-coder-plus/);
    assert.match(runtime, /wan2\.7-image/);
    assert.match(
      await readFile(path.join(webRoot, '_tiangong', 'brand.svg'), 'utf8'),
      /aria-label="天工"/,
    );
  });
});

test('补丁拒绝缺少网页入口的未知镜像结构', async () => {
  await withTempArtifacts(async (_root, webRoot, daemonRoot) => {
    await assert.rejects(
      patchBrandingArtifacts({
        artifactRoots: [webRoot, daemonRoot],
        webRoot,
      }),
      /web entry file is missing/i,
    );
  });
});
