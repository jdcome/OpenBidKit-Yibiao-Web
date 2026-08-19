// Markdown → HTML 渲染（移植自 client/electron/utils/renderMarkdownHtml.cjs）。
// 纯函数：markdown-it + cjk-friendly + task-lists，无 electron 耦合。
// 渲染器实例按 (html 开关, gfm 开关) 缓存，避免每次导出重建。
import type MarkdownIt from 'markdown-it';

const rendererCache = new Map<string, MarkdownIt>();

let modulePromise: Promise<{
  MarkdownIt: typeof MarkdownIt;
  cjkFriendly: unknown;
  taskLists: unknown;
}> | null = null;

async function loadMarkdownModules() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const [markdownItModule, cjkFriendlyModule, taskListsModule] = await Promise.all([
        import('markdown-it'),
        import('markdown-it-cjk-friendly'),
        import('markdown-it-task-lists'),
      ]);
      return {
        MarkdownIt: (markdownItModule as { default: typeof MarkdownIt }).default || (markdownItModule as unknown as typeof MarkdownIt),
        cjkFriendly: (cjkFriendlyModule as { default: unknown }).default || cjkFriendlyModule,
        taskLists: (taskListsModule as { default: unknown }).default || taskListsModule,
      };
    })();
  }
  return modulePromise;
}

async function getMarkdownRenderer(options: { allowRawHtml?: boolean; enableGfm?: boolean } = {}): Promise<MarkdownIt> {
  const normalized = {
    allowRawHtml: options.allowRawHtml === true,
    enableGfm: options.enableGfm !== false,
  };
  const cacheKey = `${normalized.allowRawHtml ? 'html' : 'no-html'}:${normalized.enableGfm ? 'gfm' : 'commonmark'}`;
  const cached = rendererCache.get(cacheKey);
  if (cached) return cached;

  const { MarkdownIt, cjkFriendly, taskLists } = await loadMarkdownModules();
  const renderer = new MarkdownIt(normalized.enableGfm ? 'default' : 'commonmark', {
    html: normalized.allowRawHtml,
    linkify: false,
    typographer: false,
    breaks: false,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderer.use(cjkFriendly as any);
  if (normalized.enableGfm) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderer.use(taskLists as any, { enabled: true, label: true, labelAfter: true });
  }

  rendererCache.set(cacheKey, renderer);
  return renderer;
}

export async function renderMarkdownHtml(content: string, options: { allowRawHtml?: boolean; enableGfm?: boolean } = {}): Promise<string> {
  const renderer = await getMarkdownRenderer(options);
  return renderer.render(String(content || ''));
}
