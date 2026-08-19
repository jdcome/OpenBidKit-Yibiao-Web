export type SectionId =
  | 'dashboard'
  | 'project-summary'
  | 'bid-generation'
  | 'technical-plan'
  | 'existing-plan-expansion'
  | 'business-bid'
  | 'response-deviation-table'
  | 'knowledge-base'
  | 'document-knowledge-base'
  | 'tool-asset-library'
  | 'company-qualification-library'
  | 'personnel-qualification-library'
  | 'bid-check'
  | 'duplicate-check'
  | 'rejection-check'
  | 'template-settings'
  | 'my-templates'
  | 'new-template'
  | 'export-format'
  | 'developer-test'
  | 'developer-json-test'
  | 'developer-prompt-lab'
  | 'developer-parser-sandbox'
  | 'developer-export-preview'
  | 'developer-expansion-replace-test'
  | 'developer-opencode-agent-test'
  | 'settings'
  | 'docs'
  | 'docs-usage'
  | 'docs-config'
  | 'faq'
  | 'user-management'
  | 'prompt-management';

export interface AppMenuNotice {
  message: string;
  actionLabel?: string;
  externalUrl?: string;
}

export interface AppSubMenuItem {
  id: SectionId;
  label: string;
  description: string;
  icon?: 'document' | 'expand' | 'briefcase' | 'compare' | 'shield' | 'code' | 'prompt' | 'file' | 'export' | 'tool';
  notice?: AppMenuNotice;
}

export interface AppMenuItem {
  id: SectionId;
  label: string;
  description: string;
  children?: AppSubMenuItem[];
  notice?: AppMenuNotice;
}
