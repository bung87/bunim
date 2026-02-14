import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'path';

interface TarHeader {
  filename: string;
  size: number;
  type: string;
  headerSize: number;
}

export class TarExtractor {
  private buffer: Uint8Array;
  private offset: number = 0;

  constructor(buffer: ArrayBuffer | Uint8Array) {
    this.buffer = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  }

  async extract(targetDir: string): Promise<string[]> {
    const extractedFiles: string[] = [];

    while (this.offset < this.buffer.length) {
      const block = this.buffer.slice(this.offset, this.offset + 512);

      // Check if this is the end of the archive
      if (block.every(b => b === 0)) {
        break;
      }

      const header = this.parseHeader(block);
      if (!header) {
        this.offset += 512;
        continue;
      }

      // Skip special headers
      if (header.type === 'g' || header.type === 'x' || header.type === 'X') {
        this.offset += 512 + Math.ceil(header.size / 512) * 512;
        continue;
      }

      // Process based on type
      if (header.type === '0' || header.type === '\0' || header.type === '') { // Regular file
        if (header.size > 0) {
          const filePath = join(targetDir, header.filename);
          const fileData = this.buffer.slice(this.offset + 512, this.offset + 512 + header.size);

          // Create directory if it doesn't exist
          await mkdir(dirname(filePath), { recursive: true });

          // Write file
          await writeFile(filePath, fileData);
          extractedFiles.push(filePath);
        }
      } else if (header.type === '5') { // Directory
        const dirPath = join(targetDir, header.filename);
        await mkdir(dirPath, { recursive: true });
        extractedFiles.push(dirPath);
      }

      // Move to next record
      this.offset += 512 + Math.ceil(header.size / 512) * 512;
    }

    return extractedFiles;
  }

  private parseHeader(header: Uint8Array): TarHeader | null {
    if (header.length < 512) return null;

    const textDecoder = new TextDecoder();

    // Check if this is a valid tar header
    const magic = textDecoder.decode(header.slice(257, 263));
    if (magic !== 'ustar\0' && magic !== 'ustar\x000') {
      // Try to detect end of archive (null blocks)
      const isNullBlock = header.every(byte => byte === 0);
      if (isNullBlock) return null;

      // If not ustar format, try basic parsing
      return this.parseBasicHeader(header);
    }

    // Parse ustar header
    const filename = this.cleanString(textDecoder.decode(header.slice(0, 100)));
    const sizeStr = this.cleanString(textDecoder.decode(header.slice(124, 136)));
    const size = parseInt(sizeStr, 8); // Octal
    const type = textDecoder.decode(header.slice(156, 157));

    return {
      filename,
      size,
      type,
      headerSize: 512
    };
  }

  private parseBasicHeader(header: Uint8Array): TarHeader | null {
    const textDecoder = new TextDecoder();

    try {
      const filename = this.cleanString(textDecoder.decode(header.slice(0, 100)));
      const sizeStr = this.cleanString(textDecoder.decode(header.slice(124, 136)));
      const size = parseInt(sizeStr, 8);

      if (isNaN(size) || size < 0) return null;

      return {
        filename,
        size,
        type: '0', // Assume regular file
        headerSize: 512
      };
    } catch {
      return null;
    }
  }

  private cleanString(str: string): string {
    return str.replace(/\0.*$/, '').trim(); // Remove null terminators and whitespace
  }
}

export async function extractTar(tarBuffer: ArrayBuffer | Uint8Array, targetDir: string): Promise<string[]> {
  const extractor = new TarExtractor(tarBuffer);
  return extractor.extract(targetDir);
}
