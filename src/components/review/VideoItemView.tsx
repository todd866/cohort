'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewItem } from './hooks/types';

interface VideoItemViewProps {
  item: ReviewItem;
}

export function VideoItemView({ item }: VideoItemViewProps) {
  const [delivery, setDelivery] = useState<{
    itemId: string;
    videoUrl: string;
    videoThumbnailUrl: string | null;
    generation: number;
  } | null>(null);
  const [deliveryState, setDeliveryState] = useState<'loading' | 'ready' | 'error'>('loading');
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const retriedPlaybackRef = useRef(false);

  const refreshDelivery = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setDelivery(null);
    setDeliveryState('loading');

    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(item.id)}/delivery`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Video delivery failed (${response.status})`);
      const body = await response.json() as {
        videoUrl?: unknown;
        videoThumbnailUrl?: unknown;
      };
      if (typeof body.videoUrl !== 'string' || body.videoUrl.length === 0) {
        throw new Error('Video delivery response was invalid');
      }
      if (controller.signal.aborted) return;

      generationRef.current += 1;
      setDelivery({
        itemId: item.id,
        videoUrl: body.videoUrl,
        videoThumbnailUrl: typeof body.videoThumbnailUrl === 'string'
          ? body.videoThumbnailUrl
          : null,
        generation: generationRef.current,
      });
      setDeliveryState('ready');
    } catch {
      if (controller.signal.aborted) return;
      setDelivery(null);
      setDeliveryState('error');
    }
  }, [item.id]);

  useEffect(() => {
    retriedPlaybackRef.current = false;
    generationRef.current = 0;
    void refreshDelivery();
    return () => abortRef.current?.abort();
  }, [refreshDelivery]);

  const handlePlaybackError = useCallback(() => {
    if (retriedPlaybackRef.current) {
      setDelivery(null);
      setDeliveryState('error');
      return;
    }
    retriedPlaybackRef.current = true;
    void refreshDelivery();
  }, [refreshDelivery]);

  return (
    <div className="space-y-4">
      <div className="text-xs font-medium uppercase tracking-wider text-[var(--md-primary)] opacity-80">
        Video
      </div>
      {item.videoTitle && (
        <h3 className="text-lg font-semibold text-[var(--md-on-surface)]">
          {item.videoTitle}
        </h3>
      )}
      {item.creatorName && item.creatorName !== 'Unknown' && (
        <p className="text-sm text-[var(--md-on-surface-variant)]">
          {item.creatorName}
          {item.videoDuration ? ` · ${Math.round(item.videoDuration / 60)}m ${item.videoDuration % 60}s` : ''}
        </p>
      )}
      {delivery?.itemId === item.id && deliveryState === 'ready' && (
        <div className="rounded-xl overflow-hidden bg-black aspect-[9/16] max-h-[60vh] mx-auto">
          <video
            key={`${item.id}:${delivery.generation}`}
            src={delivery.videoUrl}
            controls
            playsInline
            preload="metadata"
            poster={delivery.videoThumbnailUrl ?? undefined}
            onError={handlePlaybackError}
            className="w-full h-full object-contain"
          />
        </div>
      )}
      {deliveryState === 'loading' && (
        <p role="status" className="text-sm text-[var(--md-on-surface-variant)] text-center">
          Preparing video…
        </p>
      )}
      {deliveryState === 'error' && (
        <p role="alert" className="text-sm text-[var(--md-on-surface-variant)] text-center">
          Video unavailable
        </p>
      )}
      {item.conceptName && (
        <p className="text-xs text-[var(--md-on-surface-variant)] text-center">
          Related to: {item.conceptName}
        </p>
      )}
    </div>
  );
}
