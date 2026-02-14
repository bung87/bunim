
import { rm, access, readdir, stat } from 'node:fs/promises';
import { join } from 'path';
import os from 'os';
import { Logger } from '../utils/logger';

export interface PackageInfo {
  name: string;
  version: string;
  path: string;
  commitHash?: string;
}

export class PackageDeduper {
  private packagesDir: string;

  constructor(packagesDir?: string) {
    this.packagesDir = packagesDir || join(os.homedir(), '.nimble', 'pkgs2');
  }

  /**
   * Scan all installed packages and group them by name
   */
  private async scanPackages(): Promise<Map<string, PackageInfo[]>> {
    const packages = new Map<string, PackageInfo[]>();
    
    try {
      await access(this.packagesDir);
    } catch {
      Logger.warn(`Packages directory does not exist: ${this.packagesDir}`);
      return packages;
    }

    try {
      const entries = await readdir(this.packagesDir);
      
      for (const entry of entries) {
        const fullPath = join(this.packagesDir, entry);
        const entryStat = await stat(fullPath);
        
        if (entryStat.isDirectory()) {
          // Parse package name and version from directory name
          // Format: packageName-version-commitHash or packageName-version
          const match = entry.match(/^([^-]+)-([^-]+)(?:-(.+))?$/);
          
          if (match) {
            const [, name, version, commitHash] = match;
            
            if (!packages.has(name)) {
              packages.set(name, []);
            }
            
            packages.get(name)!.push({
              name,
              version,
              path: fullPath,
              commitHash
            });
          } else {
            Logger.warn(`Could not parse package info from directory: ${entry}`);
          }
        }
      }
    } catch (error) {
      Logger.error(`Error scanning packages directory: ${error}`);
    }

    return packages;
  }

  /**
   * Find the highest version among multiple package versions
   */
  private findHighestVersion(packages: PackageInfo[]): PackageInfo {
    return packages.reduce((highest, current) => {
      return Bun.semver.order(current.version, highest.version) > 0 ? current : highest;
    });
  }

  /**
   * Analyze packages and determine which ones to remove
   */
  async analyze(): Promise<{ packagesToKeep: PackageInfo[], packagesToRemove: PackageInfo[] }> {
    const packages = await this.scanPackages();
    const packagesToKeep: PackageInfo[] = [];
    const packagesToRemove: PackageInfo[] = [];

    for (const [name, versions] of packages) {
      if (versions.length <= 1) {
        // Only one version, keep it
        packagesToKeep.push(...versions);
        continue;
      }

      // Multiple versions - find the highest one to keep
      const highestVersion = this.findHighestVersion(versions);
      packagesToKeep.push(highestVersion);

      // Mark other versions for removal
      const olderVersions = versions.filter(pkg => pkg !== highestVersion);
      packagesToRemove.push(...olderVersions);

      Logger.info(`Package ${name}: keeping ${highestVersion.version}, removing ${olderVersions.length} older version(s)`);
    }

    return { packagesToKeep, packagesToRemove };
  }

  /**
   * Perform the actual deduplication
   */
  async dedupe(dryRun: boolean = false): Promise<void> {
    Logger.info(`Scanning packages in ${this.packagesDir}...`);
    
    const { packagesToKeep, packagesToRemove } = await this.analyze();

    if (packagesToRemove.length === 0) {
      Logger.info('No duplicate packages found. Nothing to dedupe.');
      return;
    }

    Logger.info(`\nFound ${packagesToRemove.length} duplicate package(s) to remove:`);
    for (const pkg of packagesToRemove) {
      Logger.info(`  - ${pkg.name}@${pkg.version} at ${pkg.path}`);
    }

    Logger.info(`\nWill keep ${packagesToKeep.length} package(s):`);
    for (const pkg of packagesToKeep) {
      Logger.info(`  - ${pkg.name}@${pkg.version} at ${pkg.path}`);
    }

    if (dryRun) {
      Logger.info('\n[Dry run] No packages were actually removed.');
      return;
    }

    Logger.info('\nRemoving duplicate packages...');
    
    for (const pkg of packagesToRemove) {
      try {
        Logger.info(`Removing ${pkg.name}@${pkg.version}...`);
        await rm(pkg.path, { recursive: true, force: true });
        Logger.info(`✓ Removed ${pkg.path}`);
      } catch (error) {
        Logger.error(`Failed to remove ${pkg.path}: ${error}`);
      }
    }

    Logger.info(`\nDeduplication complete! Removed ${packagesToRemove.length} duplicate package(s).`);
  }
}