import fs from 'node:fs';
import path from 'node:path';

export const LPS_BROWSER_EXTENSION_NAME = 'Life Planner Browser Agent';

function normalizePath(value) {
  if (!value) return '';
  try {
    return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function addChromeProfile(profiles, userDataRoot, profileName) {
  const name = String(profileName || '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') return;
  const candidate = path.resolve(userDataRoot, name);
  const rootPrefix = `${path.resolve(userDataRoot)}${path.sep}`.toLowerCase();
  if (!candidate.toLowerCase().startsWith(rootPrefix) || !fs.existsSync(candidate)) return;
  if (!profiles.some((item) => normalizePath(item) === normalizePath(candidate))) profiles.push(candidate);
}

export function getChromeProfiles(userDataRoot) {
  const profiles = [];
  if (!userDataRoot) return profiles;
  const profileState = readJson(path.join(userDataRoot, 'Local State'))?.profile || {};
  addChromeProfile(profiles, userDataRoot, profileState.last_used);
  for (const name of profileState.last_active_profiles || []) addChromeProfile(profiles, userDataRoot, name);
  for (const name of Object.keys(profileState.info_cache || {})) addChromeProfile(profiles, userDataRoot, name);
  addChromeProfile(profiles, userDataRoot, 'Default');
  try {
    for (const entry of fs.readdirSync(userDataRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^Profile \d+$/i.test(entry.name)) addChromeProfile(profiles, userDataRoot, entry.name);
    }
  } catch {
    // Missing or locked Chrome state means there is no diagnostic result yet.
  }
  return profiles;
}

function manifestIdentity(extensionPath) {
  const manifest = readJson(path.join(extensionPath, 'manifest.json'));
  return manifest ? { name: String(manifest.name || ''), version: String(manifest.version || '') } : null;
}

function isCurrentExtensionCopy(installedPath, currentPath) {
  const installed = manifestIdentity(installedPath);
  const current = manifestIdentity(currentPath);
  if (!installed || !current) return false;
  if (installed.name !== LPS_BROWSER_EXTENSION_NAME || installed.version !== current.version) return false;
  return ['manifest.json', 'background.js'].every((file) => fs.existsSync(path.join(installedPath, file)));
}

export function probeChromeExtension({ userDataRoot, extensionPath }) {
  const profiles = getChromeProfiles(userDataRoot);
  const targetPath = normalizePath(extensionPath);
  const otherBrowserAgentPaths = [];
  let nameMatch = null;

  for (const profilePath of profiles) {
    const settings = readJson(path.join(profilePath, 'Secure Preferences'))?.extensions?.settings;
    if (!settings || typeof settings !== 'object') continue;
    for (const [extensionId, setting] of Object.entries(settings)) {
      if (!setting || typeof setting !== 'object') continue;
      const manifestName = String(setting.manifest?.name || '');
      const rawPath = String(setting.path || '');
      const installedPath = rawPath
        ? (path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(profilePath, 'Extensions', rawPath))
        : '';
      const normalizedInstalled = normalizePath(installedPath);
      const looksLikeLps = manifestName === LPS_BROWSER_EXTENSION_NAME || normalizedInstalled.includes('lps-browser-agent');
      if (!looksLikeLps) continue;

      const exactPathMatch = Boolean(normalizedInstalled && normalizedInstalled === targetPath);
      const result = {
        installedInChrome: true,
        chromeLoaded: Number(setting.state) === 1,
        detectedProfilePath: profilePath,
        installedExtensionId: extensionId,
        installedPath,
        exactPathMatch,
        currentContentMatch: exactPathMatch || isCurrentExtensionCopy(installedPath, extensionPath)
      };
      if (exactPathMatch) return { ...result, otherBrowserAgentPaths };
      if (installedPath && !otherBrowserAgentPaths.some((item) => normalizePath(item) === normalizedInstalled)) {
        otherBrowserAgentPaths.push(installedPath);
      }
      if (!nameMatch && manifestName === LPS_BROWSER_EXTENSION_NAME) nameMatch = result;
    }
  }

  if (nameMatch) return { ...nameMatch, otherBrowserAgentPaths };
  return {
    installedInChrome: false,
    chromeLoaded: false,
    detectedProfilePath: profiles[0] || '',
    installedExtensionId: '',
    installedPath: '',
    exactPathMatch: false,
    currentContentMatch: false,
    otherBrowserAgentPaths
  };
}

export function chromeProfileArgument(userDataRoot, profilePath) {
  const root = normalizePath(userDataRoot);
  const profile = normalizePath(profilePath);
  if (!root || !profile || !profile.startsWith(`${root}${path.sep}`)) return '';
  const relative = path.relative(userDataRoot, profilePath);
  return relative && !relative.includes(path.sep) ? `--profile-directory=${relative}` : '';
}
