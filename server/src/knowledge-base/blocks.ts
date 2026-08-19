// 知识库文档分块器：逐字移植自 client/electron/services/knowledgeBaseService.cjs 的纯分块函数
// （is*Block 分类器 + createRawBlocks/mergeSemanticBlocks/filterBlocks + renderBlocksForPrompt）。
// 无 Electron 耦合，仅依赖 userTextSplitter 拆分超大块。LLM 抽取/匹配留 P6，不在本模块。
import { splitUserTextByContextLimit } from '../document/userTextSplitter';

const oversizedBlockChars = 8000;
const semanticMergeTargetChars = 500;

export interface KnowledgeBlock {
  id: string;
  type: string;
  heading_path?: string[];
  content: string;
  reason?: string;
}

export interface FilterBlocksResult {
  blocks: KnowledgeBlock[];
  filtered_blocks: KnowledgeBlock[];
}

export function getContentCharCount(text: unknown): number {
  return String(text || '').replace(/\s+/g, '').length;
}

function stripBoldMarker(text: unknown): string {
  return String(text || '').trim().replace(/^\*\*(.+)\*\*$/, '$1').trim();
}

export function stripMarkdownFence(content: unknown): string {
  return String(content || '').replace(/^```[\s\S]*?\n/, '').replace(/```$/g, '').trim();
}

function splitOversizedText(text: string, limit: number): string[] {
  return splitUserTextByContextLimit(String(text || ''), {}, {
    contextLengthLimit: limit,
    limitRatio: 1,
    maxSegmentLimitRatio: 1,
  }).map((part) => part.trim()).filter(Boolean);
}

function normalizeRepeatedText(text: unknown): string {
  return String(text || '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, '')
    .replace(/[\-—_·.。:：|第页共]/g, '')
    .trim()
    .toLowerCase();
}

function isPageNumberBlock(text: unknown): boolean {
  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  return /^[-—_]*\d+[-—_]*$/.test(compact)
    || /^第\d+页(共\d+页)?$/.test(compact)
    || /^\d+\/\d+$/.test(compact)
    || /^page\d+(of\d+)?$/i.test(compact);
}

function isCatalogBlock(text: unknown): boolean {
  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  if (/^(#+)?(目录|目次|contents)$/i.test(compact)) {
    return true;
  }

  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) {
    return false;
  }

  const catalogLines = lines.filter((line) => /(?:\.{2,}|…{2,}|·{2,}|\s{4,})\s*\d+\s*$/.test(line));
  return catalogLines.length >= Math.ceil(lines.length * 0.6);
}

function isCoverBlock(text: unknown, index: number): boolean {
  if (index > 12) {
    return false;
  }

  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  if (!compact || compact.length > 220) {
    return false;
  }

  const coverMarkers = ['投标文件', '投标书', '正本', '副本', '项目名称', '招标编号', '投标人', '编制日期', '日期：', '日期:'];
  const hasMarker = coverMarkers.some((marker) => compact.includes(marker));
  const hasLongSentence = /[。！？；]/.test(normalized) && normalized.length > 80;
  return hasMarker && !hasLongSentence;
}

function isSignatureBlock(text: unknown): boolean {
  const normalized = String(text || '').trim();
  const compact = normalized.replace(/\s+/g, '');
  if (!compact || compact.length > 260) {
    return false;
  }
  if (/(签字确认|用户签字|双方责任人.{0,12}签字)/.test(compact)) {
    return false;
  }
  return /(盖章|签章|签名|法定代表人|授权代表|委托代理人|被授权人|年月日|投标人代表签字|代表签字)/.test(compact)
    && !/[。！？；].{20,}/.test(compact);
}

function isTableBlock(block: KnowledgeBlock): boolean {
  return /^<table[\s>]/i.test(String(block?.content || '').trim());
}

function isSemanticHeadingBlock(block: KnowledgeBlock): boolean {
  const original = String(block?.content || '').trim();
  const normalized = stripBoldMarker(original);
  const compactLength = getContentCharCount(normalized);
  if (!normalized || compactLength > 100) {
    return false;
  }
  if (/[。！？；;]$/.test(normalized)) {
    return false;
  }

  return /^\*\*.+\*\*$/.test(original)
    || /^\d+(?:\.\d+)+\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^\d+\.\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^[一二三四五六七八九十]+[、.．]\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳][、.．]?\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^（[一二三四五六七八九十]+）\s*[^。！？；;]{1,80}$/.test(normalized)
    || /^第[一二三四五六七八九十\d]+[章节部分篇]\s*[^。！？；;]{0,80}$/.test(normalized);
}

