import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectorConstructed: vi.fn(),
  collect: vi.fn(),
}));

vi.mock('../SessionUsageCollector', () => ({
  SessionUsageCollector: class {
    constructor() {
      mocks.collectorConstructed();
    }

    collect = mocks.collect;
  },
}));

import { configureUsageTelemetry } from '../UsageTelemetryService';

describe('UsageTelemetryService import ownership', () => {
  it('does not construct the collector until telemetry is explicitly configured', () => {
    expect(mocks.collectorConstructed).not.toHaveBeenCalled();

    configureUsageTelemetry();

    expect(mocks.collectorConstructed).toHaveBeenCalledOnce();
  });
});
