import assistantCreationOptions from '@shared/assistantCreationOptions.json';

export interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  type?: 'text' | 'password' | 'number' | 'boolean';
  placeholder?: string;
  hint?: string;
  group?: 'basic' | 'advanced';
}

export interface PlatformMeta {
  label: string;
  fields: FieldDef[];
  submitType?: string;
  defaultOptions?: Record<string, unknown>;
}

export const platformMeta = assistantCreationOptions.platformMeta as Record<string, PlatformMeta>;

export const QR_PLATFORMS = assistantCreationOptions.qrPlatforms as readonly string[];

export function isQRPlatform(type: string): boolean {
  return QR_PLATFORMS.includes(type);
}
