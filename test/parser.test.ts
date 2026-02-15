import { describe, test, expect } from 'bun:test';
import { NimbleParser } from '../src/parser/nimbleParser';

describe('NimbleParser', () => {
  test('should parse test.nimble file correctly', async () => {
    const pkg = await NimbleParser.parseFile('./test/fixtures/test.nimble');

    expect(pkg.name).toBeUndefined(); // Name is not defined in test.nimble
    expect(pkg.version).toBe('0.5.16');
    expect(pkg.author).toBe('Jaremy Creechley');
    expect(pkg.description).toBe('Neovim backend in Nim and FigDraw');
    expect(pkg.license).toBe('MPL2');
    expect(pkg.srcDir).toBe('src');
    expect(pkg.bin).toEqual(['neonim']);

    // Check dependencies
    expect(pkg.dependencies).toHaveLength(4);
    expect(pkg.dependencies?.[0].name).toBe('nim');
    expect(pkg.dependencies?.[0].version).toBe('2.2.6');

    // Check features
    expect(pkg.features).toBeDefined();
    expect(pkg.features?.references).toHaveLength(3);
  });

  test('should handle missing file gracefully', () => {
    expect(async () => {
      await NimbleParser.parseFile('./nonexistent.nimble');
    }).toThrow();
  });

  test('should parse opengl.nimble file correctly with srcDir', async () => {
    const pkg = await NimbleParser.parseFile('./test/fixtures/opengl.nimble');

    expect(pkg.version).toBe('1.2.9');
    expect(pkg.author).toBe('Andreas Rumpf');
    expect(pkg.description).toBe('an OpenGL wrapper');
    expect(pkg.license).toBe('MIT');
    expect(pkg.srcDir).toBe('src');

    // Check dependencies - should have nim and x11 (platform-specific)
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies?.length).toBeGreaterThanOrEqual(1);

    // Verify nim dependency exists
    const nimDep = pkg.dependencies?.find(d => d.name === 'nim');
    expect(nimDep).toBeDefined();
    expect(nimDep?.version).toBe('0.11.0');
  });
});
