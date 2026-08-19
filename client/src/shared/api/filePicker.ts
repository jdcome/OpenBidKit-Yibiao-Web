// Web 文件选择器：用隐藏 <input type="file"> 模拟桌面 dialog.showOpenDialog。
// bridge 的 importTenderDocument/importDocument 等"无参开对话框"方法在此底层拾取 File[]，
// 渲染器调用契约与桌面完全一致（零改动）。
//
// 取消检测：优先用现代浏览器的 input `cancel` 事件（未选即关闭时触发，与 change 无竞态），
// 修复旧 focus+setTimeout 启发式在双击确认时偶发的"已取消选择"误判。
// 仅在不支持 cancel 事件的古旧浏览器上回退到 focus 启发式。

export interface PickFilesOptions {
  accept?: string;
  multiple?: boolean;
}

export function pickFiles(options: PickFilesOptions = {}): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (options.accept) input.accept = options.accept;
    if (options.multiple) input.multiple = true;
    input.style.position = 'fixed';
    input.style.top = '-10000px';
    input.style.opacity = '0';

    let settled = false;
    const finish = (result: File[] | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onChange = () => {
      const list = Array.from(input.files || []);
      finish(list.length ? list : null);
    };
    const onCancel = () => finish(null);
    // 古旧浏览器兜底：无 cancel 事件时，用 focus+setTimeout 检测取消。
    const onFocus = () => {
      setTimeout(() => {
        if (!settled && (!input.files || !input.files.length)) finish(null);
      }, 300);
    };
    const cleanup = () => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      window.removeEventListener('focus', onFocus);
      input.remove();
    };

    input.addEventListener('change', onChange);
    if ('oncancel' in input) {
      input.addEventListener('cancel', onCancel);
    } else {
      window.addEventListener('focus', onFocus);
    }
    document.body.appendChild(input);
    input.click();
  });
}

// 与 server LOCAL_SUPPORTED_EXTENSIONS 对齐的 input.accept 串。
export const DOCUMENT_ACCEPT = '.txt,.md,.markdown,.docx,.pdf,.doc,.wps,.xls,.xlsx';

// 与桌面 fileService.cjs duplicateCheckSupportedExtensions 对齐（无 .txt）。
export const DUPLICATE_CHECK_ACCEPT = '.doc,.docx,.wps,.pdf,.md,.markdown,.xls,.xlsx';
