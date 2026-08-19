import type { ReactNode } from 'react';
import { AiHttpErrorDialogProvider, DocumentParseNoticeProvider, ToastProvider } from '../../shared/ui';
import { ProjectProvider } from '../ProjectContext';

interface AppProvidersProps {
  children: ReactNode;
}

function AppProviders({ children }: AppProvidersProps) {
  return (
    <ToastProvider>
      <AiHttpErrorDialogProvider>
        <DocumentParseNoticeProvider>
          <ProjectProvider>{children}</ProjectProvider>
        </DocumentParseNoticeProvider>
      </AiHttpErrorDialogProvider>
    </ToastProvider>
  );
}

export default AppProviders;
