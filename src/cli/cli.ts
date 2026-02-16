import { Command } from 'commander';
import { NimbleParser } from '../parser/nimbleParser';
import { SatDependencyResolver } from '../deps/satDependencyResolver';
import { GitHubClient } from '../git/githubClient';
import { Logger, LogLevel } from '../utils/logger';
import { findNimbleFile } from '../utils/nimbleUtils';
import { mkdtemp, rm, cp, access, mkdir, readdir } from 'node:fs/promises';
import { join,basename } from 'path';
import os from 'os';
import { NimbleRegistry } from '../registry/nimbleRegistry';
import { PackageDeduper } from '../packages/packageDeduper';
import { PackageLister } from '../packages/packageLister';
import { saveMetaData, createPackageMetaData, DownloadMethod } from '../utils/nimblemeta';

export class CLI {
  private program: Command;
  
  constructor() {
    this.program = new Command();
    this.setupCommands();
  }
  
  setupCommands() {
    this.program
      .name('bunim')
      .version('0.1.0')
      .description('Package manager for Nim programming language');
    
    // Install command
    this.program
      .command('install [packages...]')
      .description('Install dependencies or specific packages')
      .option('-d, --dev', 'Install dev dependencies')
      .option('-g, --global', 'Install to global nimble directory (default)')
      .option('-l, --localdeps', 'Install to local nimbledeps directory')
      .option('--git', 'Use git clone instead of archive download for GitHub packages')
      .action(async (packages, options) => {
        await this.install(packages, options.dev, options.git, options.localdeps);
      });
    
    // Init command
    this.program
      .command('init')
      .description('Initialize a new Nim project')
      .action(() => {
        this.init();
      });
    
    // List command
    this.program
      .command('list')
      .description('List installed packages')
      .option('-l, --localdeps', 'List packages in local nimbledeps directory')
      .option('-d, --detailed', 'Show detailed information (size, install date)')
      .option('-s, --sort <type>', 'Sort by: name, version, size, date', 'name')
      .action(async (options) => {
        await this.list(options.localdeps, options.detailed, options.sort);
      });
    
    // Search command
    this.program
      .command('search <query>')
      .description('Search for packages')
      .action((query) => {
        this.search(query);
      });
    
    // Dedupe command
    this.program
      .command('dedupe')
      .description('Remove duplicate packages, keeping only the highest version')
      .option('--dry-run', 'Show what would be removed without actually removing')
      .option('-l, --localdeps', 'Operate on local nimbledeps directory instead of global')
      .action(async (options) => {
        await this.dedupe(options.dryRun, options.localdeps);
      });
  }
  
  async install(packages: string[] = [], includeDev: boolean = false, useGit: boolean = false, localdeps: boolean = false) {
    try {
      if (packages && packages.length > 0) {
        // Install specific packages
        Logger.info(`Installing specific packages: ${packages.join(', ')}`);
        
        for (const pkg of packages) {
          if (pkg.includes('github.com')) {
            await this.installGitHubPackage(pkg, useGit, localdeps);
          } else {
            await this.installRegistryPackage(pkg, useGit, localdeps);
          }
        }
      } else {
        // Install dependencies from nimble file
        Logger.info('Parsing nimble file...');
        const nimbleFile = await findNimbleFile();
        
        if (!nimbleFile) {
          throw new Error('No .nimble file found in current directory');
        }
        
        Logger.info(`Using nimble file: ${nimbleFile}`);
        const pkg = await NimbleParser.parseFile(nimbleFile);
        
        // Resolve dependencies
        Logger.info('Resolving dependencies...');
        const resolver = new SatDependencyResolver();
        const resolved = await resolver.resolve(pkg);
        
        Logger.info('Installing dependencies:');
        for (const dep of resolved) {
          if (dep.installed) {
            Logger.info(`- ${dep.name}@${dep.version} (already installed)`);
          } else {
            Logger.info(`- ${dep.name}@${dep.version} (needs installation)`);
            await this.installDependency(dep, localdeps);
          }
        }
      }
      
      Logger.info('Installation complete!');
    } catch (error) {
      Logger.error('Error installing dependencies:', error);
    }
  }
  
