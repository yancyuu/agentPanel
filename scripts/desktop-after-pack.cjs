const { execFileSync } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, readdirSync, rmSync } = require('node:fs');
const path = require('node:path');

const ARCH_NAMES = {
  0: 'ia32',
  1: 'amd64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
};

function platformResourcesDirectory(context) {
  if (context.electronPlatformName === 'darwin') {
    const appBundle = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`
    );
    return {
      appBundle,
      resourcesDirectory: path.join(appBundle, 'Contents', 'Resources', 'agentpanel'),
    };
  }
  return {
    appBundle: null,
    resourcesDirectory: path.join(context.appOutDir, 'resources', 'agentpanel'),
  };
}

function bundledBridgeTarget(context) {
  const platform =
    context.electronPlatformName === 'win32' ? 'windows' : context.electronPlatformName;
  const architecture = ARCH_NAMES[context.arch] || String(context.arch);
  return `${platform}-${architecture}`;
}

module.exports = async function desktopAfterPack(context) {
  const source = path.join(
    context.packager.projectDir,
    'desktop-runtime',
    'agentpanel',
    'node_modules'
  );
  if (!existsSync(source)) throw new Error(`Desktop runtime dependencies are missing: ${source}`);

  const { appBundle, resourcesDirectory } = platformResourcesDirectory(context);
  const target = path.join(resourcesDirectory, 'node_modules');
  mkdirSync(resourcesDirectory, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true, dereference: false });
  console.log(`[desktop:afterPack] copied production dependencies -> ${target}`);

  const vendorRoot = path.join(resourcesDirectory, 'vendor', 'cc-connect');
  const keepTarget = bundledBridgeTarget(context);
  const binaryName = context.electronPlatformName === 'win32' ? 'cc-connect.exe' : 'cc-connect';
  const bundledBinary = path.join(vendorRoot, keepTarget, binaryName);
  if (!existsSync(bundledBinary)) {
    throw new Error(`Desktop runtime is missing bundled cc-connect binary: ${bundledBinary}`);
  }
  for (const entry of readdirSync(vendorRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== keepTarget) {
      rmSync(path.join(vendorRoot, entry.name), { recursive: true, force: true });
    }
  }
  console.log(`[desktop:afterPack] kept cc-connect target ${keepTarget}`);

  const clipboardTargets = {
    'darwin-amd64': 'clipboard-darwin-x64',
    'darwin-arm64': 'clipboard-darwin-arm64',
    'windows-amd64': 'clipboard-win32-x64-msvc',
    'windows-arm64': 'clipboard-win32-arm64-msvc',
    'linux-amd64': 'clipboard-linux-x64-gnu',
    'linux-arm64': 'clipboard-linux-arm64-gnu',
  };
  const clipboardRoot = path.join(resourcesDirectory, 'node_modules', '@mariozechner');
  const keepClipboard = clipboardTargets[keepTarget];
  if (keepClipboard && existsSync(clipboardRoot)) {
    for (const entry of readdirSync(clipboardRoot, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        entry.name.startsWith('clipboard-') &&
        entry.name !== keepClipboard
      ) {
        rmSync(path.join(clipboardRoot, entry.name), { recursive: true, force: true });
      }
    }
    if (!existsSync(path.join(clipboardRoot, keepClipboard))) {
      throw new Error(`Desktop runtime is missing native clipboard target: ${keepClipboard}`);
    }
    console.log(`[desktop:afterPack] kept native clipboard target ${keepClipboard}`);
  }

  if (context.electronPlatformName === 'darwin' && appBundle) {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle], {
      stdio: 'inherit',
    });
    console.log(`[desktop:afterPack] applied local ad-hoc signature -> ${appBundle}`);
  }
};
