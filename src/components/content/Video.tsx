'use client';

import { useEffect, useRef } from 'react';
import { useVideoTracking } from '@/hooks/useTracking';

interface VideoProps {
  src: string;
  title: string;
  duration?: string;
  id?: string;
}

// Extract YouTube video ID from various URL formats
function getYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s?]+)/,
    /^([a-zA-Z0-9_-]{11})$/, // Just the ID
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function Video({ src, title, duration, id }: VideoProps) {
  const videoId = getYouTubeId(src);
  const { onPlay } = useVideoTracking(id || title);
  const hasTracked = useRef(false);

  // Track video view when iframe becomes visible
  useEffect(() => {
    if (videoId && !hasTracked.current) {
      hasTracked.current = true;
      onPlay(); // Track as "play" since we can't detect actual play from iframe
    }
  }, [videoId, onPlay]);

  if (!videoId) {
    // Fallback for non-YouTube or invalid URLs
    return (
      <div className="my-4 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-4">
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 text-[var(--md-primary)] hover:underline"
        >
          <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
          <div>
            <div className="font-medium">{title}</div>
            {duration && <div className="text-sm text-[var(--md-on-surface-variant)]">{duration}</div>}
          </div>
        </a>
      </div>
    );
  }

  return (
    <div className="my-4">
      {/* Title bar */}
      <div className="flex items-center gap-2 mb-2">
        <svg className="w-5 h-5 text-[var(--md-error)]" fill="currentColor" viewBox="0 0 24 24">
          <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
        </svg>
        <span className="font-medium text-[var(--md-on-surface)]">{title}</span>
        {duration && (
          <span className="text-sm text-[var(--md-on-surface-variant)]">({duration})</span>
        )}
      </div>

      {/* Responsive 16:9 video container */}
      <div className="relative w-full rounded-lg overflow-hidden" style={{ paddingBottom: '56.25%' }}>
        <iframe
          className="absolute inset-0 w-full h-full"
          src={`https://www.youtube-nocookie.com/embed/${videoId}`}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          loading="lazy"
        />
      </div>
    </div>
  );
}
