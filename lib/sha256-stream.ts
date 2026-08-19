// Incremental SHA-256 for large browser-owned strings/blobs. Web Crypto's
// digest() requires one complete ArrayBuffer, which duplicates a large backup
// or media file in JS memory. This implementation keeps only one 64-byte block
// plus a bounded TextEncoder chunk.

const INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

class IncrementalSha256 {
  private readonly state = new Uint32Array(INITIAL);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private blockLength = 0;
  private bytesHashed = 0;
  private finished = false;

  update(input: Uint8Array): void {
    if (this.finished) throw new Error("SHA-256 has already been finalized");
    this.bytesHashed += input.byteLength;
    let offset = 0;
    while (offset < input.byteLength) {
      const take = Math.min(64 - this.blockLength, input.byteLength - offset);
      this.block.set(input.subarray(offset, offset + take), this.blockLength);
      this.blockLength += take;
      offset += take;
      if (this.blockLength === 64) {
        this.transform(this.block);
        this.blockLength = 0;
      }
    }
  }

  digestHex(): string {
    if (!this.finished) {
      const bitLength = this.bytesHashed * 8;
      this.block[this.blockLength++] = 0x80;
      if (this.blockLength > 56) {
        this.block.fill(0, this.blockLength);
        this.transform(this.block);
        this.blockLength = 0;
      }
      this.block.fill(0, this.blockLength, 56);
      const high = Math.floor(bitLength / 0x100000000);
      const low = bitLength >>> 0;
      for (let i = 0; i < 4; i += 1) {
        this.block[56 + i] = (high >>> (24 - i * 8)) & 0xff;
        this.block[60 + i] = (low >>> (24 - i * 8)) & 0xff;
      }
      this.transform(this.block);
      this.finished = true;
    }
    return Array.from(this.state).map((word) => word.toString(16).padStart(8, "0")).join("");
  }

  private transform(chunk: Uint8Array): void {
    const w = this.words;
    for (let i = 0; i < 16; i += 1) {
      const j = i * 4;
      w[i] = ((chunk[j] << 24) | (chunk[j + 1] << 16) | (chunk[j + 2] << 8) | chunk[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.state;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

export async function sha256BlobHex(blob: Blob): Promise<string> {
  const hash = new IncrementalSha256();
  if (typeof blob.stream === "function") {
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    // Older iOS WebViews expose Blob.slice()/arrayBuffer() but not Blob.stream().
    // Slice into bounded chunks instead of allocating the whole file at once.
    const chunkBytes = 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += chunkBytes) {
      hash.update(new Uint8Array(await blob.slice(offset, offset + chunkBytes).arrayBuffer()));
    }
  }
  return hash.digestHex();
}

export async function sha256TextHex(text: string): Promise<string> {
  const hash = new IncrementalSha256();
  const encoder = new TextEncoder();
  const chunkChars = 256 * 1024;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + chunkChars);
    // Do not split a UTF-16 surrogate pair between TextEncoder calls.
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    hash.update(encoder.encode(text.slice(start, end)));
    start = end;
  }
  return hash.digestHex();
}
