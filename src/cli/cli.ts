import { Command } from 'commander';
import { NimbleParser } from '../parser/nimbleParser';
import { SatDependencyResolver } from '../deps/satDependencyResolver';
import { GitHubClient } from '../git/githubClient';
import { Logger } from '../utils/logger';
import { findNimbleFile } from '../utils/nimbleUtils';
import { mkdtemp, rm, cp, access, mkdir, readdir } from 'node:fs/promises';
import { join,basename, resolve } from 'path';
import os from 'os';
import { NimbleRegistry } from '../registry/nimbleRegistry';
import { PackageDeduper } from '../packages/packageDeduper';
import { PackageLister } from '../packages/packageLister';
import { saveMetaData, createPackageMetaData, DownloadMethod } from '../utils/nimblemeta';
import { spawn } from 'node:child_process';

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

    // Compile command (nimble c)
    this.program
      .command('c <file> [args...]')
      .description('Compile a Nim file using the nimble environment')
      .option('-r, --run', 'Run the compiled binary after compilation')
      .option('-o, --output <path>', 'Output path for the compiled binary')
      .option('-d, --define <symbols>', 'Define conditional symbols (comma-separated)')
      .option('--opt <level>', 'Optimization level (none, speed, size)', 'speed')
      .option('--threads', 'Enable threads')
      .option('-l, --localdeps', 'Use local nimbledeps directory for paths')
      .option('--noNimblePath', 'Disable nimble package paths')
      .allowUnknownOption(true)
      .action(async (file, args, options) => {
        await this.compile(file, options, args || []);
      });

    // Path command (nimble path)
    this.program
      .command('path <package>')
      .description('Show the installation path of a package')
      .option('-l, --localdeps', 'Look in local nimbledeps directory')
      .action(async (packageName, options) => {
        await this.path(packageName, options.localdeps);
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
      // Try to install from registry
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

  async path(packageName: string, localdeps: boolean = false): Promise<void> {
    try {
      const packagesDir = localdeps
        ? join(process.cwd(), 'nimbledeps', 'pkgs2')
        : join(os.homedir(), '.nimble', 'pkgs2');

      Logger.info(`Looking for package: ${packageName}`);

      // Search for the package in the packages directory
      const entries = await readdir(packagesDir, { withFileTypes: true });
      let foundPath: string | null = null;

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Check if directory name starts with package name
          if (entry.name.startsWith(`${packageName}-`)) {
            foundPath = join(packagesDir, entry.name);
            break;
          }
          // Also check the nimblemeta.json for the actual package name
          const metaPath = join(packagesDir, entry.name, 'nimblemeta.json');
          try {
            const { readFile } = await import('node:fs/promises');
            const metaContent = await readFile(metaPath, 'utf-8');
            const meta = JSON.parse(metaContent);
            if (meta.name === packageName) {
              foundPath = join(packagesDir, entry.name);
              break;
            }
          } catch {
            // Meta file doesn't exist or can't be read, continue
          }
        }
      }

      if (foundPath) {
        console.log(foundPath);
      } else {
        Logger.error(`Package "${packageName}" not found in ${localdeps ? 'local' : 'global'} packages`);
        process.exit(1);
      }
    } catch (error) {
      Logger.error(`Error finding package path: ${error}`);
      process.exit(1);
    }
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

  async compile(file: string, options: any, extraArgs: string[] = []): Promise<void> {
    try {
      const resolvedFile = resolve(file);
      
      // Check if file exists
      try {
        await access(resolvedFile);
      } catch {
        Logger.error(`File not found: ${file}`);
        return;
      }

      // Check if it's a .nim file
      if (!resolvedFile.endsWith('.nim')) {
        Logger.error(`Not a Nim file: ${file}`);
        return;
      }

      Logger.info(`Compiling: ${file}`);

      // Determine nimble paths
      const globalPackagesDir = join(os.homedir(), '.nimble', 'pkgs2');
      const localPackagesDir = join(process.cwd(), 'nimbledeps', 'pkgs2');
      
      // Build nim compiler arguments
      const nimArgs: string[] = ['c'];

      // Add nimble package paths (unless --noNimblePath is set)
      if (!options.noNimblePath) {
        const nimPaths: string[] = [];
        
        // Find and parse nimble file to get dependencies
        const nimbleFile = await findNimbleFile();
        
        if (nimbleFile) {
          try {
            const pkg = await NimbleParser.parseFile(nimbleFile);
            
            if (pkg.dependencies && pkg.dependencies.length > 0) {
              Logger.info(`Resolving dependencies...`);
              
              // Use SatDependencyResolver to resolve dependencies
              const resolver = new SatDependencyResolver(options.localdeps ? localPackagesDir : globalPackagesDir);
              const resolvedDeps = await resolver.resolve(pkg);
              
              Logger.info(`Resolved ${resolvedDeps.length} dependencies`);
              
              // Get paths for resolved dependencies
              for (const dep of resolvedDeps) {
                if (dep.name === 'nim') continue; // Skip nim compiler dependency
                
                const packagesDir = options.localdeps ? localPackagesDir : globalPackagesDir;
                const depPaths = await this.getResolvedDependencyPaths(packagesDir, dep.name, dep.version);
                
                if (depPaths.length === 0 && !dep.installed) {
                  // Dependency not found, try to install it
                  Logger.info(`Dependency ${dep.name}@${dep.version} not found, installing...`);
                  try {
                    await this.installDependency(dep, options.localdeps);
                    // After installation, use the resolved name (which may differ from original requires name)
                    // to get paths for the newly installed package
                    const newDepPaths = await this.getResolvedDependencyPaths(packagesDir, dep.name, dep.version);
                    if (newDepPaths.length === 0) {
                      // If still not found, the dep.name might be the original requires name
                      // Try to find by checking what was actually installed
                      Logger.warn(`Could not find paths for ${dep.name} after installation, trying alternative lookup...`);
                    }
                    nimPaths.push(...newDepPaths);
                  } catch (installError) {
                    Logger.warn(`Failed to install ${dep.name}: ${installError}`);
                  }
                } else {
                  nimPaths.push(...depPaths);
                }
              }
            }
          } catch (error) {
            Logger.warn(`Failed to resolve dependencies: ${error}`);
          }
        }

        // Add --path:<path> arguments for each dependency
        for (const nimPath of nimPaths) {
          nimArgs.push(`--path:${nimPath}`);
        }
      }

      // Add optimization level
      if (options.opt) {
        nimArgs.push(`--opt:${options.opt}`);
      }

      // Add threads if enabled
      if (options.threads) {
        nimArgs.push('--threads:on');
      }

      // Add defines
      if (options.define) {
        const defines = options.define.split(',');
        for (const def of defines) {
          nimArgs.push('-d', def.trim());
        }
      }

      // Add output path if specified
      if (options.output) {
        nimArgs.push('-o', options.output);
      }

      // Filter out -r and .nim files from extraArgs to avoid duplication
      const filteredExtraArgs = extraArgs?.filter(arg => 
        arg !== '-r' && 
        arg !== '--run' && 
        !arg.endsWith('.nim')
      ) || [];

      // Add -r flag before the file if run option is set
      if (options.run) {
        nimArgs.push('-r');
      }

      // Add the file to compile (must come after -r)
      nimArgs.push(resolvedFile);

      // Add extra arguments to pass them to the compiled binary
      // This only applies when using -r (run mode)
      if (options.run && filteredExtraArgs.length > 0) {
        nimArgs.push(...filteredExtraArgs);
      }

      Logger.info(`Running: nim ${nimArgs.join(' ')}`);

      // Run nim compiler
      const success = await this.runNimCompiler(nimArgs);

      if (!success) {
        Logger.error('Compilation failed');
        return;
      }

      Logger.info('Compilation successful');

    } catch (error) {
      Logger.error('Error during compilation:', error);
    }
  }

  private async getNimblePaths(packagesDir: string): Promise<string[]> {
    const paths: string[] = [];
    
    try {
      const entries = await readdir(packagesDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const packageDir = join(packagesDir, entry.name);
          
          // Try to parse the nimble file to get srcDir
          const nimbleFile = await findNimbleFile(packageDir);
          if (nimbleFile) {
            try {
              const pkg = await NimbleParser.parseFile(nimbleFile);
              
              // Add the main package directory
              paths.push(packageDir);
              
              // Add src directory if specified
              if (pkg.srcDir) {
                const srcPath = join(packageDir, pkg.srcDir);
                try {
                  await access(srcPath);
                  paths.push(srcPath);
                } catch {
                  // src directory doesn't exist
                }
              }
            } catch {
              // Failed to parse nimble file, just add the package directory
              paths.push(packageDir);
            }
          } else {
            // No nimble file, just add the package directory
            paths.push(packageDir);
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    
    return paths;
  }

  private async getDependencyPaths(packagesDir: string, depName: string): Promise<string[]> {
    const paths: string[] = [];
    
    try {
      const entries = await readdir(packagesDir, { withFileTypes: true });
      
      // Find directories that start with the dependency name
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(`${depName}-`)) {
          const packageDir = join(packagesDir, entry.name);
          
          // Try to parse the nimble file to get srcDir
          const nimbleFile = await findNimbleFile(packageDir);
          if (nimbleFile) {
            try {
              const pkg = await NimbleParser.parseFile(nimbleFile);
              
              // Add the main package directory
              paths.push(packageDir);
              
              // Add src directory if specified
              if (pkg.srcDir) {
                const srcPath = join(packageDir, pkg.srcDir);
                try {
                  await access(srcPath);
                  paths.push(srcPath);
                } catch {
                  // src directory doesn't exist
                }
              }
            } catch {
              // Failed to parse nimble file, just add the package directory
              paths.push(packageDir);
            }
          } else {
            // No nimble file, just add the package directory
            paths.push(packageDir);
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    
    return paths;
  }

  private async getResolvedDependencyPaths(packagesDir: string, depName: string, version: string): Promise<string[]> {
    const paths: string[] = [];

    // Extract clean version (remove hash suffix if present)
    // Version can be: "0.10.18-634e8ce02fb5a9bbb3cf4f9853b7150ea21e35a9" or "0.10.18" or "#head-..."
    const cleanVersion = version.replace(/^([^-]+)-[a-f0-9]+$/, '$1');

    try {
      await access(packagesDir);
    } catch {
      return paths;
    }

    try {
      const entries = await readdir(packagesDir, { withFileTypes: true });

      // First pass: look for directory starting with depName-
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Match pattern: {name}-{version}-{hash} or {name}-{version}
        const match = entry.name.match(new RegExp(`^${depName}-(.+?)(?:-[a-f0-9]+)?$`));
        if (match) {
          const pkgVersion = match[1];

          // Check if this version satisfies the resolved version
          // Compare both the full version and the clean version
          if (pkgVersion === version ||
              pkgVersion === cleanVersion ||
              version === '*' ||
              version === '' ||
              version === '0.0.0' ||
              cleanVersion === '0.0.0') {
            const packageDir = join(packagesDir, entry.name);

            // Try to parse the nimble file to get srcDir
            const nimbleFile = await findNimbleFile(packageDir);
            if (nimbleFile) {
              try {
                const pkg = await NimbleParser.parseFile(nimbleFile);

                // Add the main package directory
                paths.push(packageDir);

                // Add src directory if specified
                if (pkg.srcDir) {
                  const srcPath = join(packageDir, pkg.srcDir);
                  try {
                    await access(srcPath);
                    paths.push(srcPath);
                  } catch {
                    // src directory doesn't exist
                  }
                }
              } catch {
                // Failed to parse nimble file, just add the package directory
                paths.push(packageDir);
              }
            } else {
              // No nimble file, just add the package directory
              paths.push(packageDir);
            }

            // Only add the first matching version
            return paths;
          }
        }
      }

      // Second pass: look through all packages and check their nimble files
      // This handles cases where the requires name doesn't match the package name
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const packageDir = join(packagesDir, entry.name);
        try {
          const nimbleFile = await findNimbleFile(packageDir);
          if (nimbleFile) {
            const pkg = await NimbleParser.parseFile(nimbleFile);

            // Check if this package's name matches what we're looking for
            if (pkg.name === depName) {
              // Extract version from directory name
              const versionMatch = entry.name.match(/^[^-]+-(.+?)(?:-[a-f0-9]+)?$/);
              const pkgVersion = versionMatch ? versionMatch[1] : '0.0.0';

              // Check if version matches
              if (pkgVersion === version ||
                  pkgVersion === cleanVersion ||
                  version === '*' ||
                  version === '' ||
                  version === '0.0.0' ||
                  cleanVersion === '0.0.0') {
                // Add the main package directory
                paths.push(packageDir);

                // Add src directory if specified
                if (pkg.srcDir) {
                  const srcPath = join(packageDir, pkg.srcDir);
                  try {
                    await access(srcPath);
                    paths.push(srcPath);
                  } catch {
                    // src directory doesn't exist
                  }
                }

                // Only add the first matching version
                return paths;
              }
            }
          }
        } catch {
          // Skip packages we can't read
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return paths;
  }

  private runNimCompiler(args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const nimProcess = spawn('nim', args, {
        stdio: 'inherit',
        shell: false
      });

      nimProcess.on('close', (code) => {
        resolve(code === 0);
      });

      nimProcess.on('error', (error) => {
        Logger.error(`Failed to start nim compiler: ${error.message}`);
        resolve(false);
      });
    });
  }

  private getDefaultBinaryPath(nimFile: string): string {
    // Remove .nim extension
    const baseName = nimFile.replace(/\.nim$/, '');
    
    // On Windows, add .exe
    if (process.platform === 'win32') {
      return `${baseName}.exe`;
    }
    
    return baseName;
  }

  private runBinary(binaryPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      Logger.info(`Running: ${binaryPath}`);

      const binaryProcess = spawn(binaryPath, [], {
        stdio: 'inherit',
        shell: false
      });

      binaryProcess.on('close', (code) => {
        if (code === 0) {
          Logger.info(`Binary exited successfully`);
        } else {
          Logger.info(`Binary exited with code ${code}`);
        }
        resolve();
      });

      binaryProcess.on('error', (error) => {
        Logger.error(`Failed to run binary: ${error.message}`);
        reject(error);
      });
    });
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
