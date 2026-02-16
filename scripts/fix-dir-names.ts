#!/usr/bin/env bun
/**
 * Script to fix package directory names
 * Renames directories from repo-name to package-name (from nimble file)
 */

import { readFile, readdir, access, rename } from 'node:fs/promises';
import { join, basename } from 'path';
import os from 'os';
import { Logger } from '../src/utils/logger';

interface NimbleMetaFile {
  version: number;
  metaData: {
    url: string;
    downloadMethod: string;
    vcsRevision: string;
    files: string[];
    binaries: string[];
    specialVersions: string[];
  };
}

/**
 * Parse package directory name to extract name, version, and checksum
 * Format: packageName-version-checksum
 */
function parsePackageDirName(dirName: string): { name: string; version: string; checksum: string } | null {
  // Match pattern: name-version-checksum (checksum is 40 char hex)
  const match = dirName.match(/^(.+)-([\d.]+[\w.-]*)-([a-f0-9]{40})$/);
  if (match) {
    return {
      name: match[1],
      version: match[2],
      checksum: match[3]
    };
  }
  return null;
}

/**
 * Read nimblemeta.json to get the correct package name
 */
async function getCorrectPackageName(dirPath: string): Promise<string | null> {
  try {
    const metaPath = join(dirPath, 'nimblemeta.json');
    const content = await readFile(metaPath, 'utf8');
    const metaFile: NimbleMetaFile = JSON.parse(content);
    
    // Extract package name from URL (e.g., https://github.com/owner/repo)
    const url = metaFile.metaData.url;
    const match = url.match(/github\.com\/[^\/]+\/([^\/]+)/);
    if (match) {
      return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the nimble file to get the actual package name
 * Uses the nimble file base name as primary source, with name field as fallback
 */
async function getPackageNameFromNimble(dirPath: string): Promise<string | null> {
  try {
    const entries = await readdir(dirPath);
    const nimbleFile = entries.find(e => e.endsWith('.nimble'));
    if (!nimbleFile) return null;
    
    // Primary: Use nimble file base name (this is what nimble uses)
    const baseName = nimbleFile.replace('.nimble', '');
    
    // Read the nimble file content to verify
    const content = await readFile(join(dirPath, nimbleFile), 'utf8');
    
    // Try to extract name from "name = \"xxx\"" pattern
    const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch) {
      const nameField = nameMatch[1];
      // Only use name field if it's a valid package name (no special characters like $)
      // and matches or is similar to the base name
      if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(nameField)) {
        return nameField;
      }
    }
    
    // Fallback to nimble file base name
    return baseName;
  } catch {
    return null;
  }
}

/**
 * Fix directory names
 */
async function fixDirNames(packagesDir: string, dryRun: boolean = false): Promise<void> {
  try {
    await access(packagesDir);
  } catch {
    Logger.error(`Packages directory does not exist: ${packagesDir}`);
    return;
  }

  const entries = await readdir(packagesDir);
  
  for (const entry of entries) {
    const fullPath = join(packagesDir, entry);
    const parsed = parsePackageDirName(entry);
    
    if (!parsed) continue;
    
    // Get the correct package name from nimble file
    const correctName = await getPackageNameFromNimble(fullPath);
    if (!correctName) {
      Logger.warn(`Could not determine correct name for: ${entry}`);
      continue;
    }
    
    // Check if directory name matches the correct name
    if (parsed.name === correctName) {
      Logger.info(`✓ Already correct: ${entry}`);
      continue;
    }
    
    // Construct new directory name
    const newDirName = `${correctName}-${parsed.version}-${parsed.checksum}`;
    const newPath = join(packagesDir, newDirName);
    
    Logger.info(`✗ Mismatch detected:`);
    Logger.info(`  Current: ${entry}`);
    Logger.info(`  Should be: ${newDirName}`);
    
    if (dryRun) {
      Logger.info(`  [DRY RUN] Would rename to: ${newDirName}`);
      continue;
    }
    
    try {
      await rename(fullPath, newPath);
      Logger.info(`  ✓ Renamed to: ${newDirName}`);
    } catch (error) {
      Logger.error(`  ✗ Failed to rename:`, error);
    }
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const localDeps = args.includes('--localdeps');

  const packagesDir = localDeps
    ? join(process.cwd(), 'nimbledeps', 'pkgs2')
    : join(os.homedir(), '.nimble', 'pkgs2');

  Logger.info(`Scanning ${localDeps ? 'local' : 'global'} packages directory: ${packagesDir}`);
  if (dryRun) {
    Logger.info('Running in DRY RUN mode (no changes will be made)\n');
  }

  await fixDirNames(packagesDir, dryRun);
  
  Logger.info('\nDone!');
}

main().catch(error => {
  Logger.error('Script failed:', error);
  process.exit(1);
});