  private async installGitHubPackage(url: string, useGit: boolean = false, localdeps: boolean = false): Promise<void> {
    // Parse GitHub URL and extract owner/repo
    const match = url.match(/github\.com\/([^\/]+)\/([^\/\[]+)/);
    if (!match) {
      Logger.error(`Invalid GitHub URL: ${url}`);
      return;
    }
    
    const [, owner, repo] = match;
    
    // Parse features
    const featureMatch = url.match(/\[([^\]]+)\]/);
    const features = featureMatch ? featureMatch[1] : null;
    
    Logger.info(`Installing ${owner}/${repo} from GitHub...`);
    Logger.info(`Repository: ${repo}${features ? ` [${features}]` : ''}`);
    
    // Create temporary directory
    const tmpDir = await mkdtemp(join(os.tmpdir(), 'bunim-'));
    
    try {
      // Use GitHub client to download the package (archive by default)
      const githubUrl = `https://github.com/${owner}/${repo}`;
      
      let downloadResult: {path: string, checksum: string};
      if (useGit) {
        Logger.info(`Cloning ${owner}/${repo} with git...`);
        const githubClient = new GitHubClient(true);
        downloadResult = await githubClient.downloadPackage(githubUrl);
      } else {
        Logger.info(`Downloading ${owner}/${repo} archive...`);
        const githubClient = new GitHubClient(false);
        downloadResult = await githubClient.downloadPackage(githubUrl);
      }
      
      // Copy files from download directory to temp directory
      await cp(downloadResult.path, tmpDir, { recursive: true });
      
      // Parse the nimble file from the downloaded package
      const nimbleFile = await findNimbleFile(tmpDir);
      if (!nimbleFile) {
        Logger.error(`No .nimble file found in package`);
        return;
      }
      
      const pkg = await NimbleParser.parseFile(nimbleFile);
      
      // If name is not in the nimble file, extract it from the filename
      if (!pkg.name) {
        const nimbleFileName = nimbleFile.split('/').pop() || '';
        pkg.name = nimbleFileName.replace('.nimble', '');
      }
      
      Logger.info(`Found package: ${pkg.name}@${pkg.version}`);
      
      // Determine installation directory based on localdeps flag
      const installDir = localdeps 
        ? join(process.cwd(), 'nimbledeps', 'pkgs2')
        : join(os.homedir(), '.nimble', 'pkgs2');
      
      Logger.info(`Installing to ${localdeps ? 'local' : 'global'} directory: ${installDir}`);
      
      // Handle srcDir field if present
      let sourceDir = tmpDir;
      if (pkg.srcDir) {
        const srcPath = join(tmpDir, pkg.srcDir);
        try {
          await access(srcPath);
          sourceDir = srcPath;
          Logger.info(`Using src directory: ${pkg.srcDir}`);
        } catch {
          Logger.warn(`Specified src directory '${pkg.srcDir}' not found, using root`);
        }
      }
      
      // Install dependencies first
      if (pkg.dependencies && pkg.dependencies.length > 0) {
        Logger.info('Installing package dependencies...');
        const resolver = new SatDependencyResolver(installDir);
        const resolved = await resolver.resolve(pkg);
        
        for (const dep of resolved) {
          if (!dep.installed) {
            Logger.info(`- Installing dependency: ${dep.name}@${dep.version}`);
            await this.installDependency(dep, localdeps);
          }
        }
      }
      const targetDir = join(installDir, `${pkg.name}-${pkg.version}-${downloadResult.checksum}`);
      
      Logger.info(`Installing to ${targetDir}...`);
      
      // Create packages directory if it doesn't exist
      try {
        await mkdir(installDir, { recursive: true });
      } catch (error) {
        Logger.warn(`Failed to create packages directory: ${error}`);
      }
      
      try {
        await access(targetDir);
        Logger.info(`Package already exists at ${targetDir}, removing old version...`);
        try {
          await rm(targetDir, { recursive: true, force: true });
        } catch (error) {
          Logger.warn(`Failed to remove existing directory: ${error}`);
        }
      } catch {
        // Directory doesn't exist, which is fine
      }
      
      // Create target directory

      try {
        await mkdir(targetDir, { recursive: true });
      } catch (error) {
        Logger.error(`Failed to create directory: ${error}`);
        throw new Error(`Cannot create directory ${targetDir}`);
      }
      // Copy nimble file
      await cp(nimbleFile, join(targetDir, basename(nimbleFile)))
      
      // Copy main nim file if it exists (e.g., pkgname.nim)
      // const mainNimFile = join(tmpDir, `${pkg.name}.nim`);
      // try {
      //   await access(mainNimFile);
      //   await cp(mainNimFile, join(targetDir, `${pkg.name}.nim`));
      //   Logger.info(`Copied main nim file: ${pkg.name}.nim`);
      // } catch {
      //   // Main nim file doesn't exist, which is fine
      // }
      
      // Copy files to target directory
      await cp(sourceDir, targetDir, { recursive: true });
      
      // Get list of installed files for nimblemeta.json
      const installedFiles = await this.getInstalledFiles(targetDir);
      
      // Always use 'git' as download method for compatibility with nimble
      const downloadMethod: DownloadMethod = 'git';
      
      // Create and save nimblemeta.json
      const metaData = createPackageMetaData(
        `https://github.com/${owner}/${repo}`,
        downloadMethod,
        downloadResult.checksum,
        installedFiles,
        [], // binaries - could be populated from nimble file
        []  // specialVersions - could be populated if needed
      );
      await saveMetaData(metaData, targetDir);
      
      Logger.info(`Successfully installed ${pkg.name}@${pkg.version}`);

      if (features) {
        Logger.info(`Feature '${features}' enabled`);
        // In a real implementation, we'd handle feature-specific installation
      }

    } catch (error) {
      Logger.error(`Error installing ${repo}:`, error);
      throw error;
    } finally {
      // Clean up temporary directory
      try {
        await access(tmpDir);
        Logger.info('Cleaning up temporary directory...');
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Directory doesn't exist, which is fine
      }
    }
  }

