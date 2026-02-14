import { describe, test, expect } from 'bun:test';
import { NimbleParser } from '../src/parser/nimbleParser';
import { readFile } from 'node:fs/promises';

describe('NimbleParser with skipDirs', () => {
  test('should parse package with skipDirs correctly', async () => {
    const content = await readFile('./test/fixtures/test_skipdirs.nimble', 'utf8');
    const pkg = NimbleParser.parseContent(content);

    expect(pkg.name).toBe('test_skipdirs');
    expect(pkg.version).toBe('1.0.0');
    expect(pkg.skipDirs).toEqual(['tests', 'docs', 'examples']);

  });

  test('should parse package content without reading file', () => {
    const content = `
version = "2.0.0"
name = "test_package"
skipDirs = @["node_modules", "dist"]
    `;

    const pkg = NimbleParser.parseContent(content);

    expect(pkg.name).toBe('test_package');
    expect(pkg.version).toBe('2.0.0');
    expect(pkg.skipDirs).toEqual(['node_modules', 'dist']);
  });

  test('should handle packages without skipDirs', () => {
    const content = `
version = "1.0.0"
name = "simple_package"
    `;

    const pkg = NimbleParser.parseContent(content);

    expect(pkg.name).toBe('simple_package');
    expect(pkg.version).toBe('1.0.0');
    expect(pkg.skipDirs).toBeUndefined();
  });
});
