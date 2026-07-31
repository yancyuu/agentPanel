import { useEffect, useRef, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import { formatFileSize } from '@renderer/utils/attachmentUtils';
import { isTaskInputFileSupported, MAX_TASK_INPUT_FILE_SIZE } from '@renderer/utils/taskInputFiles';
import { File, Image, Paperclip, X } from 'lucide-react';

const MAX_TASK_INPUT_FILES = 8;
const MAX_TOTAL_TASK_INPUT_SIZE = 30 * 1024 * 1024;

function PendingFilePreview({ file }: Readonly<{ file: File }>): React.JSX.Element {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return previewUrl ? (
    <img src={previewUrl} alt="" className="size-10 rounded object-cover" />
  ) : (
    <span className="flex size-10 items-center justify-center rounded bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]">
      {file.type.startsWith('image/') ? <Image size={17} /> : <File size={17} />}
    </span>
  );
}

export function TaskInputPicker({
  files,
  onChange,
}: Readonly<{
  files: File[];
  onChange(files: File[]): void;
}>): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const addFiles = (selected: FileList | File[]): void => {
    const next = [...files];
    const errors: string[] = [];
    for (const file of selected) {
      if (next.length >= MAX_TASK_INPUT_FILES) {
        errors.push(`最多添加 ${MAX_TASK_INPUT_FILES} 个文件`);
        break;
      }
      if (!isTaskInputFileSupported(file)) {
        errors.push(`不支持的文件：${file.name}`);
        continue;
      }
      if (file.size === 0 || file.size > MAX_TASK_INPUT_FILE_SIZE) {
        errors.push(`文件“${file.name}”必须小于 20 MB且不能为空`);
        continue;
      }
      if (next.some((candidate) => candidate.name === file.name && candidate.size === file.size)) {
        continue;
      }
      const totalSize = next.reduce((sum, candidate) => sum + candidate.size, 0) + file.size;
      if (totalSize > MAX_TOTAL_TASK_INPUT_SIZE) {
        errors.push('任务输入文件合计不能超过 30 MB');
        break;
      }
      next.push(file);
    }
    setError(errors.length > 0 ? errors.join('；') : null);
    onChange(next);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div
      className={cn(
        'rounded-xl border border-dashed p-3 transition-colors',
        dragOver
          ? 'border-indigo-500 bg-indigo-500/[0.05]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)]'
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        addFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json,.md,.txt,.csv,.tsv,.json,.jsonl,.docx,.xlsx,.pptx,.zip"
        className="hidden"
        onChange={(event) => addFiles(event.target.files ?? [])}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-[var(--color-text-secondary)]">任务参考文件</p>
          <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
            文件会放进智能体当前项目的 input/任务ID/ 目录。
          </p>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
        >
          <Paperclip size={13} />
          添加图片或文件
        </button>
      </div>
      {files.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {files.map((file) => (
            <div
              key={`${file.name}:${file.size}:${file.lastModified}`}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--surface-border-subtle)] bg-[var(--color-surface-raised)] p-2"
            >
              <PendingFilePreview file={file} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-[var(--color-text)]">{file.name}</span>
                <span className="mt-0.5 block text-[10px] text-[var(--color-text-muted)]">
                  {formatFileSize(file.size)}
                </span>
              </span>
              <button
                type="button"
                aria-label={`移除 ${file.name}`}
                onClick={() => onChange(files.filter((candidate) => candidate !== file))}
                className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-rose-500"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg py-4 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
        >
          <Paperclip size={15} />
          点击选择，或把本地文件拖到这里
        </button>
      )}
      {error ? <p className="mt-2 text-xs text-rose-500">{error}</p> : null}
    </div>
  );
}
