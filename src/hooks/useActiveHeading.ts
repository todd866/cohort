'use client';

import { useEffect, useState, useRef, RefObject } from 'react';

interface HeadingInfo {
  id: string;
  text: string;
}

interface UseActiveHeadingResult {
  activeId: string | null;
  headings: HeadingInfo[];
}

export function useActiveHeading(
  containerRef: RefObject<HTMLElement | null>
): UseActiveHeadingResult {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [headings, setHeadings] = useState<HeadingInfo[]>([]);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const h2s = Array.from(container.querySelectorAll('h2'));
    const headingList = h2s
      .filter((h2) => h2.id)
      .map((h2) => ({ id: h2.id, text: h2.textContent || '' }));

    setHeadings(headingList);

    if (headingList.length > 0) {
      setActiveId((current) => current ?? headingList[0].id);
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const intersecting = entries.find((e) => e.isIntersecting);
        if (intersecting && intersecting.target.id) {
          setActiveId(intersecting.target.id);
        }
      },
      { rootMargin: '-80px 0px -70% 0px' }
    );

    h2s.forEach((h2) => {
      if (h2.id) observerRef.current?.observe(h2);
    });

    return () => { observerRef.current?.disconnect(); };
  }, [containerRef]);

  return { activeId, headings };
}
