import type {
  ProjectTenderSourceSnapshot,
  ResponseDeviationAvailability,
  TenderBlock,
} from './types';
import { parseTenderBlocks } from './structure';

const TECHNICAL_FORM_RE = /^(?:采购需求响应(?:程度)?(?:表)?|技术(?:规格|条款|参数|服务)?(?:响应|偏离)(?:与偏离)?表|服务技术响应表|技术(?:规范书?|规格书|条款)(?:应答|响应)?(?:与?偏离|偏差)表|技术(?:规范书?|规格书)(?:应答|响应)表)$/i;
const COMBINED_FORM_RE = /^(?:技术\s*[\/、及与和]\s*商务.*(?:响应|偏离).*表|技术商务偏离表)$/i;
const BUSINESS_FORM_RE = /^商务(?:条款|规格)?(?:响应|偏离|偏差)(?:与偏离)?表$/i;
const SOURCE_CHAPTER_RE = /^(?:采购需求|服务需求|技术要求|用户需求书|项目需求|技术规格及要求|采购内容及技术要求|技术规范书|技术需求书|技术规范|技术标准和要求|技术标准与要求|技术规格书|服务方案要求|技术方案要求)$/;
const SOURCE_CHAPTER_KEYWORDS = ['采购需求', '服务需求', '技术要求', '用户需求书', '项目需求', '技术规格及要求', '采购内容及技术要求', '技术规范书', '技术需求书', '技术标准和要求', '技术标准与要求', '技术规格书', '服务方案要求', '技术方案要求'];
const TOP_LEVEL_TITLE_RE = /^第[一二三四五六七八九十百\d]+章\s*\S+/;
const SCORING_TABLE_RE = /(?:评审因素|评分因素|评审标准|评分标准|评分细则|分值|得分|扣分|满分)/;

