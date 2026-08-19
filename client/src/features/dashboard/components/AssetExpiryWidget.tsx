// 仪表盘：资质到期聚合卡片。跨公司/工具库（资产级）+ 人员库（证书级）列出最近到期/已过期项。
// 两源归一为 {label, sub, section, daysUntil}，按 daysUntil 排序取前 6。行可点击跳转到对应库。
import {
  useExpiringAssets,
  type AssetLibraryId,
  type AssetExpiringItem,
} from '../../asset-library/api/assetLibrary';
import { useExpiringPersonnel } from '../../personnel/api/personnel';
import type { SectionId } from '../../../shared/types/navigation';

interface AssetExpiryWidgetProps {
  onSectionChange: (section: SectionId) => void;
}

const LIBRARY_LABEL: Record<AssetLibraryId, string> = {
  tool: '工具模板库',
  company: '公司资质库',
  personnel: '人员资质库',
};

const LIBRARY_SECTION: Record<AssetLibraryId, SectionId> = {
  tool: 'tool-asset-library',
  company: 'company-qualification-library',
  personnel: 'personnel-qualification-library',
};

interface NormalizedItem {
  key: string;
  label: string;
  sub: string;
  section: SectionId;
  daysUntil: number;
}

function AssetExpiryWidget({ onSectionChange }: AssetExpiryWidgetProps) {
  const { data: assetData, isLoading: assetLoading } = useExpiringAssets(30);
  const { data: personnelData, isLoading: personnelLoading } = useExpiringPersonnel(30);

  const assetItems: NormalizedItem[] = (assetData ?? []).map((item: AssetExpiringItem) => {
    const lib = item.library as AssetLibraryId;
    return {
      key: `asset-${item.library}-${item.id}`,
      label: item.name,
      sub: LIBRARY_LABEL[lib],
      section: LIBRARY_SECTION[lib],
      daysUntil: item.daysUntil,
    };
  });

  const personnelItems: NormalizedItem[] = (personnelData ?? []).map((item) => ({
    key: `personnel-${item.certId}`,
    label: `${item.profileName} · ${item.certName}`,
    sub: '人员资质库',
    section: 'personnel-qualification-library',
    daysUntil: item.daysUntil,
  }));

  const merged = [...assetItems, ...personnelItems].sort((a, b) => a.daysUntil - b.daysUntil);
  const items = merged.slice(0, 6);
  const isLoading = assetLoading || personnelLoading;
  if (!isLoading && items.length === 0) return null;

  const expiredCount = merged.filter((i) => i.daysUntil < 0).length;
  const expiringCount = merged.length - expiredCount;

  return (
    <section className="asset-expiry-widget">
      <header className="asset-expiry-head">
        <h3>资质到期提醒</h3>
        <span className="asset-expiry-summary">
          {expiringCount > 0 && <span className="asset-expiry-chip is-expiring">临期 {expiringCount}</span>}
          {expiredCount > 0 && <span className="asset-expiry-chip is-expired">已过期 {expiredCount}</span>}
          {expiringCount === 0 && expiredCount === 0 && <span className="asset-expiry-chip is-ok">暂无临期</span>}
        </span>
      </header>
      <ul className="asset-expiry-list">
        {items.map((item) => {
          const tone = item.daysUntil < 0 ? 'is-expired' : 'is-expiring';
          const text = item.daysUntil < 0
            ? `已过期 ${Math.abs(item.daysUntil)} 天`
            : item.daysUntil === 0
              ? '今日到期'
              : `${item.daysUntil} 天后到期`;
          return (
            <li key={item.key}>
              <button type="button" className="asset-expiry-row" onClick={() => onSectionChange(item.section)}>
                <span className="asset-expiry-name" title={item.label}>{item.label}</span>
                <span className="asset-expiry-lib">{item.sub}</span>
                <span className={`asset-expiry-badge ${tone}`}>{text}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default AssetExpiryWidget;
