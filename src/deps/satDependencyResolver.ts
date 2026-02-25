import { NimbleDependency, NimblePackage, NimbleParser } from '../parser/nimbleParser';
import { readdir, access, readFile } from 'node:fs/promises';
import { join } from 'path';
import { NimbleRegistry } from '../registry/nimbleRegistry';
import { Logger } from '../utils/logger';
import satSolve from 'boolean-sat';

export interface ResolvedDependency {
  name: string;
  version: string;
  url: string;
  package: NimblePackage;
  dependencies: ResolvedDependency[];
  installed: boolean;
}

interface PackageVersion {
  name: string;
  version: string;
  variableId: number;
}

export class SatDependencyResolver {
  private localPackagesDir: string;
  private resolvedDeps: Map<string, ResolvedDependency> = new Map();
  private registry: NimbleRegistry;
  private variableMap: Map<string, number> = new Map();
  private versionMap: Map<number, PackageVersion> = new Map();
  private nextVarId: number = 1;

  constructor(localPackagesDir?: string) {
    this.localPackagesDir = localPackagesDir || join(process.cwd(), 'packages');
    this.registry = new NimbleRegistry();
  }

  async resolve(pkg: NimblePackage): Promise<ResolvedDependency[]> {
    this.resolvedDeps.clear();
    this.variableMap.clear();
    this.versionMap.clear();
    this.nextVarId = 1;

    try {
      await this.registry.loadRegistry();
    } catch (error) {
      Logger.warn(`Failed to load registry: ${error}`);
    }

    const clauses: number[][] = [];
    const allDeps = await this.collectAllDependencies(pkg);

    // Encode "exactly one version per package" constraint
    for (const [depName, versions] of allDeps) {
      const versionVars: number[] = [];

      for (const version of versions) {
        const varId = this.nextVarId++;
        const key = `${depName}@${version}`;
        this.variableMap.set(key, varId);
        this.versionMap.set(varId, { name: depName, version, variableId: varId });
        versionVars.push(varId);
      }

      if (versionVars.length > 1) {
        const exactlyOneClause = this.encodeExactlyOne(versionVars);
        clauses.push(...exactlyOneClause);
      } else if (versionVars.length === 1) {
        clauses.push([versionVars[0]]);
      }
    }

    // Encode dependency constraints
    for (const dep of [...(pkg.dependencies || [])]) {
      const depClauses = this.encodeDependencyConstraints(dep, allDeps);
      clauses.push(...depClauses);
    }

    const numVars = this.nextVarId - 1;

    if (numVars === 0) {
      // No dependencies to resolve
      return [];
    }

    const solution = satSolve(numVars, clauses);

    if (solution === false) {
      throw new Error('Dependency resolution failed: constraints are unsatisfiable');
    }

    const selectedVersions = this.extractSolution(solution);
    const resolved: ResolvedDependency[] = [];

    for (const dep of [...(pkg.dependencies || [])]) {
      const resolvedDep = await this.resolveDependency(dep, selectedVersions);
      resolved.push(resolvedDep);
    }

    return resolved;
  }

  private async collectAllDependencies(pkg: NimblePackage): Promise<Map<string, string[]>> {
    const allDeps = new Map<string, string[]>();

    for (const dep of [...(pkg.dependencies || [])]) {
      await this.collectVersions(dep, allDeps, new Set());
    }

    return allDeps;
  }

  private async collectVersions(
    dep: NimbleDependency,
    allDeps: Map<string, string[]>,
    visited: Set<string>
  ): Promise<void> {
    const depKey = `${dep.name}@${dep.version}`;
    if (visited.has(depKey)) {
      return;
    }
    visited.add(depKey);

    if (allDeps.has(dep.name)) {
      return;
    }

    const versions = await this.getAvailableVersions(dep.name);
    allDeps.set(dep.name, versions);

    // For now, we don't recursively collect nested dependencies
    // to avoid complexity. In a full implementation, you'd fetch
    // each version's dependencies from the registry.
  }

  private async getAvailableVersions(packageName: string): Promise<string[]> {
    const versions: string[] = [];

    // Check local packages first
    const localVersion = await this.getLocalPackageVersion(packageName);
    if (localVersion) {
      versions.push(localVersion);
    }

    // For now, we use a simple version list since the registry
    // doesn't provide version history. In a real implementation,
    // you'd query the GitHub API or a version database.
    // Add some common versions for demonstration
    if (versions.length === 0) {
      // Default to a placeholder version if nothing found
      versions.push('0.0.0');
    }

    // Remove duplicates and sort by semver (descending)
    const uniqueVersions = [...new Set(versions)];
    uniqueVersions.sort((a, b) => Bun.semver.order(b, a));

    return uniqueVersions;
  }

