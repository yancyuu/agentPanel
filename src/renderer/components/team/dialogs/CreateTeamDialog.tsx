/**
 * CreateTeamDialog — create a new digital worker (数字员工).
 *
 * Wizard steps:
 *   1. Name + Agent type + Work directory
 *   2. Done (success confirmation)
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { providersApi } from '@renderer/api/providers';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { useCreateTeamDraft } from '@renderer/hooks/useCreateTeamDraft';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { generateBindProject, isValidBindProject } from '@renderer/utils/bindProjectSlug';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { isEphemeralProjectPath } from '@shared/utils/ephemeralProjectPath';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';

import { AGENT_TYPE_LABELS } from '../HarnessCards';
import { HarnessSelect } from '../HarnessSelect';

import {
  buildSelectableProjectsWithDefaultPath,
  findProjectPathMatch,
} from './createTeamDefaultProject';
import {
  type HarnessAvailabilitySnapshot,
  selectDesktopDefaultHarness,
} from './desktopHarnessDefault';
import { ProjectPathSelector } from './ProjectPathSelector';

import type {
  EffortLevel,
  Project,
  TeamCreateRequest,
  TeamFastMode,
  TeamProviderId,
} from '@shared/types';
import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';
import type { GlobalProvider } from '@shared/types/providers';

export interface ActiveTeamRef {
  teamName: string;
  displayName: string;
  projectPath: string;
}

/** Legacy type — preserved for backward compatibility with LaunchTeamDialog. */
export interface TeamCopyData {
  teamName: string;
  description?: string;
  color?: string;
  providerId?: TeamProviderId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  limitContext?: boolean;
  skipPermissions?: boolean;
  templateSourceId?: string;
  templateDirectoryId?: string;
}

// bindProject slug rules live in @renderer/utils/bindProjectSlug (unit-tested).

// ---------------------------------------------------------------------------
// Wizard step types
// ---------------------------------------------------------------------------

type WizardStep = 'name' | 'done';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CreateTeamDialogProps {
  open: boolean;
  canCreate: boolean;
  provisioningErrorsByTeam: Record<string, string | null>;
  clearProvisioningError?: (teamName?: string) => void;
  existingTeamNames: string[];
  existingBindProjects?: string[];
  existingDisplayNames?: string[];
  provisioningTeamNames?: string[];
  activeTeams?: ActiveTeamRef[];
  initialData?: unknown;
  defaultProjectPath?: string | null;
  onClose: () => void;
  onCreate: (request: TeamCreateRequest) => Promise<void>;
  onOpenTeam: (teamName: string, projectPath?: string, options?: { displayName?: string }) => void;
}

