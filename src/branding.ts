import {
  mkdir,
  opendir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const RUNTIME_DIRECTORY = '_tiangong';
const RUNTIME_FILE = 'managed-branding.js';
const BRAND_FILE = 'brand.svg';
const RUNTIME_SCRIPT_TAG =
  '<script defer src="/_tiangong/managed-branding.js"></script>';
const SOURCE_MAP_COMMENT_PATTERNS = [
  /\/\/[#@]\s*sourceMappingURL=.*?(?:\r?\n|$)/g,
  /\/\*[#@]\s*sourceMappingURL=.*?\*\//gs,
] as const;
const JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.json',
  '.md',
  '.svg',
  '.txt',
  '.webmanifest',
  '.xml',
]);
const BRAND_REPLACEMENTS = [
  ['由 Nexu Labs 出品', '由天工出品'],
  ['Open Design Cloud', '天工云端'],
  ['Open Design', '天工'],
  ['Nexu Labs', '天工'],
  ['HyperFrames', '动效视频'],
  ['Claude Design', '传统设计工具'],
  ['Remotion', '视频渲染引擎'],
  ['Excalidraw', '白板引擎'],
  ['HeyGen', '数字人服务'],
  ['GSAP', '动效引擎'],
] as const;

export type BrandingConfig = {
  artifactRoots: string[];
  webRoot: string;
};

export type BrandingReport = {
  filesChanged: number;
  sourceMapsRemoved: number;
  textReplacements: number;
};

type TextRewrite = {
  replacements: number;
  text: string;
};

type SourceEdit = {
  end: number;
  start: number;
  text: string;
};

async function* filesUnder(root: string): AsyncGenerator<string> {
  const directory = await opendir(root);
  for await (const entry of directory) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* filesUnder(file);
    } else if (entry.isFile()) {
      yield file;
    }
  }
}

function replaceAll(
  source: string,
  search: string,
  replacement: string,
): TextRewrite {
  const occurrences = source.split(search).length - 1;
  if (occurrences === 0) {
    return { replacements: 0, text: source };
  }
  return {
    replacements: occurrences,
    text: source.replaceAll(search, replacement),
  };
}

function rewriteVisibleText(source: string): TextRewrite {
  let text = source;
  let replacements = 0;
  for (const [search, replacement] of BRAND_REPLACEMENTS) {
    const rewritten = replaceAll(text, search, replacement);
    text = rewritten.text;
    replacements += rewritten.replacements;
  }
  return { replacements, text };
}

function isModuleSpecifier(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return (
    (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node)
    || (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node)
    || (ts.isExternalModuleReference(parent) && parent.expression === node)
  );
}

function isUrlOrPath(value: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    || value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('@')
  );
}

function stripSourceMapComments(source: string): string {
  let text = source;
  for (const pattern of SOURCE_MAP_COMMENT_PATTERNS) {
    text = text.replace(pattern, '');
  }
  return text;
}

function rewriteJavaScript(source: string, file: string): TextRewrite {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const edits: SourceEdit[] = [];
  let replacements = 0;

  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && !isModuleSpecifier(node)
      && !isUrlOrPath(node.text)
    ) {
      const rewritten = rewriteVisibleText(node.text);
      if (rewritten.text !== node.text) {
        edits.push({
          start: node.getStart(sourceFile),
          end: node.end,
          text: JSON.stringify(rewritten.text),
        });
        replacements += rewritten.replacements;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let text = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
  }
  text = stripSourceMapComments(text);
  return { replacements, text };
}

function injectRuntime(html: string): string {
  const withBrandIcon = html.replaceAll('/app-icon.png', '/_tiangong/brand.svg');
  if (withBrandIcon.includes(RUNTIME_SCRIPT_TAG)) {
    return withBrandIcon;
  }
  if (withBrandIcon.includes('</body>')) {
    return withBrandIcon.replace('</body>', `${RUNTIME_SCRIPT_TAG}</body>`);
  }
  return `${withBrandIcon}${RUNTIME_SCRIPT_TAG}`;
}

