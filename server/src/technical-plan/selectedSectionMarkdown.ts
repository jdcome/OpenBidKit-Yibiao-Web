export interface SelectedSectionRange {
  startLine: number;
  endLine: number;
  reason?: string;
}

export interface SelectedSectionLike {
  id?: string;
  title?: string;
  includeRanges?: SelectedSectionRange[];
}

export interface ScopedTenderMarkdownResult {
  markdown: string;
  applied: boolean;
  selectedSectionId?: string;
  selectedSectionTitle?: string;
  ranges: SelectedSectionRange[];
}

function normalizeRange(range: SelectedSectionRange, totalLines: number): SelectedSectionRange | null {
  const startLine = Math.floor(Number(range?.startLine || 0));
  const endLine = Math.floor(Number(range?.endLine || 0));
  if (
    !Number.isFinite(startLine)
    || !Number.isFinite(endLine)
    || startLine < 1
    || endLine < startLine
    || startLine > totalLines
  ) {
    return null;
  }
  return {
    startLine,
    endLine: Math.min(totalLines, endLine),
    reason: range.reason ? String(range.reason).trim() : undefined,
  };
}

function mergeRanges(ranges: SelectedSectionRange[]): SelectedSectionRange[] {
  const sorted = ranges.slice().sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const merged: SelectedSectionRange[] = [];
  for (const range of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && range.startLine <= prev.endLine + 1) {
      prev.endLine = Math.max(prev.endLine, range.endLine);
      prev.reason = [prev.reason, range.reason].filter(Boolean).join('、') || undefined;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function buildSelectedSectionMarkdown(markdown: string, section: SelectedSectionLike | null | undefined): string {
  const source = String(markdown || '');
  const lines = source.split(/\r?\n/);
  const ranges = mergeRanges(
    (section?.includeRanges || [])
      .map((range) => normalizeRange(range, lines.length))
      .filter((range): range is SelectedSectionRange => Boolean(range)),
  );
  if (!source.trim() || !section?.title || !ranges.length) {
    return source;
  }

  const chunks: string[] = [
    `# 当前投标范围：${section.title}`,
    '',
    `以下内容由系统根据已选择的投标范围「${section.title}」从招标文件中裁剪，仅用于本项目后续解析、目录生成与镜像章节。`,
  ];

  for (const range of ranges) {
    const title = range.reason || `${section.title}相关内容`;
    chunks.push('', `## ${title}（L${range.startLine}-L${range.endLine}）`, '');
    chunks.push(lines.slice(range.startLine - 1, range.endLine).join('\n').trim());
  }

  return chunks.filter((chunk) => chunk !== undefined).join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

export function buildScopedTenderMarkdown(
  markdown: string,
  plan: Record<string, unknown> | null | undefined,
): ScopedTenderMarkdownResult {
  const sections = Array.isArray(plan?.bidSections) ? plan.bidSections as Array<Record<string, unknown>> : [];
  const tenderFile = (plan?.tenderFile && typeof plan.tenderFile === 'object')
    ? plan.tenderFile as Record<string, unknown>
    : {};
  const selectedSectionId = String(tenderFile.selectedSectionId || '');
  if (plan?.bidSectionMode !== 'multiple' || !selectedSectionId || !sections.length) {
    return { markdown, applied: false, ranges: [] };
  }

  const selected = sections.find((section) => String(section.id || '') === selectedSectionId);
  if (!selected) {
    return { markdown, applied: false, selectedSectionId, ranges: [] };
  }
  const section: SelectedSectionLike = {
    id: String(selected.id || ''),
    title: String(selected.title || ''),
    includeRanges: Array.isArray(selected.includeRanges)
      ? selected.includeRanges.map((range) => range as SelectedSectionRange)
      : [],
  };
  const scoped = buildSelectedSectionMarkdown(markdown, section);
  const applied = scoped !== markdown;
  return {
    markdown: scoped,
    applied,
    selectedSectionId,
    selectedSectionTitle: section.title,
    ranges: section.includeRanges || [],
  };
}
