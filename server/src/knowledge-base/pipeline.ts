// 知识库文档处理管线（P4 范围：copy_source → convert_markdown → build_blocks 三步）。
// 忠实移植自 client/electron/services/knowledgeBaseService.cjs 的 prepareDocument 前三步 +
// uploadDocuments 的文档创建逻辑，砍掉步骤 4-9（LLM 抽取/匹配，留 P6）。
//
// 关键差异：桌面 prepareDocument 是 fire-and-forget（异步，webContents 推 progress）；
// Web P4 在请求内同步跑完三步（无 SSE，P6 再接任务引擎），成功后落 status=awaiting_extraction
// （Web 专用 parked 态，桌面原 vocab 无——P6 任务引擎接管后推进到 extracting）。
//
// 步骤模型（knowledge_document_steps）保证幂等：retryDocument 重试时 stepCanReuse 跳过已完成步骤。
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createKnowledgeBasePaths } from '../document/paths';
import { parseDocument } from '../document/parser';
import {
  stripMarkdownFence,
  createRawBlocks,
  mergeSemanticBlocks,
  filterBlocks,
} from './blocks';
import type { KnowledgeBaseStore } from './store';

const kb = createKnowledgeBasePaths();

const KB_SUPPORTED_EXTENSIONS = new Set(['.doc', '.docx', '.wps', '.pdf', '.md', '.markdown', '.xls', '.xlsx']);

export function isKnowledgeBaseSupported(ext: string): boolean {
  return KB_SUPPORTED_EXTENSIONS.has(String(ext || '').toLowerCase());
}

