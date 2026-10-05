'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FLAG_IMAGE_MAX_BYTES, FLAG_IMAGE_MIME_TYPES, type FlagImageTarget } from '@/lib/flags/image-contract';
import { captureOfflineOwner, isOfflineOwnerCurrent, OFFLINE_OWNER_CHANGE_EVENT, OFFLINE_OWNER_STORAGE_KEY } from '@/lib/offline/owner';
import { fetchWithDeadline } from '@/lib/fetch-with-deadline';

export function useFlagImage(targetKey: string) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const prepared = useRef<string | null>(null);
  const fileRef = useRef<File | null>(null);
  const inFlight = useRef(false);
  const uploadId = useRef<string | null>(null);
  const reset = useCallback(() => {
    revision.current++;
    const id = prepared.current;
    prepared.current = null;
    uploadId.current = null;
    fileRef.current = null;
    setFile(null); setError(null); setBusy(false);
    if (id) void fetch(`/api/content/flag/images/${id}`, { method: 'DELETE' }).catch(() => {});
  }, []);
  // A late completion cannot attach to a different card or account.
  useEffect(() => {
    reset();
    const generation = revision;
    return () => { generation.current++; };
  }, [targetKey, reset]);
  useEffect(() => {
    if (!file) return;
    const storage = (event: StorageEvent) => { if (event.key === OFFLINE_OWNER_STORAGE_KEY || event.key === null) reset(); };
    window.addEventListener(OFFLINE_OWNER_CHANGE_EVENT, reset);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener(OFFLINE_OWNER_CHANGE_EVENT, reset); window.removeEventListener('storage', storage); };
  }, [file, reset]);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const choose = useCallback((next: File) => {
    if (inFlight.current) return;
    if (!(FLAG_IMAGE_MIME_TYPES as readonly string[]).includes(next.type)) { setError('Choose a PNG, JPEG or WebP image.'); return; }
    if (!next.size || next.size > FLAG_IMAGE_MAX_BYTES) { setError('Choose an image under 2 MB.'); return; }
    captureOfflineOwner(); reset(); fileRef.current = next; setFile(next);
  }, [reset]);
  const prepare = useCallback(async (target: FlagImageTarget) => {
    if (!fileRef.current) return undefined;
    if (prepared.current) return prepared.current;
    if (inFlight.current) throw new Error('Image is already uploading');
    const epoch = revision.current, owner = captureOfflineOwner(), currentFile = fileRef.current;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('Image could not be read'));
        reader.readAsDataURL(currentFile);
      });
      if (epoch !== revision.current || !isOfflineOwnerCurrent(owner)) throw new Error('Feedback changed; try again');
      const response = await fetchWithDeadline('/api/content/flag', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-flag-image-upload': '1' },
        body: JSON.stringify({ ...target, reason: 'Other', imageUpload: { uploadId: uploadId.current ?? (uploadId.current = crypto.randomUUID()), base64 } }),
      }, 30_000);
      const data = await response.json();
      if (response.status === 422 && epoch === revision.current) uploadId.current = null;
      if (!response.ok || typeof data.attachmentId !== 'string') throw new Error(data.error || 'Image upload failed. Try again.');
      if (epoch !== revision.current || !isOfflineOwnerCurrent(owner)) {
        void fetch(`/api/content/flag/images/${data.attachmentId}`, { method: 'DELETE' }).catch(() => {});
        throw new Error('Feedback changed; try again');
      }
      prepared.current = data.attachmentId;
      return data.attachmentId as string;
    } catch (e) {
      if (epoch === revision.current) setError(e instanceof Error ? e.message : 'Image upload failed. Try again.');
      throw e;
    } finally { inFlight.current = false; if (epoch === revision.current) setBusy(false); }
  }, []);
  const retryImage = useCallback(() => { prepared.current = null; uploadId.current = null; setError('Your note was sent, but the image was not attached. Try sending the image again.'); }, []);
  // Once the durable flag outbox owns the ID, removing UI state must not delete it.
  const committed = useCallback(() => { prepared.current = null; reset(); }, [reset]);
  return { file, preview, busy, error, setError, choose, remove: reset, prepare, committed, retryImage, capture: () => revision.current, isCurrent: (value: number) => value === revision.current };
}
export type FlagImageController = ReturnType<typeof useFlagImage>;

export function FlagImageInput({ image, disabled = false }: { image: FlagImageController; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="mt-2" data-flag-image-input>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Choose feedback image" disabled={disabled || image.busy}
      onChange={e => { const f = e.target.files?.[0]; if (f) image.choose(f); e.target.value = ''; }} />
    {image.preview ? <div className="flex items-center gap-2">
      {/* Local object URL only; never persists across logout or navigation. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.preview} alt="Attached feedback image" className="h-20 w-24 rounded object-contain" />
      <button type="button" disabled={disabled || image.busy} onClick={image.remove} className="text-sm underline">Remove image</button>
    </div> : <button type="button" disabled={disabled || image.busy} onClick={() => input.current?.click()} className="text-sm underline">Add image</button>}
    {image.error && <p role="alert" className="mt-1 text-sm text-[var(--md-error)]">{image.error}</p>}
  </div>;
}
export function flagImageEvents(image: FlagImageController) {
  return {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer.files.length !== 1) { image.setError('Attach one image at a time.'); return; }
      image.choose(e.dataTransfer.files[0]);
    },
    onPaste: (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.items).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter((f): f is File => !!f);
      if (!files.length) return;
      e.preventDefault(); e.stopPropagation();
      if (files.length !== 1) { image.setError('Attach one image at a time.'); return; }
      image.choose(files[0]);
    },
  };
}
