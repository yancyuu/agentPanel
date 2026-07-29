import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('TeamDetailView collaboration surface contract', () => {
  it('keeps the member roster and operational sections mounted in the team page', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/team/TeamDetailView.tsx'),
      'utf8'
    );

    expect(source).toContain('title="成员与 Agent"');
    expect(source).toContain('<TeamMemberListBridge');
    expect(source).toContain('title="高级诊断"');
    expect(source).toContain('<CcSessionsSection');
    expect(source).toContain('<ProcessesSection');
    expect(source).not.toContain('title="会话"');
    expect(source).not.toContain('title="指令台"');
    expect(source).not.toContain('<LoopConsolePanel');
    expect(source).toContain('<ReviewDialog');
    expect(source).toContain('<TeamMemberDetailDialogBridge');
    expect(source).toContain('<TeamProvisioningBanner');
  });
});