export function mergeSemanticBlocks(rawBlocks: KnowledgeBlock[]): KnowledgeBlock[] {
  const merged: KnowledgeBlock[] = [];
  let buffer: KnowledgeBlock[] = [];

  const bufferText = () => buffer.map((block) => block.content).join('\n\n');
  const bufferHasOnlyHeadings = () => buffer.length > 0 && buffer.every(isSemanticHeadingBlock);
  const flushBuffer = () => {
    if (!buffer.length) {
      return;
    }
    merged.push({
      ...buffer[0],
      id: `R${String(merged.length + 1).padStart(6, '0')}`,
      type: buffer.some((block) => block.type === 'list') ? 'list' : 'paragraph',
      content: bufferText().trim(),
    });
    buffer = [];
  };
  const pushStandalone = (block: KnowledgeBlock) => {
    merged.push({
      ...block,
      id: `R${String(merged.length + 1).padStart(6, '0')}`,
    });
  };

  for (const block of rawBlocks) {
    if (isTableBlock(block)) {
      flushBuffer();
      pushStandalone(block);
      continue;
    }

    if (isSemanticHeadingBlock(block)) {
      if (buffer.length && !bufferHasOnlyHeadings() && getContentCharCount(bufferText()) >= 100) {
        flushBuffer();
      }
      buffer.push(block);
      continue;
    }

    const blockChars = getContentCharCount(block.content);
    if (!buffer.length && blockChars >= semanticMergeTargetChars) {
      pushStandalone(block);
      continue;
    }

    buffer.push(block);
    if (getContentCharCount(bufferText()) >= semanticMergeTargetChars) {
      flushBuffer();
    }
  }

  flushBuffer();
  return merged;
}

export function createRawBlocks(markdown: unknown): KnowledgeBlock[] {
  const blocks: KnowledgeBlock[] = [];
  const lines = String(markdown || '').split(/\r?\n/);
  let buffer: string[] = [];
  let currentType = 'paragraph';
  const headings: string[] = [];

  const pushBuffer = () => {
    const content = buffer.join('\n').trim();
    if (!content) {
      buffer = [];
      return;
    }

    const chunks = content.length > oversizedBlockChars ? splitOversizedText(content, Math.floor(oversizedBlockChars * 0.75)) : [content];
    for (const chunk of chunks) {
      blocks.push({
        id: `R${String(blocks.length + 1).padStart(6, '0')}`,
        type: currentType,
        heading_path: headings.filter(Boolean),
        content: chunk,
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      pushBuffer();
      const level = headingMatch[1].length;
      headings.splice(level - 1);
      headings[level - 1] = headingMatch[2].trim();
      currentType = 'heading';
      buffer = [line];
      pushBuffer();
      currentType = 'paragraph';
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      pushBuffer();
      currentType = 'paragraph';
      continue;
    }

    const nextType = /^\s*\|.*\|\s*$/.test(line)
      ? 'table'
      : /^\s*(?:[-*+]\s+|\d+[.)、]\s+)/.test(line)
        ? 'list'
        : 'paragraph';
    if (buffer.length && currentType !== nextType && (currentType !== 'paragraph' || nextType !== 'paragraph')) {
      pushBuffer();
    }
    currentType = nextType;
    buffer.push(line);
  }

  pushBuffer();
  return blocks;
}

export function filterBlocks(rawBlocks: KnowledgeBlock[]): FilterBlocksResult {
  const repeatedCounts = new Map<string, number>();
  rawBlocks.forEach((block) => {
    const key = normalizeRepeatedText(block.content);
    if (key && key.length <= 80) {
      repeatedCounts.set(key, (repeatedCounts.get(key) || 0) + 1);
    }
  });

  const kept: KnowledgeBlock[] = [];
  const filtered: KnowledgeBlock[] = [];

  rawBlocks.forEach((block, index) => {
    const repeatedKey = normalizeRepeatedText(block.content);
    const repeated = repeatedKey && repeatedKey.length <= 80 && (repeatedCounts.get(repeatedKey) || 0) >= 3;
    const reason = !String(block.content || '').trim()
      ? 'empty'
      : isPageNumberBlock(block.content)
        ? 'page_number'
        : getContentCharCount(block.content) < 100
          ? 'too_short'
          : isCatalogBlock(block.content)
            ? 'catalog'
            : repeated
              ? 'repeated_header_footer'
              : isCoverBlock(block.content, index)
                ? 'cover'
                : isSignatureBlock(block.content)
                  ? 'signature_page'
                  : '';

    if (reason) {
      filtered.push({ ...block, reason });
      return;
    }

    kept.push({
      ...block,
      id: `P${String(kept.length + 1).padStart(6, '0')}`,
    });
  });

  return { blocks: kept, filtered_blocks: filtered };
}

// P6 LLM 抽取/匹配用：把块渲染成 prompt 文本（逐字移植，供任务引擎复用）。
export function renderBlocksForPrompt(blocks: KnowledgeBlock[]): string {
  return blocks.map((block) => {
    const headingPath = block.heading_path?.length ? block.heading_path.join(' > ') : '无';
    return [
      `[${block.id}]`,
      `type: ${block.type}`,
      `heading_path: ${headingPath}`,
      'text:',
      block.content,
    ].join('\n');
  }).join('\n\n');
}
