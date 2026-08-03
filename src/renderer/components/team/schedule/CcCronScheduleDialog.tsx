import { useEffect, useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { Textarea } from '@renderer/components/ui/textarea';
import { useStore } from '@renderer/store';
import { Loader2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import type { CreateScheduleInput, Schedule, UpdateSchedulePatch } from '@shared/types';
import type { TeamSummary } from '@shared/types/team';

interface CcCronScheduleDialogProps {
  open: boolean;
  teamName?: string;
  schedule?: Schedule | null;
  onClose: () => void;
}

const DEFAULT_CRON = '0 9 * * 1-5';
const DEFAULT_TIMEOUT_MINS = 60;

function getTeamWorkDir(team: TeamSummary | undefined): string {
  return (team?.projectPath ?? team?.workDir ?? '').trim();
}

export const CcCronScheduleDialog = ({
  open,
  teamName,
  schedule,
  onClose,
}: CcCronScheduleDialogProps): React.JSX.Element => {
  const { teams, createSchedule, updateSchedule } = useStore(
    useShallow((s) => ({
      teams: s.teams,
      createSchedule: s.createSchedule,
      updateSchedule: s.updateSchedule,
    }))
  );
  const [selectedTeamName, setSelectedTeamName] = useState(teamName ?? '');
  const [label, setLabel] = useState('');
  const [cronExpression, setCronExpression] = useState(DEFAULT_CRON);
  const [prompt, setPrompt] = useState('');
  const [timeoutMins, setTimeoutMins] = useState(String(DEFAULT_TIMEOUT_MINS));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTeam = useMemo(
    () => teams.find((team) => team.teamName === selectedTeamName),
    [selectedTeamName, teams]
  );
  const isEditing = Boolean(schedule);
  const canChooseTeam = !teamName && !isEditing;

  useEffect(() => {
    if (!open) return;
    const initialTeam = schedule?.teamName ?? teamName ?? teams[0]?.teamName ?? '';
    setSelectedTeamName(initialTeam);
    setLabel(schedule?.label ?? '');
    setCronExpression(schedule?.cronExpression ?? DEFAULT_CRON);
    setPrompt(schedule?.launchConfig.prompt ?? '');
    setTimeoutMins(String(schedule?.maxTurns ?? DEFAULT_TIMEOUT_MINS));
    setError(null);
  }, [open, schedule, teamName, teams]);

  const handleSubmit = async (): Promise<void> => {
    const normalizedTeamName = selectedTeamName.trim();
    const normalizedCron = cronExpression.trim();
    const normalizedPrompt = prompt.trim();
    const normalizedTimeout = Number.parseInt(timeoutMins, 10);

    if (!normalizedTeamName) {
      setError('请选择 Loop workspace');
      return;
    }
    if (!normalizedCron) {
      setError('请填写 Cron 表达式');
      return;
    }
    if (!normalizedPrompt) {
      setError('请填写定时指令');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const maxTurns = Number.isFinite(normalizedTimeout)
        ? Math.max(1, normalizedTimeout)
        : DEFAULT_TIMEOUT_MINS;
      if (isEditing && schedule) {
        const patch: UpdateSchedulePatch = {
          label: label.trim() || undefined,
          cronExpression: normalizedCron,
          maxTurns,
          launchConfig: {
            prompt: normalizedPrompt,
          },
        };
        await updateSchedule(schedule.id, patch);
      } else {
        const input: CreateScheduleInput = {
          teamName: normalizedTeamName,
          label: label.trim() || undefined,
          cronExpression: normalizedCron,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
          maxTurns,
          launchConfig: {
            cwd: getTeamWorkDir(selectedTeam),
            prompt: normalizedPrompt,
          },
        };
        await createSchedule(input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存定时任务失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? '编辑定时任务' : '添加定时任务'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {canChooseTeam ? (
            <div className="space-y-1.5">
              <Label>Loop workspace</Label>
              <select
                value={selectedTeamName}
                onChange={(event) => setSelectedTeamName(event.target.value)}
                className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
              >
                <option value="">选择 Loop workspace...</option>
                {teams.map((team) => (
                  <option key={team.teamName} value={team.teamName}>
                    {team.displayName || team.teamName}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label>名称</Label>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="例如：每日进度检查"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Cron 表达式</Label>
            <Input
              value={cronExpression}
              onChange={(event) => setCronExpression(event.target.value)}
              placeholder="0 9 * * 1-5"
              className="font-mono"
            />
            <p className="text-xs text-[var(--color-text-muted)]">例如工作日 9 点：0 9 * * 1-5</p>
          </div>

          <div className="space-y-1.5">
            <Label>定时指令</Label>
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="到时间后发送给 Lead 的循环指令..."
              className="min-h-28"
            />
          </div>

          <div className="space-y-1.5">
            <Label>超时分钟</Label>
            <Input
              type="number"
              min={1}
              value={timeoutMins}
              onChange={(event) => setTimeoutMins(event.target.value)}
            />
          </div>

          {error ? (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            className="hover:bg-[var(--color-accent)]/90 bg-[var(--color-accent)] text-white"
            onClick={() => void handleSubmit()}
            disabled={saving}
          >
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            {isEditing ? '保存' : '添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
