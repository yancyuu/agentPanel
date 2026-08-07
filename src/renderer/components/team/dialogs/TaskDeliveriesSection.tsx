import { useCallback, useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { DeliveryContentView } from '@renderer/components/team/DeliveryContentView';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { ExpandableContent } from '@renderer/components/ui/ExpandableContent';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { format, formatDistanceToNow } from 'date-fns';
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  GitFork,
  Loader2,
  Printer,
  Sparkles,
  Upload,
} from 'lucide-react';

import { FeedbackAnchorView } from './FeedbackAnchorView';

import type { Delivery, FeedbackItem } from '@shared/types';

interface TaskDeliveriesSectionProps {
  deliveries?: Delivery[];
  feedbackItems?: FeedbackItem[];
  /** 点击 hunk 锚点时打开变更审查（无则静态展示）。 */
  onOpenHunk?: (changeKey: string) => void;
  /** 只读展示时的评审入口引导文案（如「前往收件箱评审」） */
  reviewLocationHint?: string;
  /** 提供时引导渲染为可点击按钮 */
  onReviewLocationClick?: () => void;
  teamName?: string;
  taskId?: string;
  agentName?: string | null;
}

function formatRelativeTime(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return null;
  return formatDistanceToNow(date, { addSuffix: true });
}

function formatFullTime(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return null;
  return format(date, 'yyyy-MM-dd HH:mm:ss');
}

/**
 * 交付成果 + 反馈待办点（只读）：
 * - deliveries 追加式版本化，默认展示最新一版，可前后切换；
 * - 每版突出显示本版变更摘要（summary），并列出本版处理的反馈条目；
 * - feedbackItems 条目化展示，open 项计数醒目提示，resolved 项弱化；
 * - 评审交互（通过/退回/选中提意见）在收件箱进行，此处仅展示。
 */
