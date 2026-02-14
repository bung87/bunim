import { NimbleDependency, NimblePackage, NimbleParser } from '../parser/nimbleParser';
import { GitHubClient } from '../git/githubClient';

export interface ResolvedDependency {
  name: string;
  version: string;
  url: string;
  package: NimblePackage;
  dependencies: ResolvedDependency[];
}

export class DependencyResolver {
  private gitHubClient: GitHubClient;
  private resolvedDeps: Map<string, ResolvedDependency> = new Map();
  
  constructor() {
    this.gitHubClient = new GitHubClient();
  }
  
  async resolve(pkg: NimblePackage): Promise<ResolvedDependency[]> {
    const allDeps = [...(pkg.dependencies || [])];
    const resolved: ResolvedDependency[] = [];
    
    for (const dep of allDeps) {
      const resolvedDep = await this.resolveDependency(dep);
      resolved.push(resolvedDep);
    }
    
    return resolved;
  }
  
  async resolveDependency(dep: NimbleDependency): Promise<ResolvedDependency> {
    const cacheKey = `${dep.name}@${dep.version}`;
    
    if (this.resolvedDeps.has(cacheKey)) {
      return this.resolvedDeps.get(cacheKey)!;
    }
    
    // Determine the repository URL
    const url = dep.url || this.getGitHubUrl(dep.name);
    
    // Clone the repository to a temporary directory
    const tempDir = await this.gitHubClient.clone(url);
    
    // Parse the nimble file
    const nimbleFile = `${tempDir}/${dep.name}.nimble`;
    const pkg = await NimbleParser.parseFile(nimbleFile);
    
    // Resolve nested dependencies
    const nestedDeps: ResolvedDependency[] = [];
    for (const nestedDep of [...(pkg.dependencies || [])]) {
      const resolvedNested = await this.resolveDependency(nestedDep);
      nestedDeps.push(resolvedNested);
    }
    
    const resolvedDep: ResolvedDependency = {
      name: dep.name,
      version: dep.version,
      url,
      package: pkg,
      dependencies: nestedDeps
    };
    
    this.resolvedDeps.set(cacheKey, resolvedDep);
    return resolvedDep;
  }
  
  private getGitHubUrl(packageName: string): string {
    // Default to nim-lang organization for now
    // In a real implementation, we'd have a registry or mapping
    return `https://github.com/nim-lang/${packageName}`;
  }
}