export function createKnowledgeDocumentId(): string {
  return `doc-${crypto.randomUUID()}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function stepCanReuse(step: { status: string } | null, hasArtifact: boolean): boolean {
  return Boolean(hasArtifact && (!step || step.status === 'success'));
}

// uploadDocuments 的单文件创建逻辑（移植自桌面 1392-1419）。
// 计算相对 kbRoot 的 document_dir/source_path/markdown_path（forward slash），落 document 行，
// 并把上传字节写到 source_path（等价于桌面 copyFile 到 document_dir/source<ext>）。
export async function ingestUpload(
  store: KnowledgeBaseStore,
  folderId: string,
  fileName: string,
  ext: string,
  buffer: Buffer,
) {
  const documentId = createKnowledgeDocumentId();
  const norm = (v: string) => v.replace(/\\/g, '/');
  const documentDir = norm(path.join('folders', folderId, 'documents', documentId));
  const sourceName = `source${ext.toLowerCase()}`;
  const sourcePath = norm(path.join(documentDir, sourceName));
  const markdownPath = norm(path.join(documentDir, 'content.md'));

  const document = await store.createDocument({
    id: documentId,
    folder_id: folderId,
    file_name: fileName,
    document_dir: documentDir,
    source_path: sourcePath,
    markdown_path: markdownPath,
    source_extension: ext.toLowerCase(),
    status: 'pending',
    progress: 0,
    message: '等待处理',
  });

  await fs.mkdir(kb.resolve(documentDir), { recursive: true });
  await fs.writeFile(kb.resolve(sourcePath), buffer);

  return { document, sourcePath };
}

async function runStep(
  store: KnowledgeBaseStore,
  documentId: string,
  stepKey: string,
  worker: () => Promise<unknown>,
): Promise<unknown> {
  await store.saveDocumentStep(documentId, stepKey, { status: 'running' });
  try {
    const result = await worker();
    await store.saveDocumentStep(documentId, stepKey, { status: 'success', result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.saveDocumentStep(documentId, stepKey, { status: 'error', error: message });
    throw error;
  }
}

// prepareDocument 前三步（移植自桌面 796-892，砍掉 4-9）。
// 幂等：stepCanReuse 跳过已完成且产物存在的步骤；失败时落 status=error。
export async function prepareDocument(
  store: KnowledgeBaseStore,
  documentId: string,
): Promise<{ success: boolean; document: Awaited<ReturnType<KnowledgeBaseStore['getDocument']> > }> {
  try {
    const row = await store.getDocumentRow(documentId);
    const sourcePath = kb.resolve(row.sourcePath);
    const markdownPath = kb.resolve(row.markdownPath);

    let markdown = await store.readMarkdownByPath(row.markdownPath);

    // step 1: copy_source（ingestUpload 已落 source 字节，正常走 reuse 分支）
    const copyStep = await store.getDocumentStep(documentId, 'copy_source');
    if (stepCanReuse(copyStep, await pathExists(sourcePath))) {
      if (!copyStep) {
        await store.saveDocumentStep(documentId, 'copy_source', {
          status: 'success',
          result: { source_path: row.sourcePath },
        });
      }
    } else {
      await store.clearDocumentProcessingFromStep(documentId, 'copy_source');
      await store.updateDocument(documentId, {
        status: 'copying',
        progress: 5,
        message: '正在复制原始文件',
        error: null,
      });
      await runStep(store, documentId, 'copy_source', async () => {
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        return { source_path: row.sourcePath };
      });
    }

    // step 2: convert_markdown
    const convertStep = await store.getDocumentStep(documentId, 'convert_markdown');
    if (stepCanReuse(convertStep, Boolean(markdown))) {
      if (!convertStep) {
        await store.saveDocumentStep(documentId, 'convert_markdown', {
          status: 'success',
          result: { markdown_chars: markdown.length },
        });
      }
    } else {
      await store.clearDocumentProcessingFromStep(documentId, 'convert_markdown');
      await store.updateDocument(documentId, {
        status: 'converting',
        progress: 15,
        message: '正在转换为 Markdown',
        error: null,
      });
      await runStep(store, documentId, 'convert_markdown', async () => {
        const parsed = stripMarkdownFence((await parseDocument(sourcePath)).markdown.trim());
        if (!parsed) throw new Error('文档未解析出有效 Markdown 内容');
        await fs.writeFile(markdownPath, `${parsed}\n`, 'utf-8');
        await store.updateMarkdownMetadata(documentId, parsed);
        return { markdown_chars: parsed.length };
      });
      markdown = await store.readMarkdownByPath(row.markdownPath);
      if (!markdown) throw new Error('文档未解析出有效 Markdown 内容');
    }

    // step 3: build_blocks
    const blocks = await store.readBlocks(documentId);
    const filteredBlocks = await store.readFilteredBlocks(documentId);
    const blockStep = await store.getDocumentStep(documentId, 'build_blocks');
    if (stepCanReuse(blockStep, blocks.length > 0)) {
      if (!blockStep) {
        await store.saveDocumentStep(documentId, 'build_blocks', {
          status: 'success',
          result: { block_count: blocks.length, filtered_block_count: filteredBlocks.length },
        });
      }
    } else {
      await store.clearDocumentProcessingFromStep(documentId, 'build_blocks');
      await store.updateDocument(documentId, {
        progress: 40,
        message: '正在切分文档块',
        error: null,
      });
      await runStep(store, documentId, 'build_blocks', async () => {
        const rawBlocks = createRawBlocks(markdown);
        const semanticBlocks = mergeSemanticBlocks(rawBlocks);
        const filtered = filterBlocks(semanticBlocks);
        if (!filtered.blocks.length) throw new Error('筛选后没有可分析的正文内容');
        await store.saveBlocks(documentId, filtered.blocks, filtered.filtered_blocks);
        return { block_count: filtered.blocks.length, filtered_block_count: filtered.filtered_blocks.length };
      });
    }

    // P4 终态：三步完成，停在 awaiting_extraction 等 P6 LLM 抽取/匹配
    const document = await store.updateDocument(documentId, {
      status: 'awaiting_extraction',
      progress: 100,
      message: '已就绪，等待知识抽取（P6）',
      error: null,
    });
    return { success: true, document };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const document = await store.updateDocument(documentId, {
      status: 'error',
      progress: 100,
      message,
      error: message,
    });
    return { success: false, document };
  }
}

// retryDocument（移植自桌面 1426-1443）：仅 error 态可重试，重跑 prepareDocument。
export async function retryDocument(
  store: KnowledgeBaseStore,
  documentId: string,
): Promise<{ success: boolean; message: string; document: Awaited<ReturnType<KnowledgeBaseStore['getDocument']> > }> {
  const document = await store.getDocument(documentId);
  if (document.status !== 'error') {
    return { success: false, message: '只有解析失败的文档可以重试', document };
  }
  const row = await store.getDocumentRow(documentId);
  if (!(await pathExists(kb.resolve(row.sourcePath)))) {
    return { success: false, message: '原始文件不存在，请重新上传', document };
  }
  const result = await prepareDocument(store, documentId);
  return {
    success: result.success,
    message: result.success ? '已重新开始解析' : (result.document.message || '重试失败'),
    document: result.document,
  };
}
