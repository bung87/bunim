import { readdir } from 'node:fs/promises';
import { join } from 'path';
import { Logger } from './logger';

export async function findNimbleFile(dirPath: string = '.'): Promise<string | null> {
  try {
    const entries = await readdir(dirPath);
    const nimbleFiles = entries.filter((entry: string) => entry.endsWith('.nimble'));
    
    if (nimbleFiles.length === 0) {
      return null;
    }
    
    if (nimbleFiles.length > 1) {
      Logger.warn(`Multiple .nimble files found in ${dirPath}: ${nimbleFiles.join(', ')}`);
      Logger.warn(`Using: ${nimbleFiles[0]}`);
    }
    
    return join(dirPath, nimbleFiles[0]);
  } catch (error) {
    Logger.warn(`Error reading directory ${dirPath}: ${error}`);
    return null;
  }
}