export const CreateTeamDialog = ({
  open,
  canCreate,
  provisioningErrorsByTeam,
  clearProvisioningError,
  existingTeamNames,
  existingBindProjects = [],
  existingDisplayNames = [],
  provisioningTeamNames = [],
  activeTeams,
  defaultProjectPath,
  onClose,
  onCreate,
  onOpenTeam,
}: CreateTeamDialogProps): React.JSX.Element => {
  const { isLight } = useTheme();

  // ── Draft state (persisted) ──────────────────────────────────────────
  const {
    teamName,
    setTeamName,
    cwdMode,
    setCwdMode,
    selectedProjectPath,
    setSelectedProjectPath,
    customCwd,
    setCustomCwd,
    teamColor,
    setTeamColor,
    isLoaded: draftLoaded,
    clearDraft,
  } = useCreateTeamDraft();

  // ── Wizard state ─────────────────────────────────────────────────────
  const [step, setStep] = useState<WizardStep>('name');
  const [selectedHarness, setSelectedHarness] = useState<HermitBridgeAgentType>('claudecode');
  const harnessSelectionTouched = useRef(false);
  const [description, setDescription] = useState('');

  // ── bindProject (ASCII unique identifier) ────────────────────────────
  // Only the *manual* override is state. The auto value is DERIVED (below) so
  // it is collision-free in the SAME render as `existingBindProjectSet`. A
  // state + useEffect pair lagged one render behind the set and flickered a
  // false "该项目标识已存在" red box whenever the teams list refreshed.
  const [manualBindProject, setManualBindProject] = useState('');
  const [bindProjectManuallyEdited, setBindProjectManuallyEdited] = useState(false);

  // ── Projects (for path selector) ─────────────────────────────────────
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  // ── Global providers ─────────────────────────────────────────────────
  const [globalProviders, setGlobalProviders] = useState<GlobalProvider[]>([]);
  const [selectedProviderRef, setSelectedProviderRef] = useState<string | null>(null);

  // ── Errors / submission ──────────────────────────────────────────────
  const [localError, setLocalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ teamName?: string; cwd?: string }>({});
  // The slug ACTUALLY used at creation. The live `bindProject` re-derives once
  // the parent's fetchTeams() refreshes existingBindProjects (the just-created
  // slug is now taken) and its numeric-counter fallback can land on an
  // UNRELATED existing team's slug — so the done step's "open" button must use
  // this captured id, not the re-derived one. See the "opens the JUST-CREATED
  // team" regression test.
  const [createdTeamName, setCreatedTeamName] = useState<string | null>(null);

  // ── Name conflict detection ──────────────────────────────────────────
  const existingBindProjectSet = useMemo(
    () => new Set(existingBindProjects.map((value) => value.trim().toLowerCase()).filter(Boolean)),
    [existingBindProjects]
  );
  const provisioningTeamNameSet = useMemo(
    () => new Set(provisioningTeamNames.map((value) => value.trim().toLowerCase()).filter(Boolean)),
    [provisioningTeamNames]
  );
  // displayName (the human-readable name) must be unique too. A duplicate name
  // silently produced a ghost team (the 222-2 incident: draft-restored name +
  // auto-collision-free bindProject + a second create click), so block it up front.
  const existingDisplayNameSet = useMemo(
    () => new Set(existingDisplayNames.map((value) => value.trim().toLowerCase()).filter(Boolean)),
    [existingDisplayNames]
  );
  const isDisplayNameTaken =
    Boolean(teamName.trim()) && existingDisplayNameSet.has(teamName.trim().toLowerCase());
  // The collision check is reactive to the live `teams` list. The instant a
  // create succeeds, the parent store adds the new team and `isDisplayNameTaken`
  // trips on the just-created name for the one frame before the dialog moves to
  // the success step — a false "该名称已存在" red-box flicker. Validation
  // (validateCreateFields) runs pre-submit and still uses the raw check, but the
  // *visual* red box / error text / disabled state is suppressed while a create
  // is in flight, since by then the name has already been accepted.
  const showDisplayNameTaken = isDisplayNameTaken && !isSubmitting;

  // bindProject is DERIVED, not state. The auto value is generated in the same
  // render as `existingBindProjectSet`, so it is collision-free BY CONSTRUCTION
  // and `isBindProjectTaken` can never flicker true between a set change and an
  // effect flush. (The previous state + useEffect implementation lagged one
  // render and produced a transient false "该项目标识已存在" red box.)
  const autoBindProject = useMemo(
    () => generateBindProject(teamName, existingBindProjectSet),
    [teamName, existingBindProjectSet]
  );
  const bindProject = bindProjectManuallyEdited ? manualBindProject : autoBindProject;
  const normalizedBindProject = bindProject.trim().toLowerCase();

  const isBindProjectTaken = existingBindProjectSet.has(normalizedBindProject);
  // Slug the done-step "open" + provisioning-error lookup target: the one
  // actually used at creation (captured), falling back to the live form value
  // before creation. Never the re-derived `bindProject` once the parent list
  // refreshes — that drifts to a different/colliding id (createdTeamName note).
  const openTeamSlug = createdTeamName ?? bindProject;
  const isNameProvisioning =
    provisioningTeamNameSet.has(normalizedBindProject) && !isBindProjectTaken;
  const isBindProjectFormatInvalid =
    Boolean(bindProject) && !isValidBindProject(normalizedBindProject);

  const effectiveCwd =
    cwdMode === 'project'
      ? isEphemeralProjectPath(selectedProjectPath)
        ? ''
        : selectedProjectPath.trim()
      : customCwd.trim();

  const compatibleProviders = useMemo(
    () =>
      globalProviders.filter(
        (p) =>
          !p.agent_types || p.agent_types.length === 0 || p.agent_types.includes(selectedHarness)
      ),
    [globalProviders, selectedHarness]
  );

  const selectProviderRef = (providerName: string) => {
    setSelectedProviderRef((prev) => (prev === providerName ? null : providerName));
  };

  // Clear selected provider when harness changes and it's no longer compatible
  useEffect(() => {
    setSelectedProviderRef((prev) => {
      if (!prev) return prev;
      const compatible = new Set(compatibleProviders.map((p) => p.name));
      return compatible.has(prev) ? prev : null;
    });
  }, [compatibleProviders]);

  const conflictingTeam = useMemo(() => {
    if (!activeTeams?.length || !effectiveCwd) return null;
    const norm = normalizePath(effectiveCwd);
    return activeTeams.find((t) => normalizePath(t.projectPath) === norm) ?? null;
  }, [activeTeams, effectiveCwd]);
  const selectableProjects = useMemo(
    () => buildSelectableProjectsWithDefaultPath(projects, defaultProjectPath),
    [projects, defaultProjectPath]
  );
  const [conflictDismissed, setConflictDismissed] = useState(false);
  useEffect(() => {
    setConflictDismissed(false);
  }, [conflictingTeam?.teamName, effectiveCwd]);

  // ── Desktop runtime default ──────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    harnessSelectionTouched.current = false;
    let cancelled = false;
    void fetch('/api/harnesses', { headers: { Accept: 'application/json' } })
      .then(async (response) =>
        response.ok ? ((await response.json()) as HarnessAvailabilitySnapshot[]) : []
      )
      .then((snapshots) => {
        if (cancelled || harnessSelectionTouched.current) return;
        const preferred = selectDesktopDefaultHarness(snapshots);
        if (preferred) setSelectedHarness(preferred);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  // ── Load projects on open ────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setProjectsLoading(true);
    setProjectsError(null);
    let cancelled = false;
    void (async () => {
      try {
        const next = (await api.getProjects()).filter((p) => !isEphemeralProjectPath(p.path));
        if (!cancelled) {
          setProjects(next);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setProjectsError(e instanceof Error ? e.message : '加载项目列表失败');
          setProjects([]);
        }
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // ── Load global providers on open ────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await providersApi.list();
        if (!cancelled) setGlobalProviders(result.providers ?? []);
      } catch {
        if (!cancelled) setGlobalProviders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // ── Auto-select default project path ─────────────────────────────────
  useEffect(() => {
    if (!open || !defaultProjectPath || isEphemeralProjectPath(defaultProjectPath)) return;
    setCwdMode('project');
  }, [open, defaultProjectPath, setCwdMode]);

  useEffect(() => {
    if (!open || cwdMode !== 'project' || selectableProjects.length === 0) return;
    const defaultMatch = findProjectPathMatch(selectableProjects, defaultProjectPath);
    if (defaultMatch) {
      if (normalizePath(selectedProjectPath) !== normalizePath(defaultMatch)) {
        setSelectedProjectPath(defaultMatch);
      }
      return;
    }
    if (!selectedProjectPath) {
      setSelectedProjectPath(selectableProjects[0].path);
    }
  }, [
    open,
    cwdMode,
    selectableProjects,
    selectedProjectPath,
    defaultProjectPath,
    setCwdMode,
    setSelectedProjectPath,
  ]);

  // ── Clear provisioning error on open ─────────────────────────────────
  useEffect(() => {
    if (open && bindProject) clearProvisioningError?.(bindProject);
  }, [open, clearProvisioningError, bindProject]);

  // ── Reset state on close ─────────────────────────────────────────────
  const resetState = () => {
    setLocalError(null);
    setFieldErrors({});
    setIsSubmitting(false);
    setConflictDismissed(false);
    setSelectedProviderRef(null);
    setManualBindProject('');
    setBindProjectManuallyEdited(false);
    setCreatedTeamName(null);
    setStep('name');
  };

  // Every close path (overlay click, ✕, 取消) clears the persisted draft so a
  // stale restored name can never seed a duplicate create on reopen.
  const handleClose = () => {
    clearDraft();
    resetState();
    onClose();
  };

  const buildCreateRequest = (): TeamCreateRequest => ({
    teamName: normalizedBindProject,
    bindProject: normalizedBindProject,
    displayName: teamName.trim(),
    description: description.trim() || undefined,
    color: teamColor || undefined,
    members: [],
    cwd: effectiveCwd,
    executionTarget: { type: 'local', cwd: effectiveCwd || undefined },
    harness: selectedHarness,
    platform: 'bridge',
    platformOptions: {},
    providerRefs: selectedProviderRef ? [selectedProviderRef] : undefined,
  });

  const validateCreateFields = (): boolean => {
    if (!teamName.trim()) {
      setLocalError('请输入数字员工名称');
      return false;
    }
    if (isDisplayNameTaken) {
      setLocalError('该名称已存在，请换一个');
      return false;
    }
    if (!normalizedBindProject) {
      setLocalError('请输入项目标识');
      return false;
    }
    if (!isValidBindProject(normalizedBindProject)) {
      setLocalError(
        '项目标识为必填，只能包含小写英文字母、数字、连字符和下划线，且必须以字母或数字开头'
      );
      return false;
    }
    if (isNameProvisioning) {
      setLocalError('数字员工正在启动中');
      return false;
    }
    if (isBindProjectTaken) {
      setLocalError(`项目标识"${normalizedBindProject}"已存在，请换一个`);
      return false;
    }
    if (!effectiveCwd) {
      setLocalError('请选择工作目录');
      return false;
    }
    return true;
  };

  const createLocalTeam = async (): Promise<boolean> => {
    if (!validateCreateFields()) return false;

    setFieldErrors({});
    setLocalError(null);
    setIsSubmitting(true);

    try {
      const request = buildCreateRequest();
      await onCreate(request);
      // Capture the slug that was actually persisted. The done step opens /
      // surfaces errors for THIS team; the live `bindProject` would drift to a
      // different id once the parent list refreshes (see createdTeamName note).
      setCreatedTeamName(request.teamName);
      // Advance to the success step in the SAME synchronous block as the
      // `finally` that releases isSubmitting. The create just added this name
      // to the parent's existingDisplayNames; if the name step re-rendered
      // with isSubmitting already false, `showDisplayNameTaken` would trip on
      // the just-created name for one frame — the false "该名称已存在"
      // red-box flicker right before the success screen. Setting 'done' here
      // (no await between it and the finally) batches with
      // setIsSubmitting(false), so the name step is unmounted atomically and
      // that transition window never opens.
      setStep('done');
      return true;
    } catch {
      // error shown via provisioningErrorsByTeam
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreate = async () => {
    await createLocalTeam();
  };

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) handleClose();
      }}
    >
      <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl sm:w-[40rem]">
        <DialogHeader>
          <DialogTitle className="text-sm">创建数字员工</DialogTitle>
          <DialogDescription className="text-xs">
            {step === 'name' && '设置数字员工名称、Agent 类型和工作目录'}
            {step === 'done' && '数字员工创建完成'}
          </DialogDescription>
        </DialogHeader>

        {conflictingTeam && !conflictDismissed ? (
          <div
            className="rounded-md border p-3 text-xs"
            style={{
              backgroundColor: 'var(--warning-bg)',
              borderColor: 'var(--warning-border)',
              color: 'var(--warning-text)',
            }}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium">
                  该工作目录下已有数字员工&quot;{conflictingTeam.displayName}&quot;正在运行
                </p>
                <p className="opacity-80">在同一目录同时运行两个数字员工存在风险。</p>
              </div>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
                onClick={() => setConflictDismissed(true)}
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>
        ) : null}

        {/* ── Step 1: Name + Harness + Work Dir ── */}
        {step === 'name' && (
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="team-name">数字员工名称 *</Label>
              <Input
                id="team-name"
                required
                className={cn(
                  'h-8 text-xs',
                  (fieldErrors.teamName || showDisplayNameTaken) &&
                    'border-[var(--field-error-border)]'
                )}
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="例如：产品助手 / 前端工程师"
                autoFocus
              />
              {isNameProvisioning && (
                <p className="text-[11px]" style={{ color: 'var(--warning-text)' }}>
                  同名数字员工正在启动中
                </p>
              )}
              {showDisplayNameTaken && (
                <p className="text-[11px] text-red-400">该名称已存在，请换一个</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="team-bind-project">项目标识 *</Label>
              <Input
                id="team-bind-project"
                required
                className={cn(
                  'h-8 font-mono text-xs',
                  (isBindProjectTaken || isBindProjectFormatInvalid) &&
                    'border-[var(--field-error-border)]'
                )}
                value={bindProject}
                onChange={(e) => {
                  setManualBindProject(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''));
                  setBindProjectManuallyEdited(true);
                }}
                placeholder="auto-generated-id"
              />
              {isBindProjectFormatInvalid && (
                <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
                  项目标识只能包含小写英文、数字、连字符和下划线，且必须以字母或数字开头
                </p>
              )}
              {isNameProvisioning && (
                <p className="text-[11px]" style={{ color: 'var(--warning-text)' }}>
                  该项目标识正在创建中
                </p>
              )}
              {isBindProjectTaken && (
                <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
                  该项目标识已存在
                </p>
              )}
              <p className="text-[11px] text-[var(--color-text-muted)]">
                用于 URL 路由和 cc-connect 项目绑定，仅限小写英文/数字/连字符
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="team-harness">Agent 类型</Label>
              <HarnessSelect
                id="team-harness"
                value={selectedHarness}
                onChange={(nextHarness) => {
                  harnessSelectionTouched.current = true;
                  setSelectedHarness(nextHarness);
                }}
                className="w-full"
              />
            </div>

            <ProjectPathSelector
              cwdMode={cwdMode}
              onCwdModeChange={setCwdMode}
              selectedProjectPath={selectedProjectPath}
              onSelectedProjectPathChange={setSelectedProjectPath}
              customCwd={customCwd}
              onCustomCwdChange={setCustomCwd}
              projects={selectableProjects}
              projectsLoading={projectsLoading}
              projectsError={projectsError}
              fieldError={fieldErrors.cwd}
            />

            {/* Provider selection */}
            <div className="rounded-lg border border-[var(--color-border-subtle)] bg-white/[0.02] p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-[var(--color-text)]">Provider（可选）</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                    留空时使用本机 {AGENT_TYPE_LABELS[selectedHarness] ?? selectedHarness}{' '}
                    默认配置和登录状态。 只有需要给该团队指定模型供应商时，才绑定下面的全局
                    Provider。
                  </p>
                </div>
                {selectedProviderRef ? (
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-white/5"
                    onClick={() => setSelectedProviderRef(null)}
                  >
                    使用本机默认
                  </button>
                ) : null}
              </div>

              <div className="mt-3 space-y-2">
                {compatibleProviders.length > 0 ? (
                  compatibleProviders.map((provider) => {
                    const checked = selectedProviderRef === provider.name;
                    const endpoint =
                      provider.endpoints?.[selectedHarness] ?? provider.base_url ?? '默认端点';
                    const model =
                      provider.agent_models?.[selectedHarness] ??
                      provider.model ??
                      provider.models?.[0]?.model ??
                      '未指定模型';
                    return (
                      <button
                        key={provider.name}
                        type="button"
                        onClick={() => selectProviderRef(provider.name)}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                          checked
                            ? 'shadow-[var(--color-accent-glow)]/20 border-[var(--color-accent-border)] bg-[var(--color-accent-muted)] shadow-sm'
                            : 'border-[var(--color-border-subtle)] bg-black/10 hover:border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium text-[var(--color-text)]">
                              {provider.name}
                            </p>
                            <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
                              {model} · {endpoint}
                            </p>
                          </div>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                              checked
                                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                                : 'bg-white/5 text-[var(--color-text-muted)]'
                            }`}
                          >
                            {checked ? '已绑定' : '可绑定'}
                          </span>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]">
                    暂无适用于 {AGENT_TYPE_LABELS[selectedHarness] ?? selectedHarness} 的全局
                    Provider。 可先在「设置 → Harness 配置」中添加；不添加也会使用本机默认登录态。
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: Done ── */}
        {step === 'done' && (
          <div className="space-y-4 py-4">
            <div className="flex flex-col items-center gap-3 py-4">
              <CheckCircle2 size={48} className="text-green-500" />
              <p className="text-sm font-medium text-green-700 dark:text-green-400">
                数字员工已创建成功！
              </p>
              <p className="text-center text-xs text-gray-500">
                已在本机创建。外部渠道绑定可稍后在详情页完成。
              </p>
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <DialogFooter className="pt-4 sm:justify-between">
          <div className="min-w-0">
            {localError && (
              <p
                className="rounded border p-2 text-xs"
                style={{
                  color: 'var(--field-error-text)',
                  borderColor: 'var(--field-error-border)',
                  backgroundColor: 'var(--field-error-bg)',
                }}
              >
                {localError}
              </p>
            )}
            {provisioningErrorsByTeam[openTeamSlug] && (
              <p
                className="mt-1 rounded border p-2 text-xs"
                style={{
                  color: 'var(--field-error-text)',
                  borderColor: 'var(--field-error-border)',
                  backgroundColor: 'var(--field-error-bg)',
                }}
              >
                {provisioningErrorsByTeam[openTeamSlug]}
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {step === 'done' ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    clearDraft();
                    resetState();
                    onClose();
                  }}
                >
                  关闭
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    onOpenTeam(openTeamSlug, effectiveCwd || undefined, {
                      displayName: teamName.trim() || undefined,
                    });
                    clearDraft();
                    resetState();
                    onClose();
                  }}
                >
                  打开数字员工
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={handleClose}>
                  取消
                </Button>
                <Button
                  size="sm"
                  className="border border-indigo-500 bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 disabled:bg-indigo-600 disabled:text-white disabled:opacity-80"
                  disabled={
                    !teamName.trim() ||
                    !normalizedBindProject ||
                    !effectiveCwd ||
                    isBindProjectFormatInvalid ||
                    isBindProjectTaken ||
                    showDisplayNameTaken ||
                    isNameProvisioning ||
                    isSubmitting
                  }
                  onClick={handleCreate}
                >
                  {isSubmitting ? '创建中...' : '创建数字员工'}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