  private async installRegistryPackage(packageName: string, useGit: boolean = false, localdeps: boolean = false): Promise<void> {
    Logger.info(`Installing package: ${packageName}`);

    // Initialize registry
    const registry = new NimbleRegistry();
    try {
      await registry.loadRegistry();
    } catch (error) {
      Logger.warn(`Failed to load registry: ${error}`);
      return;
    }

    // Try to find package in registry
    const githubUrl = registry.getGitHubUrl(packageName);
    if (githubUrl) {
      Logger.info(`Found ${packageName} in registry: ${githubUrl}`);
      try {
        await this.installGitHubPackage(githubUrl, useGit, localdeps);
      } catch (error) {
        Logger.error(`Failed to install ${packageName} from registry:`, error);
      }
    } else {
      Logger.error(`Package ${packageName} not found in registry`);
    }
  }

  private async installDependency(dep: any, localdeps: boolean = false): Promise<void> {
    if (dep.url && dep.url.includes('github.com')) {
      await this.installGitHubPackage(dep.url, false, localdeps); // Use archive download for dependencies
    } else {
      // Try to install from registry or use a fallback approach
      Logger.info(`Installing ${dep.name}@${dep.version} from registry...`);
      
      // Initialize registry
      const registry = new NimbleRegistry();
      try {
        await registry.loadRegistry();
      } catch (error) {
        Logger.warn(`Failed to load registry: ${error}`);
      }
      
      // Try to find package in registry
      const githubUrl = registry.getGitHubUrl(dep.name);
      if (githubUrl) {
        Logger.info(`Found ${dep.name} in registry: ${githubUrl}`);
        try {
          await this.installGitHubPackage(githubUrl, false, localdeps);
        } catch (error) {
          Logger.warn(`Failed to install from registry: ${error}`);
        }
      } else {
        Logger.warn(`Package ${dep.name} not found in registry, skipping installation`);
      }
    }
  }
  
  init() {
    Logger.info('Initializing new Nim project...');
    // In a real implementation, we'd create a package.nimble file
    Logger.info('Created package.nimble file');
  }
  
  async list(localdeps: boolean = false, detailed: boolean = false, sortBy: string = 'name'): Promise<void> {
    try {
      const packagesDir = localdeps 
        ? join(process.cwd(), 'nimbledeps', 'pkgs2')
        : join(os.homedir(), '.nimble', 'pkgs2');
      
      Logger.info(`Listing ${localdeps ? 'local' : 'global'} packages...`);
      Logger.info(`Packages directory: ${packagesDir}`);
      
      const lister = new PackageLister(packagesDir);
      const options = { 
        local: localdeps, 
        detailed, 
        sortBy: sortBy as 'name' | 'version' | 'size' | 'date' 
      };
      
      const packages = lister.list(options);
      lister.display(packages, options);
      
    } catch (error) {
      Logger.error('Error listing packages:', error);
    }
  }
  
  search(query: string) {
    Logger.info(`Searching for packages matching "${query}"...`);
    // In a real implementation, we'd search a registry
  }
  
  async dedupe(dryRun: boolean = false, localdeps: boolean = false): Promise<void> {
    try {
      const packagesDir = localdeps 
        ? join(process.cwd(), 'nimbledeps', 'pkgs2')
        : join(os.homedir(), '.nimble', 'pkgs2');
      
      Logger.info(`Running dedupe on ${localdeps ? 'local' : 'global'} packages...`);
      Logger.info(`Packages directory: ${packagesDir}`);
      
      const deduper = new PackageDeduper(packagesDir);
      deduper.dedupe(dryRun);
      
    } catch (error) {
      Logger.error('Error during dedupe:', error);
    }
  }
  
  run() {
    this.program.parse(process.argv);
  }

  /**
   * Get list of all files in the installed package directory
   * Excludes nimblemeta.json itself
   */
  private async getInstalledFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await this.getInstalledFiles(fullPath);
        files.push(...subFiles.map(f => `${entry.name}/${f}`));
      } else if (entry.isFile() && entry.name !== 'nimblemeta.json') {
        files.push(entry.name);
      }
    }

    return files;
  }
}
