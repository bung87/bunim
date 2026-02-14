
import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { Logger } from '../utils/logger';

export interface InstalledPackage {
  name: string;
  version: string;
  path: string;
  commitHash?: string;
  size?: number;
  installDate?: Date;
}

export interface PackageListOptions {
  local?: boolean;
  detailed?: boolean;
  sortBy?: 'name' | 'version' | 'size' | 'date';
}

export class PackageLister {
  private packagesDir: string;

  constructor(packagesDir?: string) {
    this.packagesDir = packagesDir || join(os.homedir(), '.nimble', 'pkgs2');
  }

  /**
   * Scan packages directory and return list of installed packages
   */
  list(options: PackageListOptions = {}): InstalledPackage[] {
    const packages: InstalledPackage[] = [];
    
    try {
      // Check if directory exists using standard Node.js fs
      if (!existsSync(this.packagesDir)) {
        Logger.warn(`Packages directory does not exist: ${this.packagesDir}`);
        return packages;
      }
      
      // Use simple directory reading with standard fs operations
      const entries = readdirSync(this.packagesDir);
      
      for (const entry of entries) {
        const fullPath = join(this.packagesDir, entry);
        
        try {
          // Use standard Node.js fs stats
          const stat = statSync(fullPath);
          
          if (stat.isDirectory()) {
            // Parse package name and version from directory name
            // Format: packageName-version-commitHash or packageName-version
            const match = entry.match(/^([^-]+)-([^-]+)(?:-(.+))?$/);
            
            if (match) {
              const [, name, version, commitHash] = match;
              
              const pkg: InstalledPackage = {
                name,
                version,
                path: fullPath,
                commitHash,
                size: this.calculateDirectorySize(fullPath),
                installDate: stat.mtime
              };
              
              packages.push(pkg);
            } else {
              Logger.warn(`Could not parse package info from directory: ${entry}`);
            }
          }
        } catch (error) {
          Logger.debug(`Error processing ${entry}: ${error}`);
        }
      }

      // Sort packages based on options
      this.sortPackages(packages, options.sortBy || 'name');
      
    } catch (error) {
      Logger.error(`Error listing packages: ${error}`);
    }

    return packages;
  }

  /**
   * Calculate directory size using standard recursive operations
   */
  private calculateDirectorySize(dirPath: string): number {
    let totalSize = 0;
    
    try {
      const entries = readdirSync(dirPath);
      
      for (const entry of entries) {
        const fullPath = join(dirPath, entry);
        
        try {
          const stat = statSync(fullPath);
          
          if (stat.isDirectory()) {
            totalSize += this.calculateDirectorySize(fullPath);
          } else {
            totalSize += stat.size;
          }
        } catch (error) {
          Logger.debug(`Error getting size for ${entry}: ${error}`);
        }
      }
    } catch (error) {
      Logger.debug(`Error calculating size for ${dirPath}: ${error}`);
    }
    
    return totalSize;
  }

  /**
   * Sort packages based on different criteria
   */
  private sortPackages(packages: InstalledPackage[], sortBy: string): void {
    switch (sortBy) {
      case 'name':
        packages.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'version':
        packages.sort((a, b) => Bun.semver.order(a.version, b.version));
        break;
      case 'size':
        packages.sort((a, b) => (b.size || 0) - (a.size || 0));
        break;
      case 'date':
        packages.sort((a, b) => (b.installDate?.getTime() || 0) - (a.installDate?.getTime() || 0));
        break;
      default:
        packages.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  /**
   * Format file size in human readable format
   */
  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Display packages in a formatted table
   */
  display(packages: InstalledPackage[], options: PackageListOptions = {}): void {
    if (packages.length === 0) {
      Logger.info('No packages found.');
      return;
    }

    Logger.info(`Installed packages (${packages.length}):\n`);

    if (options.detailed) {
      // Detailed view with more information
      Logger.info('Package Name          Version    Size     Install Date        Path');
      Logger.info('-------------------- ---------- -------- ------------------- ----------------------------------------');
      
      for (const pkg of packages) {
        const name = pkg.name.padEnd(20);
        const version = pkg.version.padEnd(10);
        const size = this.formatFileSize(pkg.size || 0).padEnd(8);
        const date = pkg.installDate ? pkg.installDate.toLocaleDateString().padEnd(19) : 'Unknown'.padEnd(19);
        const path = pkg.path;
        
        Logger.info(`${name} ${version} ${size} ${date} ${path}`);
      }
    } else {
      // Simple view - show size column when sorting by size
      if (options.sortBy === 'size') {
        Logger.info('Package Name          Version    Size');
        Logger.info('-------------------- ---------- --------');
        
        for (const pkg of packages) {
          const name = pkg.name.padEnd(20);
          const version = pkg.version.padEnd(10);
          const size = this.formatFileSize(pkg.size || 0).padEnd(8);
          
          Logger.info(`${name} ${version} ${size}`);
        }
      } else {
        // Basic view without size
        Logger.info('Package Name          Version');
        Logger.info('-------------------- ----------');
        
        for (const pkg of packages) {
          const name = pkg.name.padEnd(20);
          const version = pkg.version.padEnd(10);
          
          Logger.info(`${name} ${version}`);
        }
      }
    }

    // Summary statistics
    if (packages.length > 0) {
      const totalSize = packages.reduce((sum, pkg) => sum + (pkg.size || 0), 0);
      Logger.info(`\nTotal: ${packages.length} packages, ${this.formatFileSize(totalSize)}`);
    }
  }

  /**
   * Group packages by name (useful for identifying duplicates)
   */
  groupByName(packages: InstalledPackage[]): Map<string, InstalledPackage[]> {
    const groups = new Map<string, InstalledPackage[]>();
    
    for (const pkg of packages) {
      if (!groups.has(pkg.name)) {
        groups.set(pkg.name, []);
      }
      groups.get(pkg.name)!.push(pkg);
    }
    
    return groups;
  }
}