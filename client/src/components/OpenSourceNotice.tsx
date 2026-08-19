import {
  LICENSE_NAME,
  LICENSE_URL,
  MODIFICATION_AUTHOR,
  SOURCE_REPOSITORY_URL,
  UPSTREAM_AUTHOR,
  UPSTREAM_REPOSITORY_URL,
} from '../shared/legal';

interface OpenSourceNoticeProps {
  variant?: 'login' | 'app';
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export default function OpenSourceNotice({ variant = 'app' }: OpenSourceNoticeProps) {
  return (
    <aside className={`open-source-notice is-${variant}`} aria-label="开源许可与源码">
      <span>
        <ExternalLink href={SOURCE_REPOSITORY_URL}>获取当前版本源码</ExternalLink>
        <span aria-hidden="true"> · </span>
        <ExternalLink href={LICENSE_URL}>{LICENSE_NAME}</ExternalLink>
      </span>
      <span>
        基于 <ExternalLink href={UPSTREAM_REPOSITORY_URL}>OpenBidKit_Yibiao</ExternalLink> 修改，
        原作者 {UPSTREAM_AUTHOR}，二开 {MODIFICATION_AUTHOR}。本软件不提供任何担保。
      </span>
    </aside>
  );
}
