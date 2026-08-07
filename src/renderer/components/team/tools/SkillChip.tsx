/**
 * SkillChip — compact chip for a skill.
 * Shows skill name, scope badge, and remove button on hover.
 */

import { X } from 'lucide-react';

import type { SkillCatalogItem } from '@shared/types/extensions';

interface SkillChipProps {
  skill: SkillCatalogItem;
  onRemove: (skill: SkillCatalogItem) => void;
}

export const SkillChip = ({ skill, onRemove }: SkillChipProps): React.JSX.Element => {
  return (
    <div className="group inline-flex items-center gap-1.5 rounded-full bg-[var(--color-bg-secondary)] px-2.5 py-1 text-xs transition-colors hover:bg-[var(--color-bg-secondary-hover)]">
      <span className="max-w-[120px] truncate text-[var(--color-text)]">{skill.name}</span>
      {skill.scope && (
        <span className="rounded bg-indigo-500/20 px-1 py-0.5 text-[10px] text-indigo-400">
          {skill.scope === 'project' ? '项目' : '用户'}
        </span>
      )}
      <button
        type="button"
        className="shrink-0 rounded-full p-0.5 opacity-0 transition-opacity hover:bg-red-500/20 group-hover:opacity-100"
        onClick={() => onRemove(skill)}
        aria-label={`从当前团队禁用 ${skill.name}`}
        title="从当前团队禁用"
      >
        <X size={10} className="text-[var(--color-text-muted)] hover:text-red-400" />
      </button>
    </div>
  );
};
