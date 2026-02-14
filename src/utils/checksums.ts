import { readdirSync, readFileSync, lstatSync, readlinkSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Recursively calculates the SHA1 checksum of the contents of a directory and its subdirectories.
 * This mimics nimble's checksum calculation algorithm using Bun's optimized CryptoHasher.
 */
export function calculateDirSha1Checksum(dir: string, skipDirs: string[] = []): string {
  if (!existsSync(dir)) {
    throw new Error(`Directory does not exist: ${dir}`);
  }

  const packageFiles = getPackageFileList(dir, '', skipDirs);
  packageFiles.sort();
  
  // Use Bun's optimized CryptoHasher for SHA1
  const hasher = new Bun.CryptoHasher('sha1');
  
  for (const file of packageFiles) {
    updateSha1Checksum(hasher, file, join(dir, file));
  }
  
  return hasher.digest('hex');
}

/**
 * Get all files in a package directory recursively, excluding common ignore patterns
 */
function getPackageFileList(dir: string, basePath: string = '', skipDirs: string[] = []): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir);
  
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relativePath = basePath ? join(basePath, entry) : entry;
    const stat = lstatSync(fullPath);
    
    if (stat.isDirectory()) {
      // Skip common ignore patterns and user-specified skipDirs
      if (shouldIgnoreDirectory(entry) || skipDirs.includes(entry)) {
        continue;
      }
      // Recursively get files from subdirectories
      const subFiles = getPackageFileList(fullPath, relativePath, skipDirs);
      files.push(...subFiles);
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      files.push(relativePath);
    }
  }
  
  return files;
}

/**
 * Check if a directory should be ignored in checksum calculation
 */
function shouldIgnoreDirectory(dirName: string): boolean {
  const ignorePatterns = [
    '.git', '.hg', '.svn',          // Version control
    'node_modules', 'bower_components', // JavaScript packages
    '__pycache__', '.pytest_cache',     // Python cache
    '.idea', '.vscode', '.vs',          // IDE directories
    'build', 'dist', 'target',          // Build output
    'tmp', 'temp',                      // Temporary directories
    '.DS_Store'                          // macOS metadata
  ];
  
  return ignorePatterns.includes(dirName) || dirName.startsWith('.');
}

/**
 * Update SHA1 hash with file information (mimics nimble's updateSha1Checksum)
 * Uses Bun's CryptoHasher for optimal performance
 */
function updateSha1Checksum(hasher: Bun.CryptoHasher, fileName: string, filePath: string): void {
  if (!existsSync(filePath)) {
    console.warn(`[WARN] File does not exist: ${filePath}, skipping in checksum calculation`);
    return;
  }
  
  // Update hash with filename
  hasher.update(fileName);
  
  try {
    const stat = lstatSync(filePath);
    
    if (stat.isSymbolicLink()) {
      // For symlinks, update with the path it points to
      try {
        const linkPath = readlinkSync(filePath);
        hasher.update(linkPath);
      } catch (error) {
        console.warn(`[WARN] Cannot read symbolic link "${filePath}": ${error}`);
        return;
      }
    } else if (stat.isFile()) {
      // For regular files, update with file contents
      try {
        const content = readFileSync(filePath);
        hasher.update(content);
      } catch (error) {
        console.warn(`[WARN] Cannot read file "${filePath}": ${error}`);
        return;
      }
    }
  } catch (error) {
    console.warn(`[WARN] Cannot stat file "${filePath}": ${error}`);
    return;
  }
}