export const TaskDeliveriesSection = ({
  deliveries,
  feedbackItems,
  onOpenHunk,
  reviewLocationHint,
  onReviewLocationClick,
  teamName,
  taskId,
  agentName,
}: TaskDeliveriesSectionProps): React.JSX.Element | null => {
  // null = 跟随最新一版；用户手动切换后固定在所选版本
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [resultCopied, setResultCopied] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [githubBinding, setGithubBinding] = useState<{ repository: string; branch: string } | null>(
    null
  );
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubDialogOpen, setGithubDialogOpen] = useState(false);
  const [repositoryDraft, setRepositoryDraft] = useState('');
  const [branchDraft, setBranchDraft] = useState('agentpanel-deliveries');
  const [transportDraft, setTransportDraft] = useState<'https' | 'ssh'>('https');
  const [githubMessage, setGithubMessage] = useState<string | null>(null);
  const [githubUrl, setGithubUrl] = useState<string | null>(null);

  const sortedDeliveries = deliveries ? [...deliveries].sort((a, b) => a.version - b.version) : [];
  const latestDelivery = sortedDeliveries.at(-1);
  const currentDelivery =
    (selectedVersion != null
      ? sortedDeliveries.find((d) => d.version === selectedVersion)
      : undefined) ?? latestDelivery;

  const feedbackById = new Map((feedbackItems ?? []).map((item) => [item.id, item]));
  const openFeedback = (feedbackItems ?? []).filter((item) => item.status === 'open');
  const resolvedFeedback = (feedbackItems ?? []).filter((item) => item.status === 'resolved');

  const copyResult = useCallback(async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setResultCopied(true);
    } catch {
      setResultCopied(false);
    }
  }, []);

  const printResult = useCallback(() => {
    window.print();
  }, []);

  const openArchiveFolder = useCallback(async () => {
    if (!teamName || !taskId) return;
    try {
      const archive = await api.githubDelivery.getArchiveInfo(teamName, taskId);
      await api.showInFolder(archive.outputDir);
    } catch (error) {
      setGithubMessage(error instanceof Error ? error.message : '打开成果文件夹失败');
    }
  }, [taskId, teamName]);

  const downloadArchive = useCallback(async () => {
    if (!teamName || !taskId) return;
    setArchiveLoading(true);
    try {
      const blob = await api.githubDelivery.downloadArchive(teamName, taskId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${taskId}-delivery.zip`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setGithubMessage(error instanceof Error ? error.message : '导出 ZIP 失败');
    } finally {
      setArchiveLoading(false);
    }
  }, [taskId, teamName]);

  const saveGithubBinding = useCallback(async () => {
    if (!agentName) return;
    setGithubLoading(true);
    setGithubMessage(null);
    try {
      const binding = await api.githubDelivery.saveBinding(agentName, {
        repository: repositoryDraft,
        branch: branchDraft,
        transport: transportDraft,
      });
      setGithubBinding(binding);
      setGithubDialogOpen(false);
    } catch (error) {
      setGithubMessage(error instanceof Error ? error.message : '保存 GitHub 仓库失败');
    } finally {
      setGithubLoading(false);
    }
  }, [agentName, branchDraft, repositoryDraft, transportDraft]);

  const publishGithubDelivery = useCallback(async () => {
    if (!teamName || !taskId || !agentName) return;
    setGithubLoading(true);
    setGithubMessage(null);
    setGithubUrl(null);
    try {
      const receipt = await api.githubDelivery.publish({ teamName, taskId, agentName });
      setGithubUrl(receipt.url);
      setGithubMessage(`已推送到 ${receipt.repository} 的 ${receipt.branch} 分支`);
    } catch (error) {
      setGithubMessage(error instanceof Error ? error.message : '发布 GitHub 成果失败');
    } finally {
      setGithubLoading(false);
    }
  }, [agentName, taskId, teamName]);

  const fetchGithubBinding = useCallback(async () => {
    if (!agentName) return null;
    const bindings = await api.githubDelivery.listBindings();
    return bindings.find((item) => item.agentName === agentName) ?? null;
  }, [agentName]);

  useEffect(() => {
    let cancelled = false;
    if (!agentName) {
      setGithubBinding(null);
      return () => {
        cancelled = true;
      };
    }
    void fetchGithubBinding()
      .then((binding) => {
        if (cancelled) return;
        setGithubBinding(binding);
        setRepositoryDraft(binding?.repository ?? '');
        setBranchDraft(binding?.branch ?? 'agentpanel-deliveries');
        setTransportDraft(binding?.transport ?? 'https');
      })
      .catch((error) => {
        if (!cancelled) {
          setGithubMessage(error instanceof Error ? error.message : '读取 GitHub 绑定失败');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentName, fetchGithubBinding]);

  const openGithubBinding = useCallback(async () => {
    if (!agentName) return;
    setGithubLoading(true);
    setGithubMessage(null);
    try {
      const binding = await fetchGithubBinding();
      setGithubBinding(binding);
      setRepositoryDraft(binding?.repository ?? '');
      setBranchDraft(binding?.branch ?? 'agentpanel-deliveries');
      setTransportDraft(binding?.transport ?? 'https');
      setGithubDialogOpen(true);
    } catch (error) {
      setGithubMessage(error instanceof Error ? error.message : '读取 GitHub 绑定失败');
    } finally {
      setGithubLoading(false);
    }
  }, [agentName, fetchGithubBinding]);

  const openGitHubUrl = useCallback(async () => {
    if (!githubUrl) return;
    const result = await api.openExternal(githubUrl);
    if (!result.success) setGithubMessage(result.error ?? '无法打开 GitHub 页面');
  }, [githubUrl]);

  const unbindGithub = useCallback(async () => {
    if (!agentName || !githubBinding) return;
    if (!window.confirm(`解除 ${githubBinding.repository} 的 GitHub 交付绑定？`)) return;
    setGithubLoading(true);
    setGithubMessage(null);
    try {
      await api.githubDelivery.deleteBinding(agentName);
      setGithubBinding(null);
      setRepositoryDraft('');
      setBranchDraft('agentpanel-deliveries');
      setTransportDraft('https');
      setGithubMessage('已解除 GitHub 仓库绑定');
    } catch (error) {
      setGithubMessage(error instanceof Error ? error.message : '解除 GitHub 绑定失败');
    } finally {
      setGithubLoading(false);
    }
  }, [agentName, githubBinding]);

  if (sortedDeliveries.length === 0 && (feedbackItems ?? []).length === 0) {
    return null;
  }

  const addressedItems =
    currentDelivery?.addressedFeedbackIds
      ?.map((id) => feedbackById.get(id))
      .filter((item): item is FeedbackItem => Boolean(item)) ?? [];

  const currentIndex = currentDelivery
    ? sortedDeliveries.findIndex((d) => d.version === currentDelivery.version)
    : -1;

  return (
    <div className="space-y-3">
      {reviewLocationHint ? (
        onReviewLocationClick ? (
          <button
            type="button"
            data-testid="review-location-button"
            onClick={onReviewLocationClick}
            className="inline-flex items-center gap-1.5 rounded-md border border-indigo-500/30 bg-indigo-500/[0.06] px-2.5 py-1 text-[11px] font-medium text-indigo-600 transition-colors hover:bg-indigo-500/15 dark:text-indigo-300"
          >
            {reviewLocationHint}
          </button>
        ) : (
          <div className="text-[11px] text-[var(--color-text-muted)] opacity-70">
            {reviewLocationHint}
          </div>
        )
      ) : null}

      {currentDelivery ? (
        <div className="space-y-2" data-testid="delivery-version">
          {/* 版本切换 + 交付时间 + 次要操作（复制/保存 PDF 仅图标） */}
          <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
            {sortedDeliveries.length > 1 ? (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="上一版"
                  className="rounded p-0.5 transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] disabled:opacity-30"
                  disabled={currentIndex <= 0}
                  onClick={() =>
                    setSelectedVersion(sortedDeliveries[currentIndex - 1]?.version ?? null)
                  }
                >
                  <ChevronLeft size={12} />
                </button>
                <span className="tabular-nums">
                  第 {currentDelivery.version} 版 / 共 {sortedDeliveries.length} 版
                </span>
                <button
                  type="button"
                  aria-label="下一版"
                  className="rounded p-0.5 transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] disabled:opacity-30"
                  disabled={currentIndex < 0 || currentIndex >= sortedDeliveries.length - 1}
                  onClick={() =>
                    setSelectedVersion(sortedDeliveries[currentIndex + 1]?.version ?? null)
                  }
                >
                  <ChevronRight size={12} />
                </button>
              </span>
            ) : null}
            {formatRelativeTime(currentDelivery.deliveredAt) ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1">
                    <Clock size={10} />
                    交付于 {formatRelativeTime(currentDelivery.deliveredAt)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {formatFullTime(currentDelivery.deliveredAt)}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="复制成果"
                    onClick={() => void copyResult(currentDelivery.result)}
                    className="inline-flex items-center rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)]"
                  >
                    {resultCopied ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{resultCopied ? '已复制' : '复制'}</TooltipContent>
              </Tooltip>
              {teamName && taskId ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="打开成果文件夹"
                      onClick={() => void openArchiveFolder()}
                      className="inline-flex items-center rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)]"
                    >
                      <FolderOpen size={12} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">打开成果文件夹</TooltipContent>
                </Tooltip>
              ) : null}
              {teamName && taskId ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="下载 ZIP"
                      disabled={archiveLoading}
                      onClick={() => void downloadArchive()}
                      className="inline-flex items-center rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)] disabled:opacity-50"
                    >
                      {archiveLoading ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Download size={12} />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">下载 ZIP</TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="保存 PDF"
                    onClick={printResult}
                    className="inline-flex items-center rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)]"
                  >
                    <Printer size={12} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">保存 PDF</TooltipContent>
              </Tooltip>
            </span>
          </div>

          {teamName && taskId && agentName ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-2 text-[11px]">
              <GitFork size={13} className="text-[var(--color-text-muted)]" />
              <span className="min-w-0 flex-1 text-[var(--color-text-secondary)]">
                {githubBinding
                  ? `${githubBinding.repository} · ${githubBinding.branch}`
                  : '尚未绑定 GitHub 仓库'}
              </span>
              <button
                type="button"
                onClick={() => void openGithubBinding()}
                disabled={githubLoading}
                className="rounded px-1.5 py-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
              >
                {githubBinding ? '更改仓库' : '绑定仓库'}
              </button>
              {githubBinding ? (
                <button
                  type="button"
                  onClick={() => void unbindGithub()}
                  disabled={githubLoading}
                  className="rounded px-1.5 py-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-red-400 disabled:opacity-50"
                >
                  解除绑定
                </button>
              ) : null}
              {githubBinding ? (
                <button
                  type="button"
                  onClick={() => void publishGithubDelivery()}
                  disabled={githubLoading}
                  className="inline-flex items-center gap-1 rounded bg-[var(--color-accent)] px-2 py-1 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {githubLoading ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Upload size={12} />
                  )}
                  发布成果
                </button>
              ) : null}
            </div>
          ) : null}
          {githubMessage ? (
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
              <span>{githubMessage}</span>
              {githubUrl ? (
                <button
                  type="button"
                  onClick={() => void openGitHubUrl()}
                  className="inline-flex items-center gap-0.5 text-[var(--color-accent)] hover:underline"
                >
                  打开 GitHub <ExternalLink size={11} />
                </button>
              ) : null}
            </div>
          ) : null}

          {/* 本版变更摘要 —— 只审增量的入口，突出显示 */}
          {currentDelivery.summary ? (
            <div className="rounded-md border border-indigo-400/25 bg-indigo-500/10 px-2.5 py-1.5">
              <div className="mb-0.5 flex items-center gap-1 text-[10px] font-medium text-indigo-600 dark:text-indigo-300">
                <Sparkles size={10} />
                本版变更摘要
              </div>
              <div className="whitespace-pre-wrap break-words text-xs text-[var(--color-text-secondary)]">
                {currentDelivery.summary}
              </div>
            </div>
          ) : null}

          {/* 成果内容（按类型渲染：HTML 文档 → 沙盒预览/源码切换） */}
          <ExpandableContent collapsedHeight={200} className="text-xs">
            <DeliveryContentView content={currentDelivery.result} />
          </ExpandableContent>

          {/* 本版处理的反馈 */}
          {addressedItems.length > 0 ? (
            <div className="space-y-1">
              <div className="text-[10px] font-medium text-[var(--color-text-muted)]">
                本版处理的反馈
              </div>
              <ul className="space-y-1">
                {addressedItems.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]"
                  >
                    <CheckCircle2 size={11} className="shrink-0 text-emerald-400" />
                    <span className="min-w-0 break-words">{item.text}</span>
                    {item.anchor ? (
                      <FeedbackAnchorView anchor={item.anchor} onOpenHunk={onOpenHunk} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 反馈待办点 */}
      <Dialog open={githubDialogOpen} onOpenChange={setGithubDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>绑定 GitHub 成果仓库</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-[var(--color-text-muted)]">
              使用本机 Git 凭证管理器或 SSH Key 授权；AgentPanel 不会保存 GitHub Token。
            </p>
            <label className="block space-y-1 text-xs text-[var(--color-text-secondary)]">
              仓库
              <input
                value={repositoryDraft}
                onChange={(event) => setRepositoryDraft(event.target.value)}
                placeholder="owner/repository"
                className="h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 text-sm"
              />
            </label>
            <label className="block space-y-1 text-xs text-[var(--color-text-secondary)]">
              认证方式
              <select
                value={transportDraft}
                onChange={(event) => setTransportDraft(event.target.value as 'https' | 'ssh')}
                className="h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 text-sm"
              >
                <option value="https">HTTPS（本机 Git Credential Manager）</option>
                <option value="ssh">SSH（本机 SSH Key）</option>
              </select>
            </label>
            <label className="block space-y-1 text-xs text-[var(--color-text-secondary)]">
              交付分支
              <input
                value={branchDraft}
                onChange={(event) => setBranchDraft(event.target.value)}
                className="h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 text-sm"
              />
            </label>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setGithubDialogOpen(false)}
              className="rounded px-3 py-1.5 text-sm hover:bg-[var(--color-surface-hover)]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void saveGithubBinding()}
              disabled={githubLoading || !repositoryDraft.trim()}
              className="inline-flex items-center gap-1 rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {githubLoading ? <Loader2 size={14} className="animate-spin" /> : null}
              保存绑定
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {(feedbackItems ?? []).length > 0 ? (
        <div className="space-y-1.5" data-testid="feedback-list">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
              反馈待办点
            </span>
            {openFeedback.length > 0 ? (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-300">
                {openFeedback.length} 条待处理
              </span>
            ) : (
              <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
                全部已解决
              </span>
            )}
          </div>
          <ul className="space-y-1.5">
            {[...openFeedback, ...resolvedFeedback].map((item) => {
              const isResolved = item.status === 'resolved';
              const createdLabel = formatRelativeTime(item.createdAt);
              const resolvedLabel = item.resolvedAt ? formatRelativeTime(item.resolvedAt) : null;
              return (
                <li
                  key={item.id}
                  className={`rounded-md border px-2.5 py-1.5 ${
                    isResolved
                      ? 'border-[var(--color-border)] opacity-60'
                      : 'border-amber-500/25 bg-amber-500/5'
                  }`}
                >
                  <div className="flex items-start gap-1.5">
                    {isResolved ? (
                      <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-400" />
                    ) : (
                      <CircleDot size={12} className="mt-0.5 shrink-0 text-amber-400" />
                    )}
                    <div className="min-w-0 flex-1 space-y-1">
                      <div
                        className={`whitespace-pre-wrap break-words text-xs ${
                          isResolved
                            ? 'text-[var(--color-text-muted)] line-through'
                            : 'text-[var(--color-text-secondary)]'
                        }`}
                      >
                        {item.text}
                      </div>
                      {item.anchor ? (
                        <FeedbackAnchorView anchor={item.anchor} onOpenHunk={onOpenHunk} />
                      ) : null}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[var(--color-text-muted)]">
                        <span>{isResolved ? '已解决' : '待处理'}</span>
                        {createdLabel ? <span>创建于 {createdLabel}</span> : null}
                        {isResolved && resolvedLabel ? <span>解决于 {resolvedLabel}</span> : null}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
};
