'use strict';

const CHUNK_BYTES = 65536; // 64 KiB

// Groups parsed file blocks into chunks of at most CHUNK_BYTES, never
// splitting a single file across chunks. A single file larger than
// CHUNK_BYTES becomes its own (oversized) chunk.
function chunkFiles(files) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;

  for (const file of files) {
    if (current.length > 0 && currentBytes + file.rawLength > CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.rawLength;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

module.exports = { chunkFiles, CHUNK_BYTES };
