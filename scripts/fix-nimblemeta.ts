#!/usr/bin/env bun
/**
 * Temporary script to fix packages without nimblemeta.json
 * This script scans installed packages and creates missing nimblemeta.json files
 */

import { readdir, stat, access, writeFile } from 'node:fs/promises';
import { join, basename } from 'path';
import os from 'os';
import { NimbleParser } from '../src/parser/nimbleParser';
import { findNimbleFile } from '../src/utils/nimbleUtils';
import { calculateDirSha1Checksum } from '../src/utils/checksums';
import { saveMetaData, createPackageMetaData, DownloadMethod } from '../src/utils/nimblemeta';
import { Logger } from '../src/utils/logger';

interface PackageInfo {
  name: string;
  version: string;
  checksum: string;
  path: string;
  nimbleFile?: string;
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
 * Get all installed packages in the packages directory
 */
async function getInstalledPackages(packagesDir: string): Promise<PackageInfo[]> {
  const packages: PackageInfo[] = [];

  try {
    await access(packagesDir);
  } catch {
    Logger.error(`Packages directory does not exist: ${packagesDir}`);
    return packages;
  }

  const entries = await readdir(packagesDir);

  for (const entry of entries) {
    const fullPath = join(packagesDir, entry);
    const stats = await stat(fullPath);

    if (stats.isDirectory()) {
      const parsed = parsePackageDirName(entry);
      if (parsed) {
        const nimbleFile = await findNimbleFile(fullPath);
        packages.push({
          name: parsed.name,
          version: parsed.version,
          checksum: parsed.checksum,
          path: fullPath,
          nimbleFile: nimbleFile || undefined
        });
      }
    }
  }

  return packages;
}

/**
 * Check if a package has nimblemeta.json
 */
async function hasNimbleMeta(packagePath: string): Promise<boolean> {
  try {
    await access(join(packagePath, 'nimblemeta.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of all files in a directory recursively
 */
async function getAllFiles(dir: string, basePath: string = ''): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(join(dir, entry.name), relativePath);
      files.push(...subFiles);
    } else if (entry.isFile() && entry.name !== 'nimblemeta.json') {
      files.push(relativePath);
    }
  }

  return files;
}

/**
 * Try to extract URL from nimble file or use a default
 */
async function extractUrl(nimbleFile: string, packageName: string): Promise<string> {
  try {
    const pkg = await NimbleParser.parseFile(nimbleFile);
    // Try to construct GitHub URL from common patterns
    // This is a best-effort approach since we don't have the original URL
    if (pkg.name) {
      return `https://github.com/nim-lang/${packageName}`;
    }
  } catch {
    // Ignore parsing errors
  }
  return `https://github.com/unknown/${packageName}`;
}

/**
 * Fix a single package by creating nimblemeta.json
 */
async function fixPackage(pkg: PackageInfo, dryRun: boolean = false): Promise<boolean> {
  Logger.info(`Processing: ${pkg.name}@${pkg.version}`);

  if (await hasNimbleMeta(pkg.path)) {
    Logger.info(`  ✓ Already has nimblemeta.json, skipping`);
    return false;
  }

  Logger.info(`  ✗ Missing nimblemeta.json`);

  if (dryRun) {
    Logger.info(`  [DRY RUN] Would create nimblemeta.json`);
    return true;
  }

  try {
    // Get list of files
    const files = await getAllFiles(pkg.path);
    Logger.info(`  Found ${files.length} files`);

    // Try to get URL from nimble file
    const url = pkg.nimbleFile
      ? await extractUrl(pkg.nimbleFile, pkg.name)
      : `https://github.com/unknown/${pkg.name}`;

    // Since we don't know the original download method, default to 'http'
    // (most packages are installed via tar.gz download)
    const downloadMethod: DownloadMethod = 'http';

    // Create metadata
    const metaData = createPackageMetaData(
      url,
      downloadMethod,
      pkg.checksum,
      files,
      [], // binaries
      []  // specialVersions
    );

    // Save nimblemeta.json
    await saveMetaData(metaData, pkg.path);
    Logger.info(`  ✓ Created nimblemeta.json`);
    return true;
  } catch (error) {
    Logger.error(`  ✗ Failed to fix package:`, error);
    return false;
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
    Logger.info('Running in DRY RUN mode (no changes will be made)');
  }

  const packages = await getInstalledPackages(packagesDir);
  Logger.info(`Found ${packages.length} installed packages\n`);

  let fixed = 0;
  let skipped = 0;
  let failed = 0;

  for (const pkg of packages) {
    try {
      const wasFixed = await fixPackage(pkg, dryRun);
      if (wasFixed) {
        fixed++;
      } else {
        skipped++;
      }
    } catch (error) {
      Logger.error(`Failed to process ${pkg.name}:`, error);
      failed++;
    }
  }

  Logger.info(`\n========================================`);
  Logger.info(`Summary:`);
  Logger.info(`  Total packages: ${packages.length}`);
  Logger.info(`  Fixed/Created: ${fixed}`);
  Logger.info(`  Skipped (already has nimblemeta.json): ${skipped}`);
  Logger.info(`  Failed: ${failed}`);
  Logger.info(`========================================`);
}

main().catch(error => {
  Logger.error('Script failed:', error);
  process.exit(1);
});
