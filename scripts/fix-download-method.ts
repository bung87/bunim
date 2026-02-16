#!/usr/bin/env bun
/**
 * Script to change downloadMethod from "http" to "git" in nimblemeta.json files
 */

import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join } from 'path';
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
 * Change downloadMethod from "http" to "git" in a nimblemeta.json file
 */
async function fixDownloadMethod(filePath: string, dryRun: boolean = false): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf8');
    const metaFile: NimbleMetaFile = JSON.parse(content);

    if (metaFile.metaData.downloadMethod === 'git') {
      Logger.info(`  ✓ Already set to 'git': ${filePath}`);
      return false;
    }

    if (metaFile.metaData.downloadMethod === 'http') {
      Logger.info(`  ✗ Found 'http', changing to 'git': ${filePath}`);

      if (dryRun) {
        Logger.info(`  [DRY RUN] Would change downloadMethod to 'git'`);
        return true;
      }

      metaFile.metaData.downloadMethod = 'git';
      await writeFile(filePath, JSON.stringify(metaFile, null, 2));
      Logger.info(`  ✓ Changed downloadMethod to 'git'`);
      return true;
    }

    Logger.warn(`  ? Unknown downloadMethod: ${metaFile.metaData.downloadMethod}`);
    return false;
  } catch (error) {
    Logger.error(`  ✗ Failed to process ${filePath}:`, error);
    return false;
  }
}

/**
 * Get all package directories in the packages directory
 */
async function getPackageDirs(packagesDir: string): Promise<string[]> {
  const dirs: string[] = [];

  try {
    await access(packagesDir);
  } catch {
    Logger.error(`Packages directory does not exist: ${packagesDir}`);
    return dirs;
  }

  const entries = await readdir(packagesDir);

  for (const entry of entries) {
    const fullPath = join(packagesDir, entry);
    const metaPath = join(fullPath, 'nimblemeta.json');

    try {
      await access(metaPath);
      dirs.push(fullPath);
    } catch {
      // No nimblemeta.json, skip
    }
  }

  return dirs;
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

  const packageDirs = await getPackageDirs(packagesDir);
  Logger.info(`Found ${packageDirs.length} packages with nimblemeta.json\n`);

  let fixed = 0;
  let skipped = 0;
  let failed = 0;

  for (const pkgDir of packageDirs) {
    const metaPath = join(pkgDir, 'nimblemeta.json');
    try {
      const wasFixed = await fixDownloadMethod(metaPath, dryRun);
      if (wasFixed) {
        fixed++;
      } else {
        skipped++;
      }
    } catch (error) {
      Logger.error(`Failed to process ${pkgDir}:`, error);
      failed++;
    }
  }

  Logger.info(`\n========================================`);
  Logger.info(`Summary:`);
  Logger.info(`  Total packages: ${packageDirs.length}`);
  Logger.info(`  Fixed (http -> git): ${fixed}`);
  Logger.info(`  Skipped (already git): ${skipped}`);
  Logger.info(`  Failed: ${failed}`);
  Logger.info(`========================================`);
}

main().catch(error => {
  Logger.error('Script failed:', error);
  process.exit(1);
});
