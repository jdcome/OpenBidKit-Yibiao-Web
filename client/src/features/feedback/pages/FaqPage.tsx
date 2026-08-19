import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../../shared/ui';
import { useAuth } from '../../../shared/api/auth';
import { compressImageFile, MAX_FEEDBACK_IMAGES } from '../compressImage';
import {
  createFeedback,
  fetchFeedback,
  fetchFeedbacks,
  replyFeedback,
  updateFeedbackStatus,
  type FeedbackListItem,
} from '../api/feedback';

const STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  resolved: '已解决',
  closed: '已关闭',
};

const STATUS_CLASS: Record<string, string> = {
  open: 'is-open',
  resolved: 'is-resolved',
  closed: 'is-closed',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function handleImageFiles(
  files: FileList | null,
  images: string[],
  setImages: (updater: (prev: string[]) => string[]) => void,
  showToast: (msg: string, kind?: 'info' | 'error' | 'success') => void,
): Promise<void> {
  if (!files || files.length === 0) return;
  const slots = MAX_FEEDBACK_IMAGES - images.length;
  if (slots <= 0) {
    showToast(`最多 ${MAX_FEEDBACK_IMAGES} 张截图`, 'info');
    return;
  }
  const picked = Array.from(files).slice(0, slots);
  try {
    const compressed = await Promise.all(picked.map(compressImageFile));
    setImages((prev) => [...prev, ...compressed]);
  } catch (err: unknown) {
    showToast(`图片处理失败：${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

function FeedbackForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [content, setContent] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = content.trim();
    if (!trimmed) {
      showToast('请填写问题描述', 'info');
      return;
    }
    setBusy(true);
    try {
      await createFeedback(trimmed, images);
      await qc.invalidateQueries({ queryKey: ['feedbacks'] });
      showToast('问题已提交', 'success');
      onDone();
    } catch (err: unknown) {
      showToast(`提交失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="feedback-form">
      <h3 className="feedback-form-title">提交问题</h3>
      <textarea
        className="feedback-textarea"
        placeholder="请描述遇到的问题（必填）"
        rows={6}
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="feedback-images">
        {images.map((src, idx) => (
          <div key={idx} className="feedback-image-thumb">
            <img src={src} alt={`截图${idx + 1}`} />
            <button
              type="button"
              className="feedback-image-remove"
              onClick={() => setImages((prev) => prev.filter((_, i) => i !== idx))}
              aria-label="移除截图"
            >
              ×
            </button>
          </div>
        ))}
        {images.length < MAX_FEEDBACK_IMAGES && (
          <label className="feedback-image-add">
            <span>＋</span>
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                void handleImageFiles(e.target.files, images, setImages, showToast);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>
      <div className="feedback-form-actions">
        <button type="button" className="secondary-action" onClick={onDone} disabled={busy}>
          取消
        </button>
        <button type="button" className="primary-action" onClick={() => void submit()} disabled={busy}>
          {busy ? '提交中…' : '提交'}
        </button>
      </div>
    </div>
  );
}

function FeedbackDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [reply, setReply] = useState('');
  const [replyImages, setReplyImages] = useState<string[]>([]);
  const [replyBusy, setReplyBusy] = useState(false);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['feedback', id],
    queryFn: () => fetchFeedback(id),
  });

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ['feedback', id] });
    await qc.invalidateQueries({ queryKey: ['feedbacks'] });
  };

  const submitReply = async () => {
    const trimmed = reply.trim();
    if (!trimmed) {
      showToast('请填写回复内容', 'info');
      return;
    }
    setReplyBusy(true);
    try {
      await replyFeedback(id, trimmed, replyImages);
      setReply('');
      setReplyImages([]);
      await invalidate();
      showToast('回复已发送', 'success');
    } catch (err: unknown) {
      showToast(`回复失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setReplyBusy(false);
    }
  };

  const changeStatus = async (status: string) => {
    try {
      await updateFeedbackStatus(id, status);
      await invalidate();
      showToast('状态已更新', 'success');
    } catch (err: unknown) {
      showToast(`更新失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  if (isLoading || !data) return <div className="feedback-detail feedback-detail--loading">加载中…</div>;

  return (
    <div className="feedback-detail">
      <button type="button" className="feedback-back secondary-action" onClick={onBack}>
        ← 返回列表
      </button>

      <div className="feedback-detail-card">
        <div className="feedback-detail-head">
          <span className={`feedback-status ${STATUS_CLASS[data.status] || ''}`}>
            {STATUS_LABEL[data.status] || data.status}
          </span>
          {isAdmin && (
            <select
              className="feedback-status-select"
              value={data.status}
              onChange={(e) => void changeStatus(e.target.value)}
            >
              <option value="open">待处理</option>
              <option value="resolved">已解决</option>
              <option value="closed">已关闭</option>
            </select>
          )}
        </div>
        <div className="feedback-detail-meta">
          <strong>{data.displayName}</strong>
          <time>{formatTime(data.createdAt)}</time>
        </div>
        <p className="feedback-detail-content">{data.content}</p>
        {data.images.length > 0 && (
          <div className="feedback-detail-images">
            {data.images.map((src, idx) => (
              <button key={idx} type="button" className="feedback-image-view" onClick={() => setPreviewSrc(src)} aria-label={`查看截图 ${idx + 1}`}>
                <img src={src} alt={`截图${idx + 1}`} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="feedback-replies">
        {data.replies.map((rp) => (
          <div key={rp.id} className={`feedback-reply ${rp.isAdmin ? 'is-admin' : ''}`}>
            <div className="feedback-reply-head">
              <strong>{rp.displayName}</strong>
              {rp.isAdmin && <span className="feedback-admin-tag">管理员</span>}
              <time>{formatTime(rp.createdAt)}</time>
            </div>
            <p>{rp.content}</p>
            {rp.images.length > 0 && (
              <div className="feedback-detail-images">
                {rp.images.map((src, idx) => (
                  <button key={idx} type="button" className="feedback-image-view" onClick={() => setPreviewSrc(src)} aria-label={`查看回复截图 ${idx + 1}`}>
                    <img src={src} alt={`回复截图${idx + 1}`} />
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {data.replies.length === 0 && <div className="feedback-replies-empty">暂无回复</div>}
      </div>

      <div className="feedback-reply-form">
        <textarea
          className="feedback-textarea"
          placeholder={isAdmin ? '回复该问题…' : '补充说明…'}
          rows={3}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
        />
        <button type="button" className="primary-action" onClick={() => void submitReply()} disabled={replyBusy}>
          {replyBusy ? '发送中…' : '发送'}
        </button>
        <div className="feedback-images feedback-images--reply">
          {replyImages.map((src, idx) => (
            <div key={idx} className="feedback-image-thumb">
              <img src={src} alt={`回复截图${idx + 1}`} />
              <button
                type="button"
                className="feedback-image-remove"
                onClick={() => setReplyImages((prev) => prev.filter((_, i) => i !== idx))}
                aria-label="移除截图"
              >
                ×
              </button>
            </div>
          ))}
          {replyImages.length < MAX_FEEDBACK_IMAGES && (
            <label className="feedback-image-add">
              <span>＋</span>
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  void handleImageFiles(e.target.files, replyImages, setReplyImages, showToast);
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
      </div>

      <Dialog.Root open={previewSrc !== null} onOpenChange={(next) => { if (!next) setPreviewSrc(null); }}>
        <Dialog.Portal>
          <Dialog.Content className="feedback-lightbox" aria-label="图片预览" aria-describedby={undefined}>
            <div className="feedback-lightbox-inner">
              <Dialog.Close asChild>
                <button type="button" className="feedback-lightbox-close" aria-label="关闭">×</button>
              </Dialog.Close>
              {previewSrc && <img className="feedback-lightbox-img" src={previewSrc} alt="截图预览" />}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function FeedbackList({ items, onOpen }: { items: FeedbackListItem[]; onOpen: (id: number) => void }) {
  if (items.length === 0) {
    return <div className="feedback-empty">暂无问题记录</div>;
  }
  return (
    <div className="feedback-list">
      {items.map((it) => (
        <button key={it.id} type="button" className="feedback-row" onClick={() => onOpen(it.id)}>
          <div className="feedback-row-head">
            <span className={`feedback-status ${STATUS_CLASS[it.status] || ''}`}>
              {STATUS_LABEL[it.status] || it.status}
            </span>
            {it.replyCount > 0 && <span className="feedback-reply-count">{it.replyCount} 条回复</span>}
          </div>
          <p className="feedback-row-content">{it.content}</p>
          <div className="feedback-row-meta">
            <span>{it.displayName}</span>
            <time>{formatTime(it.updatedAt)}</time>
          </div>
        </button>
      ))}
    </div>
  );
}

export default function FaqPage() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { data: list, isLoading } = useQuery({
    queryKey: ['feedbacks'],
    queryFn: fetchFeedbacks,
  });

  return (
    <div className="feedback-page faq-page">
      <div className="faq-page-head">
        <div>
          <h2>问题FAQ</h2>
          <p>浏览所有用户的问题与解答，遇到问题可直接发起提问，管理员会在此回复。</p>
        </div>
        {!selectedId && !showForm && (
          <button type="button" className="primary-action" onClick={() => setShowForm(true)}>
            ＋ 提交问题
          </button>
        )}
      </div>

      {selectedId ? (
        <FeedbackDetail id={selectedId} onBack={() => setSelectedId(null)} />
      ) : showForm ? (
        <FeedbackForm onDone={() => setShowForm(false)} />
      ) : isLoading ? (
        <div className="feedback-loading">加载中…</div>
      ) : (
        <FeedbackList items={list ?? []} onOpen={setSelectedId} />
      )}
    </div>
  );
}
