import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { calculateDirSha1Checksum } from '../src/utils/checksums';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

describe('checksums', () => {
  const testDir = join(import.meta.dir, 'fixtures', 'checksum_test');

  beforeEach(() => {
    // Create test directory
    mkdirSync(testDir, { recursive: true });
    
    // Create test files
    writeFileSync(join(testDir, 'file1.txt'), 'Hello World');
    writeFileSync(join(testDir, 'file2.txt'), 'Test Content');
    
    // Create subdirectory with files
    const subDir = join(testDir, 'subdir');
    mkdirSync(subDir);
    writeFileSync(join(subDir, 'file3.txt'), 'Subdirectory File');
  });

  afterEach(() => {
    // Clean up test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  test('calculateDirSha1Checksum should calculate consistent checksum', () => {
    const checksum1 = calculateDirSha1Checksum(testDir);
    const checksum2 = calculateDirSha1Checksum(testDir);
    
    expect(checksum1).toBe(checksum2);
    expect(checksum1).toMatch(/^[a-f0-9]{40}$/); // SHA1 produces 40-character hex string
  });

  test('calculateDirSha1Checksum should respect skipDirs', () => {
    // Calculate checksum without skipping subdir
    const checksumWithSubdir = calculateDirSha1Checksum(testDir);
    
    // Calculate checksum skipping subdir
    const checksumWithoutSubdir = calculateDirSha1Checksum(testDir, ['subdir']);
    
    expect(checksumWithSubdir).not.toBe(checksumWithoutSubdir);
  });

  test('calculateDirSha1Checksum should handle empty directories', () => {
    const emptyDir = join(testDir, 'empty');
    mkdirSync(emptyDir);
    
    const checksum = calculateDirSha1Checksum(emptyDir);
    expect(checksum).toMatch(/^[a-f0-9]{40}$/);
  });
});