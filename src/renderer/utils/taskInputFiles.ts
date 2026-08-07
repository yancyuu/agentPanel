import { getEffectiveMimeType, TEXT_FILE_EXTENSIONS } from '@shared/constants/attachments';

const TASK_INPUT_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'zip',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

export const MAX_TASK_INPUT_FILE_SIZE = 20 * 1024 * 1024;

function extensionOf(filename: string): string {
  return filename.split('.').pop()?.toLocaleLowerCase() ?? '';
}

export function isTaskInputFileSupported(file: File): boolean {
  const extension = extensionOf(file.name);
  return TASK_INPUT_EXTENSIONS.has(extension) || TEXT_FILE_EXTENSIONS.has(extension);
}

export function getTaskInputMimeType(file: File): string {
  const extension = extensionOf(file.name);
  if (TEXT_FILE_EXTENSIONS.has(extension)) return 'text/plain';
  return MIME_BY_EXTENSION[extension] ?? getEffectiveMimeType(file);
}

export function taskInputFileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const [, base64] = result.split(',', 2);
      if (base64) resolve(base64);
      else reject(new Error(`读取文件失败：${file.name}`));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`读取文件失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}
