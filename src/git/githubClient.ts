import simpleGit from 'simple-git';
import { NimbleParser } from '../parser/nimbleParser';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { Logger } from '../utils/logger';
import { calculateDirSha1Checksum } from '../utils/checksums';

// GitHub API response type for repository info
interface GitHubRepoInfo {
  default_branch?: string;
  [key: string]: any;
}

export class GitHubClient {
  private useGit: boolean = false;
  
  constructor(useGit: boolean = false) {
    this.useGit = useGit;
  }
  
  async downloadPackage(url: string): Promise<{path: string, checksum: string}> {
    const tempDir = join(tmpdir(), `bunim_${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    if (this.useGit) {
      return await this.cloneWithGit(url, tempDir);
    } else {
      // For archive downloads, get the real commit hash from the API
      return await this.downloadArchive(url, tempDir);
    }
  }

  async clone(url: string): Promise<string> {
    const tempDir = join(tmpdir(), `bunim_${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    
    // Clone the repository
    Logger.info(`Cloning repository: ${url}`);
    const git = simpleGit();
    await git.clone(url, tempDir);
    
    return tempDir;
  }
  
  private async cloneWithGit(url: string, tempDir: string): Promise<{path: string, checksum: string}> {
    Logger.info(`Cloning repository with git: ${url}`);
    const git = simpleGit();
    await git.clone(url, tempDir);

    // Parse the nimble file to get skipDirs and other metadata
    const nimbleFile = await this.findNimbleFile(tempDir);
    let skipDirs: string[] = [];

    if (nimbleFile) {
      try {
        const content = await Bun.file(nimbleFile).text();
        const pkg = NimbleParser.parseContent(content);
        skipDirs = pkg.skipDirs || [];
        Logger.info(`Found nimble file, using skipDirs: ${skipDirs.join(', ')}`);
      } catch (error) {
        Logger.warn(`Failed to parse nimble file for skipDirs: ${error}`);
      }
    }

    // Calculate nimble-style checksum of the cloned directory contents, respecting skipDirs
    const checksum = calculateDirSha1Checksum(tempDir, skipDirs);

    return { path: tempDir,  checksum };
  }
  
  private async getDefaultBranch(owner: string, repo: string): Promise<string> {
    try {
      // Use Bun's native fetch for better performance
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;
      Logger.info(`Fetching default branch from: ${apiUrl}`);
      
      const response = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'bunim',
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      
      if (response.ok) {
        const repoInfo = await response.json() as GitHubRepoInfo;
        const defaultBranch = repoInfo.default_branch || 'main';
        Logger.info(`Detected default branch: ${defaultBranch}`);
        return defaultBranch;
      } else if (response.status === 403) {
        throw new Error(`GitHub API rate limit exceeded (403). Please try again later or use --git flag to clone instead of downloading archive.`);
      } else {
        Logger.warn(`GitHub API returned ${response.status}, using 'main' as default branch`);
        return 'main';
      }
    } catch (error) {
      Logger.warn(`Failed to fetch default branch: ${error}`);
      return 'main';
    }
  }
  
  private async downloadArchive(url: string, tempDir: string): Promise<{path: string, checksum: string}> {
    // Parse GitHub URL and extract owner/repo
    const match = url.match(/github\.com\/([^\/]+)\/([^\/\[]+)/);
    if (!match) {
      throw new Error(`Invalid GitHub URL: ${url}`);
    }
    
    const [, owner, repo] = match;
    
    // Get default branch
    const defaultBranch = await this.getDefaultBranch(owner, repo);
    
    // Download archive (use tar.gz format for better compatibility with Bun)
    const archiveUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${defaultBranch}.tar.gz`;
    Logger.info(`Downloading archive from: ${archiveUrl}`);
    
    try {
      // Use Bun's native fetch for better performance
      const response = await fetch(archiveUrl);
      
      if (!response.ok) {
        throw new Error(`Failed to download archive: ${response.status} ${response.statusText}`);
      }
      
      // Get the archive data as ArrayBuffer
      const archiveData = await response.arrayBuffer();
      Logger.info(`Archive downloaded: ${archiveData.byteLength} bytes`);
      
      // Extract the tar.gz archive using Bun.Archive
      Logger.info(`Extracting archive to: ${tempDir}`);
      const archive = new Bun.Archive(new Uint8Array(archiveData));
      const entryCount = await archive.extract(tempDir);
      Logger.info(`Extracted ${entryCount} entries`);
      
      // Find the extracted directory (it should be repo-name-branch)
      const extractedDirs = await this.getDirectories(tempDir);
      const extractedDir = extractedDirs.find(dir => dir.includes(`${repo}-${defaultBranch}`));
      
      if (!extractedDir) {
        throw new Error('Could not find extracted directory');
      }
      
      // Parse the nimble file to get skipDirs and other metadata
      const nimbleFile = await this.findNimbleFile(extractedDir);
      let skipDirs: string[] = [];

      if (nimbleFile) {
        try {
          const content = await Bun.file(nimbleFile).text();
          const pkg = NimbleParser.parseContent(content);
          skipDirs = pkg.skipDirs || [];
          Logger.info(`Found nimble file, using skipDirs: ${skipDirs.join(', ')}`);
        } catch (error) {
          Logger.warn(`Failed to parse nimble file for skipDirs: ${error}`);
        }
      }
      
      // Calculate nimble-style checksum of the extracted directory contents, respecting skipDirs
      const checksum = calculateDirSha1Checksum(extractedDir, skipDirs);
      
      // No need to clean up archive file since we used system tar or in-memory extraction
      
      return { path: extractedDir, checksum };
      
    } catch (error) {
      Logger.error(`Error downloading archive: ${error}`);
      throw error;
    }
  }
  
  private async getDirectories(dirPath: string): Promise<string[]> {
    const entries = await readdir(dirPath);
    const directories: string[] = [];

    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        directories.push(fullPath);
      }
    }

    return directories;
  }
  
  async findNimbleFile(dirPath: string): Promise<string | null> {
    try {
      const entries = await readdir(dirPath);
      const nimbleFile = entries.find((entry: string) => entry.endsWith('.nimble'));
      return nimbleFile ? join(dirPath, nimbleFile) : null;
    } catch (error) {
      Logger.warn(`Error reading directory ${dirPath}: ${error}`);
      return null;
    }
  }
}