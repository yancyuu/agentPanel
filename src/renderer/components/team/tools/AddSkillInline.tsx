/**
 * AddSkillInline — inline compact form for adding a skill.
 * Opens the existing SkillEditorDialog in create mode.
 */

import { useState } from 'react';

import { SkillEditorDialog } from '@renderer/components/extensions/skills/SkillEditorDialog';
import { Button } from '@renderer/components/ui/button';

interface AddSkillInlineProps {
  projectPath: string | null;
  projectLabel?: string | null;
  onAdded: () => void;
  onCancel: () => void;
}

export const AddSkillInline = ({
  projectPath,
  projectLabel,
  onAdded,
  onCancel,
}: AddSkillInlineProps): React.JSX.Element => {
  const [editorOpen, setEditorOpen] = useState(true);

  const handleClose = () => {
    setEditorOpen(false);
    onCancel();
  };

  const handleSaved = () => {
    setEditorOpen(false);
    onAdded();
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 text-xs"
        onClick={() => setEditorOpen(true)}
      >
        创建新 Skill
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 text-xs">
        取消
      </Button>

      <SkillEditorDialog
        open={editorOpen}
        onClose={handleClose}
        onSaved={handleSaved}
        mode="create"
        projectPath={projectPath ?? null}
        projectLabel={projectLabel ?? null}
        detail={null}
      />
    </div>
  );
};
