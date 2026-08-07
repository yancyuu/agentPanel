/**
 * CapabilityPackDetailDialog — drill into a capability pack to see the actual
 * commands, skills, workflows, cron jobs and MCP servers it ships (not just counts).
 */

import { Badge } from '@renderer/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

import type { LoadedCapabilityPack } from '@shared/types/extensions';

interface CapabilityPackDetailDialogProps {
  pack: LoadedCapabilityPack | null;
  open: boolean;
  onClose: () => void;
}

const SectionBlock = ({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}): React.JSX.Element => {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">
          {label}
        </h3>
        <span className="text-[11px] text-text-muted">{count} 项</span>
      </div>
      {count > 0 ? (
        <div className="space-y-1.5">{children}</div>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-text-muted">
          无
        </p>
      )}
    </section>
  );
};

const ItemRow = ({
  primary,
  secondary,
  badges,
}: {
  primary: string;
  secondary?: string;
  badges?: React.ReactNode;
}): React.JSX.Element => {
  return (
    <div className="bg-surface/40 flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-xs font-medium text-text">{primary}</p>
        {secondary ? (
          <p className="truncate text-[11px] text-text-muted" title={secondary}>
            {secondary}
          </p>
        ) : null}
      </div>
      {badges ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">{badges}</div>
      ) : null}
    </div>
  );
};

export const CapabilityPackDetailDialog = ({
  pack,
  open,
  onClose,
}: CapabilityPackDetailDialogProps): React.JSX.Element => {
  const manifest = pack?.manifest;
  const commands = manifest?.capabilities.commands ?? [];
  const skills = manifest?.capabilities.skills ?? [];
  const workflows = manifest?.capabilities.workflows ?? [];
  const cronJobs = manifest?.capabilities.cron ?? [];
  const mcpServers = manifest?.capabilities.mcpServers ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {pack && manifest ? (
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle className="truncate">{manifest.name}</DialogTitle>
              <Badge variant="outline" className="text-[11px]">
                {pack.source === 'builtin'
                  ? 'Official'
                  : manifest.id === 'local-capabilities-global' ||
                      manifest.tags?.includes('global') === true
                    ? 'Global'
                    : pack.source === 'local'
                      ? 'Project'
                      : 'Imported'}
              </Badge>
              {manifest.teamName ? (
                <Badge variant="secondary" className="text-[11px]">
                  团队：{manifest.teamName}
                </Badge>
              ) : null}
              <Badge variant="outline" className="text-[11px] text-text-muted">
                v{manifest.version}
              </Badge>
            </div>
            {manifest.description ? (
              <DialogDescription className="mt-1">{manifest.description}</DialogDescription>
            ) : null}
          </DialogHeader>

          <div className="space-y-4">
            <SectionBlock label="Commands" count={commands.length}>
              {commands.map((cmd) => (
                <ItemRow
                  key={cmd.id}
                  primary={cmd.title}
                  secondary={`/${manifest.namespace}:${cmd.alias}`}
                  badges={
                    <Badge variant="outline" className="text-[10px]">
                      {cmd.safety}
                    </Badge>
                  }
                />
              ))}
            </SectionBlock>

            <SectionBlock label="Skills" count={skills.length}>
              {skills.map((skill) => (
                <ItemRow
                  key={skill.id}
                  primary={skill.name}
                  secondary={skill.description ?? skill.path}
                />
              ))}
            </SectionBlock>

            <SectionBlock label="Workflows" count={workflows.length}>
              {workflows.map((workflow) => (
                <ItemRow
                  key={workflow.id}
                  primary={workflow.name}
                  secondary={workflow.description ?? workflow.path}
                />
              ))}
            </SectionBlock>

            <SectionBlock label="定时任务 (Cron)" count={cronJobs.length}>
              {cronJobs.map((job) => (
                <ItemRow
                  key={job.id}
                  primary={job.name}
                  secondary={job.cronExpression}
                  badges={
                    <>
                      {job.teamName ? (
                        <Badge variant="outline" className="text-[10px]">
                          {job.teamName}
                        </Badge>
                      ) : null}
                      {job.enabled ? (
                        <Badge className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-400">
                          启用
                        </Badge>
                      ) : (
                        <Badge className="border-border text-[10px] text-text-muted">停用</Badge>
                      )}
                    </>
                  }
                />
              ))}
            </SectionBlock>

            <SectionBlock label="MCP 服务" count={mcpServers.length}>
              {mcpServers.map((server) => (
                <ItemRow
                  key={server.id}
                  primary={server.name}
                  secondary={server.transport ?? server.scope}
                  badges={
                    <Badge variant="outline" className="text-[10px]">
                      {server.scope}
                    </Badge>
                  }
                />
              ))}
            </SectionBlock>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};
