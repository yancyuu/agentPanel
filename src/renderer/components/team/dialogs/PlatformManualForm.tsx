import { useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { cn } from '@renderer/lib/utils';
import { AlertCircle, ChevronDown, Eye, EyeOff } from 'lucide-react';

import type { FieldDef, PlatformMeta } from './platformMeta';

interface Props {
  platformType: string;
  platformMeta: PlatformMeta;
  projectName: string;
  workDir: string;
  agentType: string;
  initialValues?: Record<string, unknown>;
  onComplete: (options?: { restartHandled?: boolean }) => void;
  onCancel: () => void;
}

const PlatformManualForm = ({
  platformType,
  platformMeta: meta,
  projectName,
  workDir,
  agentType,
  initialValues = {},
  onComplete,
  onCancel,
}: Readonly<Props>): React.JSX.Element => {
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setValues(initialValues);
  }, [initialValues, platformType]);

  const basicFields = meta.fields.filter((f) => f.group !== 'advanced');
  const advancedFields = meta.fields.filter((f) => f.group === 'advanced');

  const handleSave = async () => {
    const missing = meta.fields.filter((f) => f.required && !values[f.key]);
    if (missing.length > 0) {
      setError(missing.map((f) => f.label).join(', ') + ' 为必填项');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const opts: Record<string, unknown> = { ...(meta.defaultOptions ?? {}) };
      for (const f of meta.fields) {
        const v = values[f.key];
        if (v !== undefined && v !== '') {
          opts[f.key] = v;
        }
      }
      const result = await api.ccSetup.addPlatform(projectName, {
        type: meta.submitType ?? platformType,
        options: opts,
        work_dir: workDir,
        agent_type: agentType,
      });
      onComplete({ restartHandled: result?.restart_handled === true });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const setValue = (key: string, val: unknown) => setValues((prev) => ({ ...prev, [key]: val }));

  return (
    <div className="space-y-4 py-2">
      <p className="text-sm font-medium text-gray-900 dark:text-white">{meta.label}</p>

      {basicFields.map((f) => (
        <FieldInput
          key={f.key}
          field={f}
          value={values[f.key] as string | boolean | undefined}
          onChange={(v) => setValue(f.key, v)}
        />
      ))}

      {advancedFields.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          >
            <ChevronDown
              size={12}
              className={cn('transition-transform', showAdvanced && 'rotate-180')}
            />
            高级选项 ({advancedFields.length})
          </button>
          {showAdvanced &&
            advancedFields.map((f) => (
              <FieldInput
                key={f.key}
                field={f}
                value={values[f.key] as string | boolean | undefined}
                onChange={(v) => setValue(f.key, v)}
              />
            ))}
        </>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-500 dark:bg-red-900/20">
          <AlertCircle size={14} className="shrink-0" /> {error}
        </div>
      )}

      <div className="flex justify-between pt-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          返回
        </Button>
        <Button
          size="sm"
          className="hover:bg-[var(--color-accent)]/90 bg-[var(--color-accent)] text-white"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '保存中...' : '绑定平台'}
        </Button>
      </div>
    </div>
  );
};

const FieldInput = ({
  field,
  value,
  onChange,
}: Readonly<{
  field: FieldDef;
  value: string | boolean | undefined;
  onChange: (v: unknown) => void;
}>): React.JSX.Element => {
  const [showPwd, setShowPwd] = useState(false);

  if (field.type === 'boolean') {
    return (
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 dark:border-gray-600"
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">{field.label}</span>
        {field.hint && <span className="text-[11px] text-gray-400">({field.hint})</span>}
      </label>
    );
  }

  const isPassword = field.type === 'password';

  return (
    <div>
      <Label className="text-xs">
        {field.label} {field.required && <span className="text-red-400">*</span>}
      </Label>
      <div className="relative mt-1">
        <Input
          type={isPassword && !showPwd ? 'password' : field.type === 'number' ? 'number' : 'text'}
          value={typeof value === 'string' || typeof value === 'number' ? value : ''}
          onChange={(e) =>
            onChange(
              field.type === 'number'
                ? e.target.value
                  ? Number(e.target.value)
                  : ''
                : e.target.value
            )
          }
          placeholder={field.placeholder}
          className="text-sm"
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShowPwd(!showPwd)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
          >
            {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </div>
      {field.hint && <p className="mt-1 text-[11px] text-gray-400">{field.hint}</p>}
    </div>
  );
};

export default PlatformManualForm;
