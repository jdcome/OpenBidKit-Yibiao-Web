// 截图压缩：File → Image → Canvas 缩放 → JPEG data URL。
// 目的：控制存库体积（data-URL 入库，沿用 logoDataUrl 模式）。
export const MAX_FEEDBACK_IMAGES = 4;
const MAX_DIM = 1280;
const JPEG_QUALITY = 0.8;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解析失败'));
    };
    img.src = url;
  });
}

export async function compressImageFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('仅支持图片文件');
  }
  const img = await loadImage(file);
  const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = maxSide > MAX_DIM ? MAX_DIM / maxSide : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}
