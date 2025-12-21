import { Zip, AsyncZipDeflate } from 'fflate';
import { ScannedFile } from './fileScanner';

/**
 * Compresses multiple files into a single ZIP file.
 * Uses fflate for performance.
 */
export const compressFiles = (
  files: ScannedFile[],
  rootName: string
): Promise<File> => {
  return new Promise((resolve, reject) => {
    const zip = new Zip();
    const zipName = rootName.endsWith('.zip') ? rootName : `${rootName}.zip`;
    const chunks: Uint8Array[] = [];

    // Collect chunks of the ZIP file
    zip.ondata = (err, data, final) => {
      if (err) {
        reject(err);
        return;
      }
      chunks.push(data);
      if (final) {
        const blob = new Blob(chunks, { type: 'application/zip' });
        const file = new File([blob], zipName, {
          type: 'application/zip',
          lastModified: Date.now(),
        });
        resolve(file);
      }
    };

    // Add files to the ZIP
    const addFile = async (index: number) => {
      if (index >= files.length) {
        zip.end();
        return;
      }

      const { file, path } = files[index];
      const fileStream = new AsyncZipDeflate(path, {
        level: 6, // Default compression
      });

      zip.add(fileStream);

      // Read file and push to stream
      if (file.stream) {
        const reader = file.stream().getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            fileStream.push(new Uint8Array(0), true);
            break;
          }
          fileStream.push(value, false);
        }
      } else {
        // Fallback for older browsers
        const buffer = await file.arrayBuffer();
        fileStream.push(new Uint8Array(buffer), true);
      }

      addFile(index + 1);
    };

    addFile(0).catch(reject);
  });
};