function managedRuntimeSource(): string {
  return String.raw`(() => {
  'use strict';

  const textRules = [
    ['由 Nexu Labs 出品', '由天工出品'],
    ['Open Design Cloud', '天工云端'],
    ['Open Design', '天工'],
    ['Nexu Labs', '天工'],
    ['HyperFrames', '动效视频'],
    ['Claude Design', '传统设计工具'],
    ['Remotion', '视频渲染引擎'],
    ['Excalidraw', '白板引擎'],
    ['HeyGen', '数字人服务'],
    ['GSAP', '动效引擎'],
  ];
  const preservedProductTerms = [
    'Custom Image API',
    'Qwen Code',
    'qwen3-coder-plus',
    'wan2.7-image',
  ];
  const upstreamLinks = [
    'github.com/nexu-io/open-design',
    'discord.gg/',
    'x.com/OpenDesignHQ',
    'open-design.ai',
    'opendesign.ai',
    'threads.com/@opendesign.ai',
    'youtube.com/@Open-Design-ai',
    'linkedin.com/company/open-design-ai',
    'xiaohongshu.com/user/profile/691effad000000003002978f',
    'nexu.io',
  ];
  const hiddenSetupLabels = [
    'AIHubMix',
    'Claude Code',
    'Codex',
    'Codex Subscription',
    'Cursor',
    'ElevenLabs',
    'Fal.ai',
    'FishAudio',
    'Gemini CLI',
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
    'OpenCode',
    'Kiro',
    'Aider',
    'Vibe',
    'Trae CLI',
    'Qoder',
    'Grok Build',
    'DeepSeek',
    'Pi',
  ];
  const excludedContentSelector = [
    'script',
    'style',
    'textarea',
    'pre',
    'code',
    'iframe',
    '[contenteditable="true"]',
    '[data-tiangong-managed]',
  ].join(',');
  const managedPanelSelector = [
    '[role="dialog"]',
    '[class*="settings"]',
    '[class*="Settings"]',
    '[class*="onboarding"]',
    '[class*="Onboarding"]',
  ].join(',');

  const normalize = (value) => value.replace(/\s+/g, ' ').trim();

  const conceal = (element, reason) => {
    if (!(element instanceof HTMLElement)) return;
    const hasManagedDisplay = (
      element.style.getPropertyValue('display') === 'none'
      && element.style.getPropertyPriority('display') === 'important'
    );
    if (
      element.hidden
      && element.getAttribute('aria-hidden') === 'true'
      && element.dataset.tiangongManaged === reason
      && hasManagedDisplay
    ) return;
    element.hidden = true;
    element.setAttribute('aria-hidden', 'true');
    element.setAttribute('data-tiangong-managed', reason);
    element.style.setProperty('display', 'none', 'important');
  };

  const rewrite = (value) => {
    let next = value;
    for (const [source, target] of textRules) {
      next = next.split(source).join(target);
    }
    return next;
  };

  const isExcluded = (node) => {
    const parent = node.nodeType === Node.ELEMENT_NODE
      ? node
      : node.parentElement;
    return Boolean(parent && parent.closest(excludedContentSelector));
  };

  const rewriteTextNode = (node) => {
    if (isExcluded(node) || !node.nodeValue) return;
    const next = rewrite(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  };

  const rewriteAttributes = (element) => {
    if (isExcluded(element)) return;
    for (const attribute of ['aria-label', 'alt', 'placeholder', 'title']) {
      const current = element.getAttribute(attribute);
      if (!current) continue;
      const next = rewrite(current);
      if (next !== current) element.setAttribute(attribute, next);
    }
  };

  const hideUpstreamLink = (element) => {
    if (!(element instanceof HTMLAnchorElement)) return;
    const hrefCandidates = [element.href];
    for (let index = 0; index < 3; index += 1) {
      const current = hrefCandidates[hrefCandidates.length - 1];
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break;
        hrefCandidates.push(decoded);
      } catch {
        break;
      }
    }
    const normalizedHrefs = hrefCandidates.map((value) => value.toLowerCase());
    if (!upstreamLinks.some((value) =>
      normalizedHrefs.some((href) => href.includes(value.toLowerCase()))
    )) return;
    conceal(element, 'hidden-upstream-link');
  };

  const belongsToManagedPanel = (element) => {
    const panel = element.closest('[role="dialog"]')
      || element.closest(managedPanelSelector);
    if (!panel) return false;
    const panelText = normalize(panel.textContent || '');
    return /设置|Settings|连接|Connect|运行方式/.test(panelText);
  };

  const hideUnsupportedSetup = (element) => {
    if (!belongsToManagedPanel(element)) return;
    const text = normalize(element.textContent || '');
    if (!text || preservedProductTerms.some((value) => text.includes(value))) return;
    const hiddenLabel = hiddenSetupLabels.find(
      (label) => text === label || text.startsWith(label + ' '),
    );
    if (!hiddenLabel) return;
    const target = element.closest(
      '.media-provider-row,button,[role="option"],[role="menuitem"],li,label,article',
    ) || element;
    if (normalize(target.textContent || '').length > 400) return;
    conceal(target, 'hidden-provider');
  };

  const hideTechnicalDetail = (element) => {
    if (!belongsToManagedPanel(element)) return;
    const text = normalize(element.textContent || '');
    if (!/^(Version|Channel|Platform|Architecture|版本|渠道|平台|架构)(:|：|\s)/.test(text)) {
      return;
    }
    const target = element.closest('li,tr,dl,div') || element;
    if (normalize(target.textContent || '').length > 200) return;
    conceal(target, 'hidden-technical-detail');
  };

  const processElement = (element) => {
    rewriteAttributes(element);
    hideUpstreamLink(element);
    hideUnsupportedSetup(element);
    hideTechnicalDetail(element);
  };

  const processTree = (root) => {
    if (root.nodeType === Node.TEXT_NODE) {
      rewriteTextNode(root);
      return;
    }
    if (!(root instanceof Element || root instanceof Document)) return;
    if (root instanceof Element) processElement(root);
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) rewriteTextNode(node);
      else processElement(node);
      node = walker.nextNode();
    }
    document.title = rewrite(document.title);
    for (const icon of document.querySelectorAll('link[rel~="icon"]')) {
      icon.setAttribute('href', '/_tiangong/brand.svg');
    }
  };

  processTree(document);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') processTree(mutation.target);
      if (
        mutation.type === 'attributes'
        && mutation.target instanceof Element
      ) processElement(mutation.target);
      for (const node of mutation.addedNodes) processTree(node);
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      'alt',
      'aria-label',
      'hidden',
      'href',
      'placeholder',
      'style',
      'title',
    ],
    childList: true,
    characterData: true,
    subtree: true,
  });
})();`;
}

function brandSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="天工">
  <defs>
    <linearGradient id="g" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
      <stop stop-color="#d97a4f"/>
      <stop offset="1" stop-color="#a9472e"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="16" fill="#f4efe6"/>
  <path d="M16 18h32v7H36v23h-8V25H16z" fill="url(#g)"/>
  <path d="M18 34h28v7H18z" fill="#2b2522" opacity=".9"/>
</svg>
`;
}

async function assertWebRoot(webRoot: string): Promise<void> {
  const entry = path.join(webRoot, 'index.html');
  const entryStats = await stat(entry).catch(() => null);
  if (!entryStats?.isFile()) {
    throw new Error(`web entry file is missing: ${entry}`);
  }
}

async function writeManagedAssets(webRoot: string): Promise<void> {
  const directory = path.join(webRoot, RUNTIME_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, RUNTIME_FILE), managedRuntimeSource(), 'utf8'),
    writeFile(path.join(directory, BRAND_FILE), brandSvg(), 'utf8'),
  ]);
}

export async function patchBrandingArtifacts(
  config: BrandingConfig,
): Promise<BrandingReport> {
  await assertWebRoot(config.webRoot);

  const report: BrandingReport = {
    filesChanged: 0,
    sourceMapsRemoved: 0,
    textReplacements: 0,
  };

  for (const root of config.artifactRoots) {
    for await (const file of filesUnder(root)) {
      if (file.endsWith('.map')) {
        await rm(file);
        report.sourceMapsRemoved += 1;
        continue;
      }

      const extension = path.extname(file).toLowerCase();
      if (!JAVASCRIPT_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(extension)) {
        continue;
      }

      const current = await readFile(file, 'utf8');
      const rewritten = JAVASCRIPT_EXTENSIONS.has(extension)
        ? rewriteJavaScript(current, file)
        : rewriteVisibleText(stripSourceMapComments(current));
      const next = extension === '.html'
        ? injectRuntime(rewritten.text)
        : rewritten.text;
      if (next === current) {
        continue;
      }
      await writeFile(file, next, 'utf8');
      report.filesChanged += 1;
      report.textReplacements += rewritten.replacements;
    }
  }

  await writeManagedAssets(config.webRoot);
  return report;
}

async function main(): Promise<void> {
  const [webRoot, ...artifactRoots] = process.argv.slice(2);
  if (!webRoot) {
    throw new Error(
      'usage: branding.js <web-root> [artifact-root ...]',
    );
  }
  const roots = artifactRoots.length > 0 ? artifactRoots : [webRoot];
  const report = await patchBrandingArtifacts({
    artifactRoots: roots,
    webRoot,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tiangong branding failed: ${message}\n`);
    process.exitCode = 1;
  });
}
