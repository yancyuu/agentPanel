import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { useStore } from '@renderer/store';
import { Loader2 } from 'lucide-react';

interface EditTeamDialogProps {
  open: boolean;
  teamName: string;
  onClose: () => void;
  onDeleteTeam?: () => void;
}

// ── Shared input class ───────────────────────────────────────
const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-border-emphasis)]';

const labelCls = 'mb-1 block text-xs font-medium text-[var(--color-text-secondary)]';

// ── Main component ───────────────────────────────────────────
export const EditTeamDialog = ({
  open,
  teamName,
  onClose,
  onDeleteTeam,
}: EditTeamDialogProps): React.JSX.Element => {
  const { data, fetchTeams, selectTeam } = useStore((s) => ({
    data: s.selectedTeamName === teamName ? s.selectedTeamData : null,
    fetchTeams: s.fetchTeams,
    selectTeam: s.selectTeam,
  }));

  // ── Derived defaults ─────────────────────────────────────────
  // Loop 动态设置（语言/管理来源/飞书权限/消息格式）已统一迁入 RuntimeConfigDialog，
  // 这里只保留团队基础信息：名称、描述、颜色 (#21)。
  const defaults = useMemo(() => {
    const cfg = data?.config;
    return {
      name: cfg?.name ?? '',
      description: cfg?.description ?? '',
      color: cfg?.color ?? '',
    };
  }, [data]);

  // ── Local form state ─────────────────────────────────────────
  const [name, setName] = useState(defaults.name);
  const [description, setDescription] = useState(defaults.description);
  const [savePhase, setSavePhase] = useState<'idle' | 'saving' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const saving = savePhase === 'saving';

  const defaultsRef = useRef(defaults);
  if (defaults.name) defaultsRef.current = defaults;

  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (!open || prevOpenRef.current) {
      prevOpenRef.current = open;
      return;
    }
    prevOpenRef.current = true;
    const d = defaultsRef.current;
    setSavePhase('idle');
    setError(null);
    setName(d.name);
    setDescription(d.description);
  }, [open]);

  const handleSave = (): void => {
    if (!name.trim()) {
      setError('团队名称不能为空');
      return;
    }
    if (savePhase !== 'idle') return;
    setSavePhase('saving');
    setError(null);

    void (async () => {
      try {
        await api.teams.updateConfig(teamName, {
          name: name.trim(),
          description: description.trim(),
          color: defaultsRef.current.color,
        });
        await Promise.all([fetchTeams(), selectTeam(teamName)]);
        setSavePhase('done');
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存失败');
        setSavePhase('idle');
      }
    })();
  };

  const saveLabel =
    savePhase === 'done' ? '保存成功' : savePhase === 'saving' ? '保存中...' : '保存';

  return (
    <Dialog
      open={saving ? true : open}
      onOpenChange={(nextOpen) => {
        if (saving) return;
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑团队</DialogTitle>
          <DialogDescription>修改团队名称和描述</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Basic info */}
          <div>
            <label htmlFor="edit-team-name" className={labelCls}>
              名称
            </label>
            <input
              id="edit-team-name"
              type="text"
              value={name}
              onChange={(e) => {
                setError(null);
                setName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving && name.trim()) handleSave();
              }}
              className={inputCls}
              placeholder="团队名称"
            />
          </div>
          <div>
            <label htmlFor="edit-team-description" className={labelCls}>
              描述
            </label>
            <textarea
              id="edit-team-description"
              value={description}
              onChange={(e) => {
                setError(null);
                setDescription(e.target.value);
              }}
              rows={2}
              className={`${inputCls} resize-none`}
              placeholder="团队描述（可选）"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <DialogFooter>
          {onDeleteTeam && teamName !== 'default' ? (
            <Button variant="ghost" size="sm" onClick={onDeleteTeam} disabled={saving}>
              删除项目
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {savePhase === 'done' ? '关闭' : '取消'}
          </Button>
          <Button
            size="sm"
            className="hover:bg-[var(--color-accent)]/90 bg-[var(--color-accent)] text-white"
            onClick={handleSave}
            disabled={saving || savePhase === 'done' || !name.trim()}
          >
            {saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
