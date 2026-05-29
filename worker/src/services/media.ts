/** Portfolio image pipeline — portfolio_TZ.md §6. */

import decodeJpeg from '@jsquash/jpeg/decode';
import decodePng from '@jsquash/png/decode';
import decodeWebp from '@jsquash/webp/decode';
import encodeWebp from '@jsquash/webp/encode';
import resize from '@jsquash/resize';

export type MediaErrorCode =
  | 'portfolio_invalid_type'
  | 'portfolio_too_large'
  | 'portfolio_compress_failed';

export type ValidateImageResult =
  | { ok: true; mime: string }
  | { ok: false; code: MediaErrorCode };

export type CompressWebpResult =
  | { ok: true; data: Uint8Array; width: number; height: number; byteSize: number }
  | { ok: false; code: MediaErrorCode };

const INPUT_MAX_BYTES = 8 * 1024 * 1024;
const OUTPUT_TARGET_BYTES = 400 * 1024;
const OUTPUT_HARD_CAP_BYTES = 600 * 1024;
const MAX_LONG_EDGE = 1920;

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) {
    return null;
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }

  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

function calcResizeDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= MAX_LONG_EDGE) {
    return { width, height };
  }
  const scale = MAX_LONG_EDGE / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decodeImage(
  bytes: Uint8Array,
  mime: string,
): Promise<ImageData | null> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  try {
    if (mime === 'image/jpeg') {
      return await decodeJpeg(buffer);
    }
    if (mime === 'image/png') {
      return await decodePng(buffer);
    }
    if (mime === 'image/webp') {
      return await decodeWebp(buffer);
    }
  } catch {
    return null;
  }

  return null;
}

export async function validateImageBytes(
  bytes: Uint8Array,
): Promise<ValidateImageResult> {
  if (bytes.byteLength > INPUT_MAX_BYTES) {
    return { ok: false, code: 'portfolio_too_large' };
  }

  const mime = detectImageMime(bytes);
  if (!mime || !ALLOWED_MIMES.has(mime)) {
    return { ok: false, code: 'portfolio_invalid_type' };
  }

  return { ok: true, mime };
}

export async function compressToWebp(
  bytes: Uint8Array,
  mime: string,
): Promise<CompressWebpResult> {
  const image = await decodeImage(bytes, mime);
  if (!image) {
    return { ok: false, code: 'portfolio_invalid_type' };
  }

  const target = calcResizeDimensions(image.width, image.height);
  const resized =
    target.width !== image.width || target.height !== image.height
      ? await resize(image, {
          width: target.width,
          height: target.height,
          method: 'lanczos3',
          fitMethod: 'stretch',
        })
      : image;

  const qualities = [82, 75, 68, 60, 52, 45, 38];
  let best: Uint8Array | null = null;

  for (const quality of qualities) {
    const encoded = await encodeWebp(resized, { quality });
    const out = new Uint8Array(encoded);
    if (!best || out.byteLength < best.byteLength) {
      best = out;
    }
    if (out.byteLength <= OUTPUT_TARGET_BYTES) {
      return {
        ok: true,
        data: out,
        width: resized.width,
        height: resized.height,
        byteSize: out.byteLength,
      };
    }
  }

  if (!best || best.byteLength > OUTPUT_HARD_CAP_BYTES) {
    return { ok: false, code: 'portfolio_compress_failed' };
  }

  return {
    ok: true,
    data: best,
    width: resized.width,
    height: resized.height,
    byteSize: best.byteLength,
  };
}

export async function putR2(
  bucket: R2Bucket,
  key: string,
  data: Uint8Array,
  contentType = 'image/webp',
): Promise<void> {
  await bucket.put(key, data, {
    httpMetadata: { contentType },
  });
}

export async function deleteR2Keys(bucket: R2Bucket, keys: string[]): Promise<void> {
  const unique = [...new Set(keys.filter((k) => k && k.length > 0))];
  await Promise.all(unique.map((key) => bucket.delete(key)));
}
