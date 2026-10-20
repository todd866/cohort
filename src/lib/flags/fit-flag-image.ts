import { FLAG_IMAGE_MAX_PIXELS, FLAG_IMAGE_MIME_TYPES, FLAG_IMAGE_PASSTHROUGH_BYTES } from './image-contract';

/** Long edge after shrinking: enough to read a screenshot, a fraction of the bytes. */
const MAX_EDGE = 2560;
const QUALITIES = [0.85, 0.72, 0.6] as const;

type Source = { width: number; height: number; close?: () => void };
export interface FitDeps {
  decode(file: File): Promise<Source>;
  encode(source: Source, width: number, height: number, type: string, quality: number): Promise<Blob>;
}

export function fitDimensions(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const edge = Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(FLAG_IMAGE_MAX_PIXELS / (width * height)));
  return { width: Math.max(1, Math.round(width * edge)), height: Math.max(1, Math.round(height * edge)) };
}

const browserDeps: FitDeps = {
  decode: (file) => createImageBitmap(file),
  async encode(source, width, height, type, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not read that image.');
    context.drawImage(source as CanvasImageSource, 0, 0, width, height);
    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read that image.'))), type, quality));
  },
};

function renamed(name: string, type: string): string {
  const ext = type === 'image/webp' ? 'webp' : 'jpg';
  return `${name.replace(/\.[^./]+$/, '') || 'image'}.${ext}`;
}

/** True when the file must be shrunk or converted before it can be sent. */
export function needsFlagImageFit(file: File): boolean {
  const accepted = (FLAG_IMAGE_MIME_TYPES as readonly string[]).includes(file.type);
  return !(accepted && file.size > 0 && file.size <= FLAG_IMAGE_PASSTHROUGH_BYTES);
}

/**
 * Any picture a learner attaches is made to fit the upload contract on their
 * device: a 6 MB Retina screenshot or an iPhone HEIC is shrunk and re-encoded
 * rather than refused. Small accepted images pass through untouched.
 */
export async function fitFlagImage(file: File, deps: FitDeps = browserDeps): Promise<File> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image.');
  if (!needsFlagImageFit(file)) return file;

  let source: Source;
  try { source = await deps.decode(file); } catch { throw new Error('Could not read that image. Try a screenshot or a JPEG.'); }
  try {
    let { width, height } = fitDimensions(source.width, source.height);
    let type = 'image/webp';
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const quality of QUALITIES) {
        let blob = await deps.encode(source, width, height, type, quality);
        // Safari before 17 cannot encode WebP and quietly returns PNG.
        if (blob.type !== type) { type = 'image/jpeg'; blob = await deps.encode(source, width, height, type, quality); }
        if (blob.size > 0 && blob.size <= FLAG_IMAGE_PASSTHROUGH_BYTES) return new File([blob], renamed(file.name, type), { type });
      }
      width = Math.max(1, Math.round(width / 2)); height = Math.max(1, Math.round(height / 2));
    }
    throw new Error('Could not shrink that image enough to attach.');
  } finally {
    source.close?.();
  }
}
