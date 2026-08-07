#!/usr/bin/env node

// Canonical AgentPanel entry point. The legacy hermit.mjs implementation remains
// available so existing installations and automation continue to work.
await import('./hermit.mjs');
