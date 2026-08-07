import { scanSessions } from './SessionUsageParser';

import type { UsageCollectionResult } from './usageTypes';

export class SessionUsageCollector {
  async collect(): Promise<UsageCollectionResult> {
    const referenceMs = Date.now();
    return {
      computedAt: new Date(referenceMs).toISOString(),
      referenceMs,
      legacyParseResult: await scanSessions(referenceMs),
    };
  }
}