  private encodeExactlyOne(vars: number[]): number[][] {
    const clauses: number[][] = [];

    // At least one must be true: (v1 OR v2 OR ... OR vn)
    clauses.push([...vars]);

    // At most one must be true: pairwise exclusions
    // (-v1 OR -v2) AND (-v1 OR -v3) AND ...
    for (let i = 0; i < vars.length; i++) {
      for (let j = i + 1; j < vars.length; j++) {
        clauses.push([-vars[i], -vars[j]]);
      }
    }

    return clauses;
  }

  private encodeDependencyConstraints(
    dep: NimbleDependency,
    allDeps: Map<string, string[]>
  ): number[][] {
    const clauses: number[][] = [];
    const depName = dep.name;
    const range = dep.version;

    // Skip system dependencies like "nim" (the compiler)
    if (depName === 'nim') {
      // Check if the installed nim version satisfies the constraint
      const nimVersion = this.getNimVersion();
      if (nimVersion && range !== '*' && range !== '') {
        try {
          // Convert version to proper semver range (e.g., "2.0.0" -> ">=2.0.0")
          const semverRange = range.startsWith('>=') || range.startsWith('>') || range.startsWith('<') || range.startsWith('<=') || range.startsWith('^') || range.startsWith('~')
            ? range
            : `>=${range}`;
          if (!Bun.semver.satisfies(nimVersion, semverRange)) {
            Logger.warn(`Installed Nim version ${nimVersion} does not satisfy required range ${range}`);
          }
        } catch {
          // If semver check fails, just warn
          Logger.warn(`Could not verify Nim version against range ${range}`);
        }
      }
      return clauses; // Return empty clauses - nim is a system dependency
    }

    let versions = allDeps.get(depName) || [];
    // Filter versions that satisfy the range
    let validVersions = versions.filter(v => {
      if (range === '*' || range === '') return true;
      try {
        return Bun.semver.satisfies(v, range);
      } catch {
        return v === range; // Exact version match
      }
    });



    // At least one valid version must be selected
    const validVars = validVersions
      .map(v => this.variableMap.get(`${depName}@${v}`))
      .filter((id): id is number => id !== undefined);

    if (validVars.length > 0) {
      clauses.push(validVars);
    }

    return clauses;
  }

  private extractSolution(solution: (boolean | null)[]): Map<string, string> {
    const selected = new Map<string, string>();

    for (let i = 1; i < solution.length; i++) {
      if (solution[i] === true) {
        const pkgVersion = this.versionMap.get(i);
        if (pkgVersion) {
          selected.set(pkgVersion.name, pkgVersion.version);
        }
      }
    }

    return selected;
  }

