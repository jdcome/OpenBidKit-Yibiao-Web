// 共享文件上传区：<label> 原生激活 + 拖拽。
// 关键设计：用 <label> 包裹 <input type=file>，靠浏览器原生 label→input 激活打开选择器，
// 而非 inputRef.click() 的 JS 手势链。原因：在 Radix 嵌套 Dialog 的焦点陷阱内，
// JS 触发的 input.click() 有概率与焦点管理竞态，导致原生选择器一开即关
// （表现为点击上传区“无响应”）。原生 label 激活不经 JS 手势链，对焦点陷阱免疫。
// 单一激活路径：input 为 sr-only 且 pointer-events:none，不会与 label 原生行为二次叠加。
// 被 AssetItemEditor 与 PersonnelCertificateEditor 复用。
import { useRef, useState } from 'react';

interface FileDropFieldProps {
  accept?: string;
  onPick: (files: FileList | null) => void;
  hint?: string;
  className?: string;
}

function FileDropField({
  accept,
  onPick,
  hint = '点击或拖拽上传图片 / PDF / 文档',
  className,
}: FileDropFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <label
      className={`asset-file-drop${dragOver ? ' is-dragover' : ''}${className ? ` ${className}` : ''}`}
      tabIndex={0}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onPick(e.dataTransfer.files);
      }}
      onKeyDown={(e) => {
        // 键盘激活：label 原生仅在鼠标点击时激活 input；Enter/Space 需显式触发（keydown 仍是有效用户手势）。
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
    >
      <span className="asset-file-drop-hint">{hint}</span>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        onChange={(e) => {
          onPick(e.target.files);
          e.target.value = '';
        }}
        className="asset-file-input"
        aria-hidden="true"
        tabIndex={-1}
      />
    </label>
  );
}

export default FileDropField;
