/**
 * MD5 на чистом JS.
 *
 * Нужен потому, что Яндекс.Диск отдаёт md5 каждого файла прямо в листинге —
 * это позволяет определять изменения точно, не полагаясь на mtime.
 * node:crypto использовать нельзя: на iOS/Android его нет.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = (() => {
  const k = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  }
  return k;
})();

function transform(state: Int32Array, M: Int32Array): void {
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];

  for (let i = 0; i < 64; i++) {
    let f: number;
    let g: number;

    if (i < 16) {
      f = (b & c) | (~b & d);
      g = i;
    } else if (i < 32) {
      f = (d & b) | (~d & c);
      g = (5 * i + 1) & 15;
    } else if (i < 48) {
      f = b ^ c ^ d;
      g = (3 * i + 5) & 15;
    } else {
      f = c ^ (b | ~d);
      g = (7 * i) & 15;
    }

    const prevD = d;
    d = c;
    c = b;

    const sum = (a + f + K[i] + M[g]) | 0;
    const sh = S[i];
    b = (b + ((sum << sh) | (sum >>> (32 - sh)))) | 0;
    a = prevD;
  }

  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
}

function toHex(state: Int32Array): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    const w = state[i];
    for (let j = 0; j < 4; j++) {
      out += ((w >>> (j * 8)) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return out;
}

/** Считает md5 без копирования всего буфера — целые блоки читаются на месте. */
export function md5(input: ArrayBuffer | Uint8Array): string {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const state = Int32Array.from([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const M = new Int32Array(16);

  const view = new DataView(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  const fullBlocks = data.byteLength - (data.byteLength % 64);

  for (let off = 0; off < fullBlocks; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getInt32(off + i * 4, true);
    transform(state, M);
  }

  // Хвост + паддинг: 64 байта хватает, если остаток меньше 56, иначе нужен ещё один блок.
  const rem = data.byteLength - fullBlocks;
  const tailLen = rem < 56 ? 64 : 128;
  const tail = new Uint8Array(tailLen);
  tail.set(data.subarray(fullBlocks));
  tail[rem] = 0x80;

  const tailView = new DataView(tail.buffer);
  const bits = data.byteLength * 8;
  tailView.setUint32(tailLen - 8, bits >>> 0, true);
  tailView.setUint32(tailLen - 4, Math.floor(bits / 4294967296), true);

  for (let off = 0; off < tailLen; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = tailView.getInt32(off + i * 4, true);
    transform(state, M);
  }

  return toHex(state);
}
