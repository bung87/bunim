#!/usr/bin/env bun
import { symlink, access, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'path';
import { execSync } from 'node:child_process';
import os from 'os';

const isWindows = process.platform === 'win32';

function getGlobalBinDir(): string {
  // Check common global bin directories
  const possibleDirs = [
    join(os.homedir(), '.local', 'bin'),
    join(os.homedir(), '.bun', 'bin'),
    '/usr/local/bin',
    '/opt/local/bin',
  ];

  // On macOS with Homebrew, check brew prefix
  try {
    const brewPrefix = execSync('brew --prefix', { encoding: 'utf8' }).trim();
    possibleDirs.unshift(join(brewPrefix, 'bin'));
  } catch {
    // Homebrew not available
  }

  // Return the first writable directory or default to ~/.local/bin
  return possibleDirs[0];
}

async function link() {
  const projectDir = process.cwd();
  const binDir = getGlobalBinDir();
  const targetPath = join(projectDir, 'index.ts');

  // Check if index.ts exists
  try {
    await access(targetPath);
  } catch {
    console.error('❌ Error: index.ts not found in current directory');
    console.error('   Make sure you run this from the bunim project root');
    process.exit(1);
  }

  // Create bin directory if it doesn't exist
  try {
    await mkdir(binDir, { recursive: true });
  } catch (error) {
    console.warn(`⚠️  Warning: Could not create ${binDir}`);
  }

  const linkPath = join(binDir, 'bunim');

  // Remove existing link if it exists
  try {
    await rm(linkPath, { force: true });
    console.log(`🗑️  Removed existing link at ${linkPath}`);
  } catch {
    // No existing link
  }

  // Create the wrapper script
  const wrapperContent = `#!/bin/sh
exec bun run ${targetPath} "$@"
`;

  const wrapperPath = join(binDir, 'bunim');

  try {
    await Bun.write(wrapperPath, wrapperContent);
    // Make it executable (Unix only)
    if (!isWindows) {
      execSync(`chmod +x ${wrapperPath}`);
    }
    console.log(`✅ Linked bunim to ${wrapperPath}`);
    console.log(`   You can now use 'bunim' from anywhere`);

    // Check if binDir is in PATH
    const pathEnv = process.env.PATH || '';
    if (!pathEnv.includes(binDir)) {
      console.log(`\n⚠️  Warning: ${binDir} is not in your PATH`);
      console.log(`   Add the following to your shell profile (~/.bashrc, ~/.zshrc, etc.):`);
      console.log(`   export PATH="${binDir}:$PATH"`);
    }
  } catch (error) {
    console.error(`❌ Failed to create link: ${error}`);
    process.exit(1);
  }
}

async function unlink() {
  const binDir = getGlobalBinDir();
  const linkPath = join(binDir, 'bunim');

  try {
    await rm(linkPath, { force: true });
    console.log(`✅ Removed bunim from ${linkPath}`);
  } catch (error) {
    console.error(`❌ Failed to remove link: ${error}`);
    process.exit(1);
  }
}

const command = process.argv[2];

if (command === 'unlink') {
  unlink();
} else {
  link();
}
