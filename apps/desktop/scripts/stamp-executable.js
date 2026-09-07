'use strict';

/**
 * Put FluentFlow's name and icon on the Windows executable.
 *
 * electron-builder does this itself, with `rcedit`. It cannot do it here:
 * `rcedit-x64.exe` lives inside the `winCodeSign` package, and that archive
 * contains two macOS symlinks (`libcrypto.dylib`, `libssl.dylib`) which 7-Zip
 * cannot create on Windows without SeCreateSymbolicLinkPrivilege — Developer
 * Mode, or an elevated shell. The build fails during extraction, before it ever
 * reaches the resource edit. So `signAndEditExecutable` is off, and the edit
 * happens here instead.
 *
 * Without it the packaged app ships as Electron's: the taskbar and Start menu
 * show the Electron atom, and the file's properties say "Electron, GitHub, Inc.
 * 44.1.1". That is worth fixing on its own, and it matters more than it looks —
 * an unsigned executable that also cannot say what it is gives SmartScreen and
 * the person reading the warning nothing to go on.
 *
 * `resedit` is a PE resource editor in plain JavaScript, so it needs no
 * external binary and no privileges.
 *
 * Signing is a separate matter and still absent; see docs/platform-status.md.
 */

const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const ResEdit = require('resedit');

/** US English, the language Electron's own resources are already filed under. */
const LANGUAGE = 1033;
/** UTF-16, which is what a modern VERSIONINFO string table is. */
const CODEPAGE = 1200;

/** electron-builder's `afterPack` hook. */
module.exports = async function stampExecutable(context) {
  if (context.electronPlatformName !== 'win32') return;

  const { appInfo } = context.packager;
  const executable = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const icon = path.join(context.packager.projectDir, 'build', 'icon.ico');

  const binary = ResEdit.NtExecutable.from(readFileSync(executable), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(binary);

  applyIcon(resources, icon);
  applyVersionInfo(resources, appInfo);

  resources.outputResource(binary);
  writeFileSync(executable, Buffer.from(binary.generate()));

  console.log(`  • stamped ${path.basename(executable)} as ${appInfo.productName} ${appInfo.version}`);
};

/**
 * Replace icon group 1, which is the one Windows shows for the executable.
 *
 * Every size in the `.ico` goes in: Windows picks the nearest entry rather than
 * scaling one, and a taskbar drawn from a 256px source looks like it.
 */
function applyIcon(resources, icoPath) {
  const file = ResEdit.Data.IconFile.from(readFileSync(icoPath));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    1,
    LANGUAGE,
    file.icons.map((entry) => entry.data),
  );
}

function applyVersionInfo(resources, appInfo) {
  const existing = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  const version = existing[0] ?? ResEdit.Resource.VersionInfo.createEmpty();

  // Windows wants four numbers; npm versions have three. The fourth is the
  // build number, and nothing here increments one, so it stays zero.
  const [major, minor, patch] = appInfo.version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  version.setFileVersion(major, minor, patch, 0, LANGUAGE);
  version.setProductVersion(major, minor, patch, 0, LANGUAGE);

  // Every string is set rather than merged over Electron's, because a partial
  // overwrite is how a file ends up called FluentFlow by GitHub, Inc.
  version.setStringValues(
    { lang: LANGUAGE, codepage: CODEPAGE },
    {
      CompanyName: appInfo.companyName ?? '',
      FileDescription: appInfo.description ?? appInfo.productName,
      FileVersion: appInfo.version,
      InternalName: appInfo.productFilename,
      LegalCopyright: appInfo.copyright ?? '',
      OriginalFilename: `${appInfo.productFilename}.exe`,
      ProductName: appInfo.productName,
      ProductVersion: appInfo.version,
    },
  );

  version.outputToResourceEntries(resources.entries);
}