  private async getLocalPackageVersion(packageName: string): Promise<string | null> {
    if (packageName === 'nim') {
      return this.getNimVersion();
    }

    try {
      await access(this.localPackagesDir);
    } catch {
      return null;
    }

    try {
      const packages = await readdir(this.localPackagesDir);
      
      // First try: look for directory starting with packageName-
      const packageDirs = packages.filter((dir: string) => dir.startsWith(`${packageName}-`));

      if (packageDirs.length > 0) {
        const versions = packageDirs.map((dir: string) => {
          const versionMatch = dir.match(/^[^-]+-(.+)$/);
          return versionMatch ? versionMatch[1] : '0.0.0';
        });

        versions.sort((a: string, b: string) => Bun.semver.order(b, a));
        return versions[0];
      }

      // Second try: look through all packages and check their nimble files
      // This handles cases where the requires name doesn't match the package name
      // e.g., requires "nim-tinyfiledialogs" but package name is "tinyfiledialogs"
      for (const dir of packages) {
        const packageDir = join(this.localPackagesDir, dir);
        try {
          const entries = await readdir(packageDir);
          const nimbleFile = entries.find(f => f.endsWith('.nimble'));
          if (nimbleFile) {
            const content = await readFile(join(packageDir, nimbleFile), 'utf8');
            const pkg = NimbleParser.parseContent(content);
            // Check if this package's name matches what we're looking for
            if (pkg.name === packageName) {
              // Extract version from directory name
              const versionMatch = dir.match(/^[^-]+-(.+?)(?:-[a-f0-9]+)?$/);
              return versionMatch ? versionMatch[1] : '0.0.0';
            }
          }
        } catch {
          // Skip packages we can't read
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private getNimVersion(): string | null {
    try {
      const { execSync } = require('child_process');
      const output = execSync('nim -v', { encoding: 'utf8', timeout: 2000 });
      const versionMatch = output.match(/Nim Compiler Version ([\d.]+)/);
      if (versionMatch) {
        return versionMatch[1];
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  async resolveDependency(dep: NimbleDependency, selectedVersions: Map<string, string>): Promise<ResolvedDependency> {
    const cacheKey = `${dep.name}@${dep.version}`;

    if (this.resolvedDeps.has(cacheKey)) {
      return this.resolvedDeps.get(cacheKey)!;
    }

    // Check if dependency has explicit URL from nimble file
    const hasExplicitUrl = !!dep.url;
    Logger.info(`[DEBUG] Resolving ${dep.name}@${dep.version}, hasExplicitUrl: ${hasExplicitUrl}, dep.url: ${dep.url}`);
    
    // Get URL from either explicit dep.url or registry lookup
    let url = dep.url || this.getGitHubUrl(dep.name) || '';
    
    // Only fetch actual package name from GitHub if:
    // 1. The dependency has an explicit URL (from nimble file requires)
    // 2. AND it's a GitHub URL
    // This avoids fetching for registry packages
    let actualPackageName = dep.name;
    if (hasExplicitUrl && url && url.includes('github.com')) {
      Logger.info(`[DEBUG] Fetching package name from GitHub: ${url}`);
      const fetchedName = await this.fetchPackageNameFromGitHub(url);
      if (fetchedName) {
        actualPackageName = fetchedName;
        Logger.info(`[DEBUG] Resolved ${dep.name} to actual package name: ${actualPackageName}`);
      } else {
        Logger.info(`[DEBUG] Could not fetch package name from GitHub, using original: ${dep.name}`);
      }
    } else {
      Logger.info(`[DEBUG] Skipping GitHub fetch: hasExplicitUrl=${hasExplicitUrl}, url=${url}`);
    }

    const installedVersion = await this.getLocalPackageVersion(actualPackageName);
    const installed = !!installedVersion;
    const selectedVersion = selectedVersions.get(dep.name) || dep.version;

    const pkg: NimblePackage = {
      name: actualPackageName,
      version: selectedVersion,
      dependencies: []
    };

    const resolvedDep: ResolvedDependency = {
      name: actualPackageName,
      version: selectedVersion,
      url,
      package: pkg,
      dependencies: [],
      installed
    };

    this.resolvedDeps.set(cacheKey, resolvedDep);
    return resolvedDep;
  }

  private async fetchPackageNameFromGitHub(url: string): Promise<string | null> {
    try {
      // Parse GitHub URL to get owner and repo
      const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
      if (!match) return null;
      
      const [, owner, repo] = match;
      
      // First, get the default branch
      const repoApiUrl = `https://api.github.com/repos/${owner}/${repo}`;
      const repoResponse = await fetch(repoApiUrl);
      if (!repoResponse.ok) {
        Logger.warn(`Failed to fetch repo info from GitHub API`);
        return null;
      }
      const repoInfo = await repoResponse.json();
      const defaultBranch = repoInfo.default_branch || 'master';
      
      // Get the file list from the repo root
      const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents?ref=${defaultBranch}`;
      const contentsResponse = await fetch(contentsUrl);
      if (!contentsResponse.ok) {
        Logger.warn(`Failed to fetch repo contents from GitHub API`);
        return null;
      }
      const contents = await contentsResponse.json();
      
      // Find the nimble file
      const nimbleFile = contents.find((file: any) => 
        file.type === 'file' && file.name.endsWith('.nimble')
      );
      
      if (!nimbleFile) {
        Logger.warn(`No nimble file found in repo ${owner}/${repo}`);
        return null;
      }
      
      Logger.info(`Found nimble file: ${nimbleFile.name}`);
      
      // Fetch the nimble file content
      const nimbleResponse = await fetch(nimbleFile.download_url);
      if (!nimbleResponse.ok) {
        Logger.warn(`Failed to fetch nimble file content`);
        // Fallback: use nimble file name (without extension) as package name
        return nimbleFile.name.replace(/\.nimble$/, '');
      }
      
      const content = await nimbleResponse.text();
      const extractedName = this.extractPackageName(content);
      
      // If no name field in nimble file, use the nimble file name (without extension)
      // This follows Nimble's convention where package name defaults to the nimble file name
      if (!extractedName) {
        const fallbackName = nimbleFile.name.replace(/\.nimble$/, '');
        Logger.info(`No name field in nimble file, using file name: ${fallbackName}`);
        return fallbackName;
      }
      
      return extractedName;
    } catch (error) {
      Logger.warn(`Error fetching package name from GitHub: ${error}`);
      return null;
    }
  }

  private extractPackageName(nimbleContent: string): string | null {
    // Extract package name from nimble file content
    // Look for "name = \"packagename\"" or "name = 'packagename'"
    const nameMatch = nimbleContent.match(/name\s*=\s*["']([^"']+)["']/);
    if (nameMatch) {
      return nameMatch[1];
    }
    return null;
  }

  private getGitHubUrl(packageName: string): string | null {
    return this.registry.getGitHubUrl(packageName);

  }
}
