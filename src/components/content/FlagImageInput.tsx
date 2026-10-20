'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fitFlagImage, needsFlagImageFit } from '@/lib/flags/fit-flag-image';
import { captureOfflineOwner, OFFLINE_OWNER_CHANGE_EVENT, OFFLINE_OWNER_STORAGE_KEY } from '@/lib/offline/owner';

/**
 * Draft state for one feedback image. The bytes stay in memory until submit
 * hands them to `queueFlag`, which persists them (owner-keyed, IndexedDB) with
 * the flag in the outbox; the upload happens in the background, online or later.
 */
export function useFlagImage(targetKey: string) {
  const [draft, setDraft] = useState<{ file: File; preview: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A draft never carries over to a different card (reset during render, not in an effect).
  const [draftKey, setDraftKey] = useState(targetKey);
  if (draftKey !== targetKey) { setDraftKey(targetKey); setDraft(null); setError(null); }
  // A pick that finishes shrinking after the card or account changed is dropped.
  const pick = useRef(0);
  const latestKey = useRef(targetKey);
  useEffect(() => { latestKey.current = targetKey; pick.current++; }, [targetKey]);
  const reset = useCallback(() => { pick.current++; setDraft(null); setError(null); }, []);
  // ...nor to a different account.
  useEffect(() => {
    if (!draft) return;
    const storage = (event: StorageEvent) => { if (event.key === OFFLINE_OWNER_STORAGE_KEY || event.key === null) reset(); };
    window.addEventListener(OFFLINE_OWNER_CHANGE_EVENT, reset);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener(OFFLINE_OWNER_CHANGE_EVENT, reset); window.removeEventListener('storage', storage); };
  }, [draft, reset]);
  useEffect(() => {
    if (!draft) return;
    const url = draft.preview;
    return () => URL.revokeObjectURL(url);
  }, [draft]);
  const choose = useCallback((next: File) => {
    const token = ++pick.current;
    const key = latestKey.current;
    setError(null);
    // An image that can be sent as-is attaches at once, so an immediate submit carries it.
    if (next.type.startsWith('image/') && !needsFlagImageFit(next)) {
      captureOfflineOwner(); setDraft({ file: next, preview: URL.createObjectURL(next) });
      return;
    }
    fitFlagImage(next).then((fitted) => {
      if (token !== pick.current || key !== latestKey.current) return;
      captureOfflineOwner(); setDraft({ file: fitted, preview: URL.createObjectURL(fitted) });
    }, (error: unknown) => {
      if (token !== pick.current) return;
      setError(error instanceof Error ? error.message : 'Could not read that image.');
    });
  }, []);
  return { file: draft?.file ?? null, preview: draft?.preview ?? null, error, setError, choose, remove: reset, committed: reset };
}
export type FlagImageController = ReturnType<typeof useFlagImage>;

export function FlagImageInput({ image, disabled = false }: { image: FlagImageController; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="mt-2" data-flag-image-input>
    <input ref={input} type="file" accept="image/*" className="sr-only" aria-label="Choose feedback image" disabled={disabled}
      onChange={e => { const f = e.target.files?.[0]; if (f) image.choose(f); e.target.value = ''; }} />
    {image.preview ? <div className="flex items-center gap-2">
      {/* Local object URL only; never persists across logout or navigation. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.preview} alt="Attached feedback image" className="h-20 w-24 rounded object-contain" />
      <button type="button" disabled={disabled} onClick={image.remove} className="text-sm underline">Remove image</button>
    </div> : <button type="button" disabled={disabled} onClick={() => input.current?.click()} className="text-sm underline">Add image</button>}
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
