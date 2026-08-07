# Feature Specification: UI & Redis Bug Fixes

## Overview

Fix four production bugs affecting the team creation workflow and Redis task bus: Windows runtime dropdown rendering issue, missing harness icons across all selection UIs, runaway Redis health checks when the task bus is disabled, and incorrect Redis connection status reporting.

## Problem Statement

Users on Windows cannot read the runtime/harness dropdown when creating or editing teams — white text on white background makes all options invisible. Across all platforms, harness selection dropdowns lack visual identity (no icons), reducing usability. On the backend, the Redis health check loop runs continuously even when the team bus feature is completely disabled, wasting resources and generating noise. Finally, the Redis connection status indicator shows "connected" even when no local Redis server is running, misleading users about the actual state of the task bus.

## User Scenarios & Testing

### Primary Scenario

A user on Windows opens Hermit, creates a new team, and clicks the runtime/harness dropdown. The dropdown options are legible with proper contrast. Each option shows the harness icon alongside the name. After creating the team, the user opens Settings and sees the correct Redis status — "disabled" or "disconnected" when the bus is off or Redis is unreachable.

### Alternative Scenarios

- A user on macOS/Linux edits an existing team and changes the harness — dropdown shows icons and is fully readable.
- A user enables the team bus in settings without a local Redis server — status correctly shows "disconnected", no background polling occurs.
- A user enables the team bus and Redis is running — status shows "connected", health checks begin.

### Edge Cases

- Redis server goes offline after initial successful connection — status updates to reflect disconnection.
- Team bus is toggled on then off — health check loop stops completely.
- No Redis package installed (optional dependency) — status shows "not available", no crashes.

## Functional Requirements

### FR-1: Windows Dropdown Text Visibility

The runtime/harness dropdown in the team creation and team editing dialogs must render option text with sufficient contrast against the dropdown background on all platforms, including Windows where the default system theme may produce white-on-white rendering.

### FR-2: Harness Icons in All Selection Dropdowns

Every UI element that presents a choice of harness/runtime (team creation dialog, team editing dialog, harness configuration panel, and any other harness selector) must display the corresponding harness icon or logo next to each option's display name.

### FR-3: Conditional Redis Health Checks

The Redis health check / connection monitoring loop must only run when the team bus feature is explicitly enabled by the user. When the team bus is disabled, no Redis connections should be attempted, no health check intervals should be active, and any existing connection should be closed.

### FR-4: Accurate Redis Connection Status

The Redis connection status indicator must accurately reflect the real connection state. It must show "connected" only when a live Redis connection has been verified (e.g., successful PING response). When Redis is unreachable, not running, or the connection has been lost, the status must show "disconnected" or "unavailable" — never a false positive.

## Success Criteria

| ID   | Criterion                                                        | Measure                                                          |
| ---- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| SC-1 | Windows users can read all dropdown options                      | Manual test on Windows: dropdown text visible with good contrast |
| SC-2 | Every harness dropdown shows icons                               | Visual inspection of all 3+ harness selection UIs                |
| SC-3 | No Redis activity when team bus is disabled                      | Process monitor shows zero Redis connections when bus is off      |
| SC-4 | Redis status is accurate                                         | Status matches actual Redis reachability in all 4 states         |

## Assumptions

- Each harness type has a known, available icon (e.g., Claude Code, Codex, or a generic terminal icon for unknown harnesses).
- The Windows rendering issue is caused by insufficient foreground/background color styling on dropdown option elements.
- Redis health check is a periodic PING or connection test that runs on an interval timer.

## Dependencies

- Harness icon assets must be available or derivable from harness metadata.

## Out of Scope

- Adding new harness types or runtimes.
- Changing the Redis connection configuration UI.
- Cross-machine collaboration protocol changes.
