import { readFile } from 'node:fs/promises';

export interface NimbleDependency {
  name: string;
  version: string;
  url: string;
}

export interface NimblePackage {
  name: string;
  version: string;
  author?: string;
  description?: string;
  license?: string;
  srcDir?: string;
  src?: string;
  bin?: string[];
  skipDirs?: string[];
  dependencies?: NimbleDependency[];
  features?: Record<string, NimbleDependency[]>;
}

export class NimbleParser {
  static async parseFile(filePath: string): Promise<NimblePackage> {
    const content = await readFile(filePath, 'utf8');
    return this.parseContent(content);
  }

  static parseContent(content: string): NimblePackage {
    const result: Record<string, any> = {};
    const dependencies: string[] = [];
    const features: Record<string, string[]> = {};

    // Remove comments and empty lines
    const lines = content.split('\n')
      .map(line => line.replace(/\s*#.*$/, ''))
      .filter(line => line.trim() !== '');

    // Find the begin and end blocks (optional)
    let inBlock = true; // Assume we're in a block by default
    let currentKey: string | null = null;
    let currentValue: string[] = [];
    let currentFeature: string | null = null;

    for (const line of lines) {
      if (line.trim() === 'begin') {
        inBlock = true;
        continue;
      }
      if (line.trim() === 'end') {
        // Process any remaining value
        if (currentKey) {
          result[currentKey] = this.parseValue(currentValue.join(' ').trim());
        }
        break;
      }
      if (!inBlock) {
        continue;
      }

      // Check for requires statements
      const requiresMatch = line.trim().match(/requires\s+(.+)$/);
      if (requiresMatch) {
        // Parse multiple dependencies separated by commas
        // Each dependency can be quoted with " or ` and may have a version constraint
        const depsStr = requiresMatch[1];
        // Split by comma to get individual dependencies
        const depParts = depsStr.split(',');
        for (const part of depParts) {
          // Extract content from matching quotes
          // Handle cases like: "pkg >= 1.0" or `https://...` or " `https://...` >= 1.0"
          // First try to match backtick-quoted content (for URLs), then double-quoted
          let quotedMatch = part.match(/`([^`]+)`/);
          if (!quotedMatch) {
            quotedMatch = part.match(/"([^"]+)"/);
          }
          if (quotedMatch) {
            let dep = quotedMatch[1].trim();
            // Check if there's a version constraint after the closing quote
            const versionMatch = part.match(/[`"][^`"]*[`"]\s*((?:>=|>|<=|<|==|!=)\s*[^,]+)/);
            if (versionMatch) {
              dep += ' ' + versionMatch[1].trim();
            }
            if (dep) {
              if (currentFeature) {
                if (!features[currentFeature]) {
                  features[currentFeature] = [];
                }
                features[currentFeature].push(dep);
              } else {
                dependencies.push(dep);
              }
            }
          }
        }
        continue;
      }

      // Check for feature blocks
      const featureMatch = line.trim().match(/feature\s+"([^"]+)"\s*:/);
      if (featureMatch) {
        // Process any previous value
        if (currentKey) {
          result[currentKey] = this.parseValue(currentValue.join(' ').trim());
          currentKey = null;
          currentValue = [];
        }
        currentFeature = featureMatch[1];
        features[currentFeature] = [];
        continue;
      }

      // Check if this line starts a new key-value pair
      const match = line.trim().match(/(\w+)\s*=\s*(.+)/);
      if (match) {
        // Process any previous value
        if (currentKey) {
          result[currentKey] = this.parseValue(currentValue.join(' ').trim());
        }

        // Start new key-value pair
        const [, key, value] = match;
        currentKey = key;
        currentValue = [value];
      } else {
        // Continue multi-line value
        if (currentKey) {
          currentValue.push(line.trim());
        }
      }
    }

    // Process any remaining value
    if (currentKey) {
      result[currentKey] = this.parseValue(currentValue.join(' ').trim());
    }

    // Add dependencies to result
    if (dependencies.length > 0) {
      result.dependencies = dependencies;
    }

    // Add features to result
    if (Object.keys(features).length > 0) {
      result.features = features;
    }

    // Parse features into NimbleDependency arrays
    const parsedFeatures: Record<string, NimbleDependency[]> = {};
    if (result.features) {
      for (const [featureName, featureDeps] of Object.entries(result.features as Record<string, string[]>)) {
        parsedFeatures[featureName] = this.parseDependencies(featureDeps);
      }
    }

    return {
      name: result.name,
      version: result.version,
      author: result.author,
      description: result.description,
      license: result.license,
      srcDir: result.srcDir,
      src: result.src,
      bin: result.bin,
      skipDirs: result.skipDirs,
      dependencies: this.parseDependencies(result.dependencies || []),
      features: Object.keys(parsedFeatures).length > 0 ? parsedFeatures : undefined
    };
  }

  private static parseValue(value: string): any {
    // Handle strings
    if (value.startsWith('"') && value.endsWith('"')) {
      return value.substring(1, value.length - 1);
    }

    // Handle Nim arrays with @ prefix
    if (value.startsWith('@[')) {
      const content = value.substring(2, value.length - 1).trim();
      if (content === '') {
        return [];
      }
      return content.split(',').map(item => item.trim().replace(/"/g, ''));
    }

    // Handle arrays
    if (value.startsWith('[') && value.endsWith(']')) {
      const content = value.substring(1, value.length - 1).trim();
      if (content === '') {
        return [];
      }
      return content.split(',').map(item => item.trim().replace(/"/g, ''));
    }

    // Handle objects (for bin field)
    if (value.startsWith('{') && value.endsWith('}')) {
      const content = value.substring(1, value.length - 1).trim();
      if (content === '') {
        return {};
      }
      const obj: Record<string, string> = {};
      for (const pair of content.split(',')) {
        const [key, val] = pair.trim().split(':').map(item => item.trim().replace(/"/g, ''));
        obj[key] = val;
      }
      return obj;
    }

    return value;
  }

  private static parseDependencies(deps: string[]): NimbleDependency[] {
    if (!deps || !Array.isArray(deps)) {
      return [];
    }
    return deps.map((dep: any) => {
      if (typeof dep === 'string') {
        // Remove extra spaces and quotes
        let cleanDep = dep.trim().replace(/^"|"$/g, '').trim();

        // Check if it's a git URL
        let url = '';
        let name = '';
        let version = '*';

        // Handle git URLs with optional version
        if (cleanDep.includes('https://')) {
          // Extract the git URL part (handles backticks around the entire URL)
          const urlMatch = cleanDep.match(/`?\s*(https:\/\/.+?)\s*`?\s*(?:>=\s+(.+))?$/);
          if (urlMatch) {
            url = urlMatch[1];
            version = urlMatch[2] || '*';
            // Extract name from URL
            name = url.split('/').pop()?.replace(/\.git$/, '') || '';
            // Remove [windy] suffix if present
            name = name.replace(/\[.*\]/, '');
          }
        } else {
          // Split into name and version
          const parts = cleanDep.split(/\s+>=\s+/);
          name = parts[0];
          version = parts[1] || '*';
        }

        return {
          name,
          version,
          url: url
        };
      }
      throw new Error(`Invalid dependency format: ${dep}`);
    });
  }
}
