import { writeFile } from 'node:fs/promises';
import { join, relative } from 'path';
import { Logger } from './logger';

/**
 * Download method for package installation
 * - git: Installed via git clone
 * - http: Installed via HTTP download (tar.gz archive)
 */
export type DownloadMethod = 'git' | 'http';

/**
 * Package metadata structure matching nimble's nimblemeta.json format
 */
export interface PackageMetaData {
  url: string;
  downloadMethod: DownloadMethod;
  vcsRevision: string;
  files: string[];
  binaries: string[];
  specialVersions: string[];
}

/**
 * nimblemeta.json file structure
 */
export interface NimbleMetaFile {
  version: number;
  metaData: PackageMetaData;
}

const PACKAGE_META_DATA_FILE_VERSION = 1;
const PACKAGE_META_DATA_FILE_NAME = 'nimblemeta.json';

/**
 * Initialize empty package metadata
 */
export function initPackageMetaData(): PackageMetaData {
  return {
    url: '',
    downloadMethod: 'http',
    vcsRevision: '0000000000000000000000000000000000000000',
    files: [],
    binaries: [],
    specialVersions: []
  };
}

/**
 * Save package metadata to nimblemeta.json file in the package directory
 * 
 * @param metaData - The package metadata to save
 * @param dirName - The package installation directory
 * @param changeRoots - Whether to convert absolute paths to relative paths (default: true)
 */
export async function saveMetaData(
  metaData: PackageMetaData,
  dirName: string,
  changeRoots: boolean = true
): Promise<void> {
  const metaDataWithChangedPaths = changeRoots
    ? {
        ...metaData,
        files: metaData.files.map(file => 
          file.startsWith(dirName) ? relative(dirName, file) : file
        )
      }
    : metaData;

  const metaFile: NimbleMetaFile = {
    version: PACKAGE_META_DATA_FILE_VERSION,
    metaData: metaDataWithChangedPaths
  };

  const filePath = join(dirName, PACKAGE_META_DATA_FILE_NAME);
  
  try {
    await writeFile(filePath, JSON.stringify(metaFile, null, 2));
    Logger.info(`Saved ${PACKAGE_META_DATA_FILE_NAME} to ${dirName}`);
  } catch (error) {
    Logger.error(`Failed to save ${PACKAGE_META_DATA_FILE_NAME}:`, error);
    throw error;
  }
}

/**
 * Create package metadata for a newly installed package
 * 
 * @param url - The package URL (GitHub URL or other source)
 * @param downloadMethod - The download method used ('git' or 'http')
 * @param vcsRevision - The VCS revision (commit hash for git, or checksum for http)
 * @param files - List of installed files (relative paths)
 * @param binaries - List of binary files
 * @param specialVersions - Special version aliases (e.g., '#head', '#master')
 * @returns PackageMetaData object
 */
export function createPackageMetaData(
  url: string,
  downloadMethod: DownloadMethod,
  vcsRevision: string,
  files: string[] = [],
  binaries: string[] = [],
  specialVersions: string[] = []
): PackageMetaData {
  return {
    url,
    downloadMethod,
    vcsRevision,
    files,
    binaries,
    specialVersions
  };
}
