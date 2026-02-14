import { NimbleDependency, NimblePackage } from '../parser/nimbleParser';
import { readdir, access } from 'node:fs/promises';
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
          if (!Bun.semver.satisfies(nimVersion, range)) {
            Logger.warn(`Installed Nim version ${nimVersion} does not satisfy required range ${range}`);
          }
        } catch {
          // If semver check fails, just warn
          Logger.warn(`Could not verify Nim version against range ${range}`);
        }
      }
      return clauses; // Return empty clauses - nim is a system dependency
    }

    const versions = allDeps.get(depName) || [];

    // Filter versions that satisfy the range
    const validVersions = versions.filter(v => {
      if (range === '*' || range === '') return true;
      try {
        return Bun.semver.satisfies(v, range);
      } catch {
        return v === range; // Exact version match
      }
    });

    if (validVersions.length === 0) {
      throw new Error(`No version of ${depName} satisfies range ${range}`);
    }

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
      const packageDirs = packages.filter((dir: string) => dir.startsWith(`${packageName}-`));

      if (packageDirs.length === 0) {
        return null;
      }

      const versions = packageDirs.map((dir: string) => {
        const versionMatch = dir.match(/^[^-]+-(.+)$/);
        return versionMatch ? versionMatch[1] : '0.0.0';
      });

      versions.sort((a: string, b: string) => Bun.semver.order(b, a));
      return versions[0];
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

    const url = dep.url || this.getGitHubUrl(dep.name);
    const installedVersion = await this.getLocalPackageVersion(dep.name);
    const installed = !!installedVersion;
    const selectedVersion = selectedVersions.get(dep.name) || dep.version;

    const pkg: NimblePackage = {
      name: dep.name,
      version: selectedVersion,
      dependencies: []
    };

    const resolvedDep: ResolvedDependency = {
      name: dep.name,
      version: selectedVersion,
      url,
      package: pkg,
      dependencies: [],
      installed
    };

    this.resolvedDeps.set(cacheKey, resolvedDep);
    return resolvedDep;
  }

  private getGitHubUrl(packageName: string): string {
    const githubUrl = this.registry.getGitHubUrl(packageName);
    if (githubUrl) {
      return githubUrl;
    }
    return `https://github.com/nim-lang/${packageName}`;
  }
}
