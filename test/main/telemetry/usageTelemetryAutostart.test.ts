import { describe, expect, it } from 'vitest';

import {
  buildUsageTelemetryLaunchdPlist,
  buildUsageTelemetryWindowsTaskXml,
  buildUsageTelemetryWindowsWrapper,
} from '@main/telemetry/autostart';

describe('usage telemetry launchd autostart', () => {
  it('builds a foreground worker plist without daemon wrapper', () => {
    const plist = buildUsageTelemetryLaunchdPlist({
      label: 'com.openhermit.telemetry',
      nodePath: '/usr/local/bin/node',
      cliPath: '/repo/bin/agentcli.mjs',
      hermitHome: '/tmp/hermit-home',
    });

    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>com.openhermit.telemetry</string>');
    expect(plist).toContain('<key>ProgramArguments</key>');
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>/repo/bin/agentcli.mjs</string>');
    expect(plist).toContain('<string>__telemetry-worker</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>ELECTRON_RUN_AS_NODE</key>');
    expect(plist).toContain('<string>1</string>');
    expect(plist).toContain('<key>HERMIT_HOME</key>');
    expect(plist).toContain('<string>/tmp/hermit-home</string>');
    expect(plist).not.toContain('--daemon');
    expect(plist).not.toContain('--upload');
  });

  it('builds a Windows Task Scheduler definition with login start and failure restart', () => {
    const xml = buildUsageTelemetryWindowsTaskXml({
      label: 'com.openhermit.telemetry',
      nodePath: 'C:\\Program Files\\AgentCLI\\node.exe',
      cliPath: 'C:\\Program Files\\AgentCLI\\bin\\agentcli.mjs',
      hermitHome: 'C:\\Users\\tester\\.hermit',
    });

    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<Interval>PT1M</Interval>');
    expect(xml).toContain('<Count>999</Count>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('usage-worker.cmd');
  });

  it('switches cmd.exe to UTF-8 before using non-ASCII Windows paths', () => {
    const wrapper = buildUsageTelemetryWindowsWrapper({
      label: 'com.openhermit.telemetry',
      nodePath: 'C:\\程序文件\\AgentCLI\\node.exe',
      cliPath: 'C:\\程序文件\\AgentCLI\\bin\\agentcli.mjs',
      hermitHome: 'C:\\用户\\测试\\.hermit',
    });

    expect(wrapper).toContain(
      '@echo off\r\nchcp 65001 >nul\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n'
    );
    expect(wrapper).toContain('C:\\用户\\测试\\.hermit');
  });

  it('escapes XML values in plist fields', () => {
    const plist = buildUsageTelemetryLaunchdPlist({
      label: 'com.openhermit.telemetry',
      nodePath: '/usr/local/bin/node',
      cliPath: '/repo & bin/<hermit>.mjs',
      hermitHome: '/tmp/hermit & home/<test>',
    });

    expect(plist).toContain('/repo &amp; bin/&lt;hermit&gt;.mjs');
    expect(plist).toContain('/tmp/hermit &amp; home/&lt;test&gt;');
  });
});
