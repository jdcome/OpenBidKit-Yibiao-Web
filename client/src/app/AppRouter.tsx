import { useEffect, useState } from 'react';
import type { SectionId } from '../shared/types/navigation';
import { getAppMenuItemById } from './menuConfig';
import { canAccessSection } from '../shared/permissions';
import { useAuth } from '../shared/api/auth';
import DashboardPage from '../features/dashboard/pages/DashboardPage';
import ProjectSummaryPage from '../features/dashboard/pages/ProjectSummaryPage';
import UserManagementPage from '../features/user-management/pages/UserManagementPage';
import PromptManagementPage from '../features/prompt-management/pages/PromptManagementPage';
import BusinessBidPage from '../features/business-bid/pages/BusinessBidPage';
import ContentExpansionReplaceTestPage from '../features/developer/pages/ContentExpansionReplaceTestPage';
import DeveloperDemoPage, { isDeveloperDemoSection } from '../features/developer/pages/DeveloperDemoPage';
import OpenCodeAgentTestPage from '../features/developer/pages/OpenCodeAgentTestPage';
import DeveloperTestPage from '../features/developer/pages/DeveloperTestPage';
import ExportFormatPage from '../features/export-format/pages/ExportFormatPage';
import MyTemplatesPage from '../features/export-format/pages/MyTemplatesPage';
import DuplicateCheckPage from '../features/duplicate-check/pages/DuplicateCheckPage';
import KnowledgeBasePage from '../features/knowledge-base/pages/KnowledgeBasePage';
import AssetLibraryPage from '../features/asset-library/pages/AssetLibraryPage';
import PersonnelLibraryPage from '../features/personnel/pages/PersonnelLibraryPage';
import RejectionCheckPage from '../features/rejection-check/pages/RejectionCheckPage';
import ResourcesPage from '../features/resources/pages/ResourcesPage';
import SettingsPage from '../features/settings/pages/SettingsPage';
import DocsPage from '../features/docs/pages/DocsPage';
import FaqPage from '../features/feedback/pages/FaqPage';
import TechnicalPlanHome from '../features/technical-plan/pages/TechnicalPlanHome';
import SecondaryMenuPage from '../shared/ui/SecondaryMenuPage';
import ResponseDeviationWorkbenchPage from '../features/response-deviation/pages/ResponseDeviationWorkbenchPage';

interface AppRouterProps {
  activeSection: SectionId;
  developerMode: boolean;
  onDeveloperModeChange: (developerMode: boolean) => void;
  onSectionChange: (section: SectionId) => void;
  registerLeaveGuard?: (guard: ((nextSection?: string) => Promise<boolean>) | null) => void;
}

function AppRouter({ activeSection, developerMode, onDeveloperModeChange, onSectionChange, registerLeaveGuard }: AppRouterProps) {
  const { user } = useAuth();
  const activeMenuItem = getAppMenuItemById(activeSection, developerMode);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);

  useEffect(() => {
    if (activeSection !== 'my-templates') {
      setEditingTemplateId(null);
    }
  }, [activeSection]);

  // 可访问性回退：当前 section 无权访问时回到仪表盘（处理直链/权限被改后落地）。
  useEffect(() => {
    if (activeSection !== 'dashboard' && !canAccessSection(user?.role, user?.modules, activeSection)) {
      onSectionChange('dashboard');
    }
  }, [activeSection, user?.role, user?.modules, onSectionChange]);

  if (activeMenuItem?.children?.length) {
    return <SecondaryMenuPage menuItem={activeMenuItem} onNavigate={onSectionChange} />;
  }

  if (isDeveloperDemoSection(activeSection)) {
    return <DeveloperDemoPage sectionId={activeSection} />;
  }

  switch (activeSection) {
    case 'dashboard':
      return <DashboardPage onSectionChange={onSectionChange} />;
    case 'project-summary':
      return <ProjectSummaryPage onSectionChange={onSectionChange} />;
    case 'user-management':
      return <UserManagementPage />;
    case 'prompt-management':
      return <PromptManagementPage />;
    case 'technical-plan':
      return <TechnicalPlanHome workflowKind="technical-plan" registerLeaveGuard={registerLeaveGuard} onSectionChange={onSectionChange} />;
    case 'existing-plan-expansion':
      return <TechnicalPlanHome workflowKind="existing-plan-expansion" registerLeaveGuard={registerLeaveGuard} onSectionChange={onSectionChange} />;
    case 'business-bid':
      return <BusinessBidPage />;
    case 'response-deviation-table':
      return <ResponseDeviationWorkbenchPage />;
    case 'document-knowledge-base':
      return <KnowledgeBasePage />;
    case 'tool-asset-library':
      return <AssetLibraryPage library="tool" />;
    case 'company-qualification-library':
      return <AssetLibraryPage library="company" />;
    case 'personnel-qualification-library':
      return <PersonnelLibraryPage />;
    case 'resources':
      return <ResourcesPage />;
    case 'duplicate-check':
      return <DuplicateCheckPage />;
    case 'rejection-check':
      return <RejectionCheckPage />;
    case 'my-templates':
      return editingTemplateId
        ? <ExportFormatPage mode="edit" templateId={editingTemplateId} onBack={() => setEditingTemplateId(null)} />
        : <MyTemplatesPage onCreateTemplate={() => onSectionChange('new-template')} onEditTemplate={setEditingTemplateId} />;
    case 'new-template':
      return <ExportFormatPage mode="create" />;
    case 'export-format':
      return <ExportFormatPage mode="create" />;
    case 'developer-test':
      return null;
    case 'developer-json-test':
      return <DeveloperTestPage />;
    case 'developer-expansion-replace-test':
      return <ContentExpansionReplaceTestPage />;
    case 'developer-opencode-agent-test':
      return <OpenCodeAgentTestPage />;
    case 'settings':
      return <SettingsPage onDeveloperModeChange={onDeveloperModeChange} />;
    case 'docs-usage':
      return <DocsPage section="usage" />;
    case 'docs-config':
      return <DocsPage section="config" />;
    case 'faq':
      return <FaqPage />;
    default:
      return null;
  }
}

export default AppRouter;
