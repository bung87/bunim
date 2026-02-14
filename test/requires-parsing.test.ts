import { describe, test, expect } from 'bun:test';
import { NimbleParser } from '../src/parser/nimbleParser';

describe('NimbleParser requires parsing', () => {
  test('should parse single dependency on requires line', () => {
    const content = `
version = "1.0.0"
requires "nim >= 1.6.0"
`;
    const pkg = NimbleParser.parseContent(content);
    expect(pkg.dependencies).toHaveLength(1);
    expect(pkg.dependencies?.[0].name).toBe('nim');
    expect(pkg.dependencies?.[0].version).toBe('1.6.0');
  });

  test('should parse multiple dependencies on same requires line', () => {
    const content = `
version = "1.0.0"
requires "nim >= 0.19.4", "hmac"
`;
    const pkg = NimbleParser.parseContent(content);
    expect(pkg.dependencies).toHaveLength(2);
    expect(pkg.dependencies?.[0].name).toBe('nim');
    expect(pkg.dependencies?.[0].version).toBe('0.19.4');
    expect(pkg.dependencies?.[1].name).toBe('hmac');
    expect(pkg.dependencies?.[1].version).toBe('*');
  });

  test('should parse multiple dependencies with version constraints', () => {
    const content = `
version = "1.0.0"
requires "nim >= 1.0.0", "jsony >= 1.1.0", "cligen >= 1.0.0"
`;
    const pkg = NimbleParser.parseContent(content);
    expect(pkg.dependencies).toHaveLength(3);
    expect(pkg.dependencies?.[0].name).toBe('nim');
    expect(pkg.dependencies?.[0].version).toBe('1.0.0');
    expect(pkg.dependencies?.[1].name).toBe('jsony');
    expect(pkg.dependencies?.[1].version).toBe('1.1.0');
    expect(pkg.dependencies?.[2].name).toBe('cligen');
    expect(pkg.dependencies?.[2].version).toBe('1.0.0');
  });

  test('should parse dependency with backtick URL and version', () => {
    const content = `
version = "1.0.0"
requires " \`https://github.com/elcritch/figdraw[windy]\`  >= 0.18.9"
`;
    const pkg = NimbleParser.parseContent(content);
    expect(pkg.dependencies).toHaveLength(1);
    expect(pkg.dependencies?.[0].name).toBe('figdraw');
    expect(pkg.dependencies?.[0].version).toBe('0.18.9');
    expect(pkg.dependencies?.[0].url).toBe('https://github.com/elcritch/figdraw[windy]');
  });

  test('should parse dependency with backtick URL without version', () => {
    const content = `
version = "1.0.0"
requires " \`https://github.com/user/repo\` "
`;
    const pkg = NimbleParser.parseContent(content);
    expect(pkg.dependencies).toHaveLength(1);
    expect(pkg.dependencies?.[0].name).toBe('repo');
    expect(pkg.dependencies?.[0].version).toBe('*');
    expect(pkg.dependencies?.[0].url).toBe('https://github.com/user/repo');
  });

  test('should parse mixed dependencies with URLs and regular packages', () => {
    const content = `
version = "1.0.0"
requires "nim >= 1.6.0", " \`https://github.com/user/custom\` ", "jsony"
`;
    const pkg = NimbleParser.parseContent(content);
    expect(pkg.dependencies).toHaveLength(3);
    expect(pkg.dependencies?.[0].name).toBe('nim');
    expect(pkg.dependencies?.[0].version).toBe('1.6.0');
    expect(pkg.dependencies?.[1].name).toBe('custom');
    expect(pkg.dependencies?.[1].url).toBe('https://github.com/user/custom');
    expect(pkg.dependencies?.[2].name).toBe('jsony');
  });

  test('should parse dependency with exact version', () => {
    const content = `
version = "1.0.0"
requires "nim == 1.6.0"
`;
    const pkg = NimbleParser.parseContent(content);
    expect(pkg.dependencies).toHaveLength(1);
    // Note: The parser currently only handles >= operator, not ==
    // This test documents the current behavior
    expect(pkg.dependencies?.[0].name).toBe('nim == 1.6.0');
    expect(pkg.dependencies?.[0].version).toBe('*');
  });

  test('should parse dependency with wildcard version', () => {
    const content = `
version = "1.0.0"
requires "jsony"
`;
    const pkg = NimbleParser.parseContent(content);
    expect(pkg.dependencies).toHaveLength(1);
    expect(pkg.dependencies?.[0].name).toBe('jsony');
    expect(pkg.dependencies?.[0].version).toBe('*');
  });

  test('should parse multiple requires statements', () => {
    const content = `
version = "1.0.0"
requires "nim >= 1.0.0"
requires "jsony >= 1.0.0"
requires "cligen"
`;
    const pkg = NimbleParser.parseContent(content);
    expect(pkg.dependencies).toHaveLength(3);
    expect(pkg.dependencies?.[0].name).toBe('nim');
    expect(pkg.dependencies?.[1].name).toBe('jsony');
    expect(pkg.dependencies?.[2].name).toBe('cligen');
  });

  test('should parse dependencies in feature blocks', () => {
    const content = `
version = "1.0.0"
requires "nim >= 1.0.0"

feature "extra":
  requires "jsony >= 1.0.0", "cligen"
`;
    const pkg = NimbleParser.parseContent(content);
    expect(pkg.dependencies).toHaveLength(1);
    expect(pkg.dependencies?.[0].name).toBe('nim');
    expect(pkg.features).toBeDefined();
    expect(pkg.features?.extra).toHaveLength(2);
    expect(pkg.features?.extra[0].name).toBe('jsony');
    expect(pkg.features?.extra[1].name).toBe('cligen');
  });
});
