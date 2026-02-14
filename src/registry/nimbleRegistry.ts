import https from 'https';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'path';
import os from 'os';
import { Logger } from '../utils/logger';

export interface NimblePackageInfo {
  name: string;
  url: string;
  description?: string;
  license?: string;
  web?: string;
  tags?: string[];
}

export class NimbleRegistry {
  private registryUrl = 'https://raw.githubusercontent.com/nim-lang/packages/refs/heads/master/packages.json';
  private cacheFile: string;
  private packages: Map<string, NimblePackageInfo> = new Map();
  
  constructor() {
    const nimbleDir = join(os.homedir(), '.nimble');
    this.cacheFile = join(nimbleDir, 'packages_official.json');
  }

  async ensureNimbleDir(): Promise<void> {
    const nimbleDir = join(os.homedir(), '.nimble');
    try {
      await access(nimbleDir);
    } catch {
      await mkdir(nimbleDir, { recursive: true });
    }
  }
  
  async downloadRegistry(): Promise<void> {
    Logger.info('Downloading official Nimble packages registry...');
    
    return new Promise((resolve, reject) => {
      https.get(this.registryUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            https.get(redirectUrl, (redirectResponse) => {
              this.handleRegistryResponse(redirectResponse, resolve, reject);
            }).on('error', reject);
            return;
          }
        }
        
        this.handleRegistryResponse(response, resolve, reject);
      }).on('error', reject);
    });
  }
  
  private handleRegistryResponse(response: any, resolve: () => void, reject: (error: any) => void): void {
    if (response.statusCode !== 200) {
      reject(new Error(`Failed to download registry: HTTP ${response.statusCode}`));
      return;
    }

    let data = '';
    response.on('data', (chunk: string) => {
      data += chunk;
    });

    response.on('end', async () => {
      try {
        await this.ensureNimbleDir();
        await writeFile(this.cacheFile, data);
        Logger.info('Registry downloaded successfully');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }
  
  async loadRegistry(): Promise<void> {
    // Try to load from cache first
    try {
      await access(this.cacheFile);
      const content = await readFile(this.cacheFile, 'utf8');
      const packages = JSON.parse(content);
      this.parsePackages(packages);
      Logger.info(`Loaded ${this.packages.size} packages from cache`);
      return;
    } catch {
      Logger.warn('Failed to load cached registry, downloading fresh copy...');
    }

    // Download fresh copy
    await this.downloadRegistry();

    // Load the downloaded content
    const content = await readFile(this.cacheFile, 'utf8');
    const packages = JSON.parse(content);
    this.parsePackages(packages);
    Logger.info(`Loaded ${this.packages.size} packages from registry`);
  }
  
  private parsePackages(packages: any[]): void {
    this.packages.clear();
    
    for (const pkg of packages) {
      if (pkg.name && pkg.url) {
        this.packages.set(pkg.name.toLowerCase(), {
          name: pkg.name,
          url: pkg.url,
          description: pkg.description,
          license: pkg.license,
          web: pkg.web,
          tags: pkg.tags
        });
      }
    }
  }
  
  getPackageInfo(name: string): NimblePackageInfo | null {
    return this.packages.get(name.toLowerCase()) || null;
  }
  
  getGitHubUrl(name: string): string | null {
    const pkg = this.getPackageInfo(name);
    if (!pkg) {
      return null;
    }
    
    // Extract GitHub URL from various formats
    const url = pkg.url;
    
    // Handle different GitHub URL formats
    if (url.includes('github.com')) {
      // Remove .git suffix if present
      let cleanUrl = url.replace(/\.git$/, '');
      
      // Handle SSH format (git@github.com:user/repo)
      const sshMatch = cleanUrl.match(/git@github\.com:([^\/]+\/[^\/]+)/);
      if (sshMatch) {
        return `https://github.com/${sshMatch[1]}`;
      }
      
      // Handle HTTPS format
      const httpsMatch = cleanUrl.match(/https?:\/\/github\.com\/([^\/]+\/[^\/]+)/);
      if (httpsMatch) {
        return `https://github.com/${httpsMatch[1]}`;
      }
    }
    
    return null;
  }
  
  getAllPackages(): NimblePackageInfo[] {
    return Array.from(this.packages.values());
  }
  
  searchPackages(query: string): NimblePackageInfo[] {
    const lowerQuery = query.toLowerCase();
    return this.getAllPackages().filter(pkg => 
      pkg.name.toLowerCase().includes(lowerQuery) ||
      (pkg.description && pkg.description.toLowerCase().includes(lowerQuery)) ||
      (pkg.tags && pkg.tags.some(tag => tag.toLowerCase().includes(lowerQuery)))
    );
  }
}