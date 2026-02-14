import { describe, test, expect } from 'bun:test';
import { NimbleParser } from '../src/parser/nimbleParser';

describe('NimbleParser.parseValue', () => {
  test('should parse array with @ syntax', () => {
    const result = NimbleParser.parseValue('@["tests", "docs", "examples"]');
    expect(result).toEqual(['tests', 'docs', 'examples']);
  });

  test('should parse regular array syntax', () => {
    const result = NimbleParser.parseValue('["tests", "docs", "examples"]');
    expect(result).toEqual(['tests', 'docs', 'examples']);
  });

  test('should parse string values', () => {
    const result = NimbleParser.parseValue('"test"');
    expect(result).toBe('test');
  });

  test('should parse number values', () => {
    const result = NimbleParser.parseValue('1.0.0');
    expect(result).toBe('1.0.0');
  });

  test('should handle empty arrays', () => {
    const result = NimbleParser.parseValue('@[]');
    expect(result).toEqual([]);
  });

  test('should handle empty strings', () => {
    const result = NimbleParser.parseValue('""');
    expect(result).toBe('');
  });
});