function cleanTitle(text: string): string {
  return String(text || '').replace(/^#{1,6}\s+/, '').replace(/^\*\*|\*\*$/g, '').trim();
}

function semanticTitle(text: string): string {
  return cleanTitle(text)
    .replace(/^(?:附件\s*)?(?:第?[一二三四五六七八九十百千万\d]+章|[一二三四五六七八九十百千万\d]+)[、.．:\s-]*/u, '')
    .replace(/^[（(][一二三四五六七八九十百千万\d]+[)）][、.．:\s-]*/u, '')
    .trim();
}

function isShortTitleBlock(block: TenderBlock): boolean {
  return (block.type === 'heading' || block.type === 'paragraph' || block.type === 'list-item')
    && cleanTitle(block.text).length <= 80;
}

function isSourceChapterBlock(block: TenderBlock): boolean {
  const semantic = semanticTitle(block.text).replace(/（L\d+-L\d+）$/i, '').trim();
  if (SOURCE_CHAPTER_RE.test(semantic)) return true;
  return block.type === 'heading' && SOURCE_CHAPTER_KEYWORDS.some((keyword) => semantic.includes(keyword));
}

function emptyAvailability(
  source: ProjectTenderSourceSnapshot,
  reason: ResponseDeviationAvailability['reason'],
  kind: ResponseDeviationAvailability['kind'] = 'none',
): ResponseDeviationAvailability {
  return {
    available: false,
    reason,
    kind,
    templateTitle: '',
    sourceChapterTitle: '',
    sourceBlockIds: [],
    sourceText: '',
    confidence: 'high',
    tenderHash: source.tenderHash,
    selectedSectionId: source.selectedSectionId,
  };
}

function tableSemanticProfile(blocks: TenderBlock[], start: number): { score: number; valid: boolean; hasTable: boolean } {
  for (let index = start + 1; index < blocks.length && index <= start + 10; index += 1) {
    const block = blocks[index];
    if (block.type !== 'markdown-table' && block.type !== 'html-table') continue;
    const text = block.text;
    if (SCORING_TABLE_RE.test(text)) return { score: 0, valid: false, hasTable: true };
    const dimensions = [
      /(?:序号|编号)/,
      /(?:条目号|条款号|章节号|对应条款|文件条目号)/,
      /(?:(?:招标|磋商|比选|采购)文件(?:要求|对应的?内容|条款)|采购规格|商务条款|技术要求|技术规范书?条款|对应的?内容)/,
      /(?:(?:投标|响应|参选)文件|响应内容|应答内容|应答|响应)/,
      /(?:响应.{0,3}偏离|偏离情况|偏差|偏离说明|说明)/,
    ].filter((pattern) => pattern.test(text)).length;
    const coreDeviation = /(?:条目号|条款号|章节号)/.test(text)
      && /(?:(?:招标|磋商|比选|采购)文件|采购规格|商务条款|技术要求|技术规范书?)/.test(text)
      && /(?:偏离|偏差|说明)/.test(text);
    return { score: dimensions, valid: dimensions >= 4 || coreDeviation, hasTable: true };
  }
  return { score: 0, valid: false, hasTable: false };
}

function findTemplate(blocks: TenderBlock[]) {
  const candidates: Array<{ index: number; title: string; kind: 'combined' | 'technical'; score: number }> = [];
  for (let index = 0; index < blocks.length; index += 1) {
    if (!isShortTitleBlock(blocks[index])) continue;
    const title = cleanTitle(blocks[index].text);
    const semantic = semanticTitle(title);
    if (COMBINED_FORM_RE.test(semantic) || TECHNICAL_FORM_RE.test(semantic)) {
      const profile = tableSemanticProfile(blocks, index);
      if (!profile.valid) continue;
      candidates.push({
        index,
        title,
        kind: COMBINED_FORM_RE.test(semantic) ? 'combined' : 'technical',
        score: profile.score,
      });
    }
  }
  if (candidates.length) {
    return [...candidates].sort((a, b) => b.score - a.score || b.index - a.index)[0];
  }
  for (let index = 0; index < blocks.length; index += 1) {
    if (!isShortTitleBlock(blocks[index])) continue;
    const title = cleanTitle(blocks[index].text);
    if (BUSINESS_FORM_RE.test(semanticTitle(title))) return { index, title, kind: 'business-only' as const };
  }
  return null;
}

function selectedPackageRange(blocks: TenderBlock[], source: ProjectTenderSourceSnapshot): { start: number; end: number } | null {
  if (source.bidSectionMode !== 'multiple') return { start: 0, end: blocks.length };
  if (!source.selectedSectionId || (!source.selectedSectionHeadLine && !source.selectedSectionTitle)) return null;
  const targetLine = cleanTitle(source.selectedSectionHeadLine);
  const targetTitle = cleanTitle(source.selectedSectionTitle);
  const start = blocks.findIndex((block) => block.type === 'heading' && (
    cleanTitle(block.raw) === targetLine
    || cleanTitle(block.text) === targetTitle
    || cleanTitle(block.text).includes(targetTitle)
  ));
  if (start < 0) return null;
  const startLevel = blocks[start].level || 1;
  let end = blocks.length;
  for (let index = start + 1; index < blocks.length; index += 1) {
    if (blocks[index].type === 'heading' && blocks[index].level > 0 && blocks[index].level <= startLevel) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function findTechnicalSource(blocks: TenderBlock[], range: { start: number; end: number }, beforeIndex: number) {
  for (let index = Math.min(range.end, beforeIndex) - 1; index >= range.start; index -= 1) {
    const block = blocks[index];
    if (!isShortTitleBlock(block) || !isSourceChapterBlock(block)) continue;
    const level = block.level || 6;
    let end = range.end;
    for (let cursor = index + 1; cursor < range.end; cursor += 1) {
      const nextTitle = cleanTitle(blocks[cursor].text);
      const headingBoundary = block.type === 'heading' && blocks[cursor].type === 'heading' && blocks[cursor].level > 0 && blocks[cursor].level <= level;
      const pseudoBoundary = block.type !== 'heading' && isShortTitleBlock(blocks[cursor])
        && (TOP_LEVEL_TITLE_RE.test(nextTitle) || TECHNICAL_FORM_RE.test(semanticTitle(nextTitle)) || COMBINED_FORM_RE.test(semanticTitle(nextTitle)));
      if (headingBoundary || pseudoBoundary) {
        end = cursor;
        break;
      }
    }
    return { title: cleanTitle(block.text), blocks: blocks.slice(index, end) };
  }
  return null;
}

export function detectResponseDeviationAvailability(
  blocks: TenderBlock[],
  source: ProjectTenderSourceSnapshot,
): ResponseDeviationAvailability {
  if (!source.markdown.trim()) return emptyAvailability(source, 'no-tender');
  if (source.bidSectionMode === 'multiple' && !source.selectedSectionId) {
    return emptyAvailability(source, 'package-required');
  }

  const template = findTemplate(blocks);
  if (!template) return emptyAvailability(source, 'no-template');
  if (template.kind === 'business-only') return emptyAvailability(source, 'business-only', 'business-only');

  const packageRange = selectedPackageRange(blocks, source);
  const scopedBlocks = source.bidSectionMode === 'multiple' && source.selectedSectionMarkdown?.trim()
    ? parseTenderBlocks(source.selectedSectionMarkdown)
    : null;
  const sourceBlocks = scopedBlocks || blocks;
  const sourceRange = scopedBlocks ? { start: 0, end: scopedBlocks.length } : packageRange;
  if (!sourceRange) return emptyAvailability(source, 'package-required');
  const technicalSource = findTechnicalSource(sourceBlocks, sourceRange, scopedBlocks ? sourceBlocks.length : template.index);
  if (!technicalSource) return emptyAvailability(source, 'no-technical-source', template.kind);

  return {
    available: true,
    reason: 'available',
    kind: template.kind,
    templateTitle: template.title,
    sourceChapterTitle: technicalSource.title,
    sourceBlockIds: technicalSource.blocks.map((block) => block.id),
    sourceText: technicalSource.blocks.map((block) => block.raw).join('\n\n'),
    confidence: 'high',
    tenderHash: source.tenderHash,
    selectedSectionId: source.selectedSectionId,
  };
}
