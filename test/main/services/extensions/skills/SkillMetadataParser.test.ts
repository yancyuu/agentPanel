import { describe, expect, it } from 'vitest';

import { SkillMetadataParser } from '@main/services/extensions/skills/SkillMetadataParser';

function parseSkill(rawContent: string) {
  return new SkillMetadataParser().parseCatalogItem({
    skillDir: '/Users/test/project/.claude/skills/crawler-cli',
    folderName: 'crawler-cli',
    skillFile: '/Users/test/project/.claude/skills/crawler-cli/SKILL.md',
    rawContent,
    modifiedAt: 1_718_900_000,
    flags: { hasScripts: false, hasReferences: false, hasAssets: false },
    root: {
      scope: 'project',
      rootKind: 'claude',
      projectRoot: '/Users/test/project',
      rootPath: '/Users/test/project/.claude/skills',
    },
  });
}

describe('SkillMetadataParser', () => {
  it('recovers flat skill frontmatter when an unquoted description contains a colon', () => {
    const item = parseSkill(`---
name: crawler-cli
description: Use when working with this repository's \`craw\` CLI: profile lifecycle, login, search, extract, local run artifacts, doctor checks, and profile isolation.
---

# craw CLI
`);

    expect(item.isValid).toBe(true);
    expect(item.name).toBe('crawler-cli');
    expect(item.description).toContain('CLI: profile lifecycle');
    expect(item.issues).toContainEqual(
      expect.objectContaining({
        code: 'frontmatter-yaml-recovered',
        severity: 'warning',
      })
    );
  });
});
