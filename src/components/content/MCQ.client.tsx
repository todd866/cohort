'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useMCQInteraction, type MCQSubmitData } from '@/hooks/useMCQInteraction';
import { submitWithRetry } from '@/lib/submit-with-retry';
import { acknowledgeReview, enqueueReview } from '@/lib/review-queue';
import { genClientRequestId } from '@/lib/client-request-id';
import { captureReviewWriteClientContext } from '@/lib/review/review-write-observability';
import {
  captureOfflineOwner,
  isOfflineOwnerCurrent,
} from '@/lib/offline/owner';
import { useImageTracking } from '@/hooks/useTracking';
import { ConfidenceButtons } from '@/components/shared/ConfidenceButtons';
import { InlineMarkdown } from '@/lib/inline-markdown';
import { GlossaryText } from './GlossaryText';
import { ContentFlag } from './ContentFlag';
import { Citation } from './Citation';
import {
  type MCQOption,
  type MCQProps,
  type QuestionVariant,
  shuffleWithSeed,
  difficultyColors,
  getOptionStyle,
  getOptionLabelStyle,
  splitExplanation,
  parsePathname,
  getExcludeIds,
  markReturned,
  getActiveWeeklyKeyboardBlock,
  normalizeStaticMCQInput,
} from './mcq-utils';
import { CheckIcon, XIcon, CheckCircleIcon, XCircleIcon, ChevronIcon } from './mcq-icons';
import { buildFlagId, normalizeSnapshot } from './content-flag-utils';
import { useJurisdictionFilter, JURISDICTION_LABELS } from '@/contexts/JurisdictionContext';
import { type ClientImageMeta, imageAltForMeta } from '@/lib/figures/types';
import {
  CLIENT_FETCH_DEADLINE_MS,
  fetchWithDeadline,
} from '@/lib/fetch-with-deadline';

interface MCQClientExtraProps {
  /** Pre-resolved R2 key (forwarded from server wrapper or feed). */
  imageKey?: string | null;
  /** Pre-projected sidecar metadata (forwarded from server wrapper or feed). */
  imageMeta?: ClientImageMeta;
}

export function MCQClient({
  id,
  type = 'SBA',
  difficulty: staticDifficulty = 'medium',
  topics = [],
  jurisdiction,
  cite,
  image,
  imageUrl,
  imageKey,
  imageMeta,
  ...inputProps
}: MCQProps & MCQClientExtraProps) {
  const {
    stem: staticStem,
    options: staticOptions,
    correctAnswer: staticCorrectAnswer,
    context: staticExplanation,
  } = normalizeStaticMCQInput(inputProps);
  const shouldShow = useJurisdictionFilter(jurisdiction);
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const [variant, setVariant] = useState<QuestionVariant | null>(null);
  const [variantExhausted, setVariantExhausted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expandedOptions, setExpandedOptions] = useState<Set<string>>(new Set());
  // Start with a stable seed so the server-rendered option order matches the
  // client's first render. A `Date.now()` initialiser differs server↔client,
  // which reorders the static-path options and triggers a React #418 hydration
  // mismatch. We reshuffle once after mount (client-only) to keep per-load
  // randomisation for the guest/static path.
  const [shuffleEpoch, setShuffleEpoch] = useState(0);
  useEffect(() => {
    setShuffleEpoch(Date.now());
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);

  // Determine which question to show
  const isLoggedIn = status === 'authenticated' && session?.user;
  const useVariant = isLoggedIn && variant;

  // Current question data (variant or static)
  const stem = useVariant ? variant.stem : staticStem;
  const explanation = useVariant ? (variant.context || staticExplanation) : staticExplanation;
  const difficulty = useVariant ? variant.difficulty : staticDifficulty;
  const resolvedImage = image || imageUrl;

  // Process options with proper shuffling
  const { shuffledOptions, correctLabel } = useMemo(() => {
    if (useVariant && variant) {
      // Variant from DB - options have isCorrect flag
      const opts = variant.options as MCQOption[];
      const shuffled = shuffleWithSeed(opts, variant.shuffleSeed);
      const correctOpt = shuffled.find(o => o.isCorrect);
      return {
        shuffledOptions: shuffled.map((opt, idx) => ({
          ...opt,
          originalLabel: opt.label,
          label: String.fromCharCode(65 + idx),
        })),
        correctLabel: correctOpt
          ? String.fromCharCode(65 + shuffled.indexOf(correctOpt))
          : 'A',
      };
    } else {
      // Static from MDX — epoch changes per mount so options reshuffle each visit
      const seed = isLoggedIn && session?.user?.id
        ? `${session.user.id}-${staticStem}-${shuffleEpoch}`
        : `${staticStem}-${shuffleEpoch}`;
      const correctOpt = staticCorrectAnswer
        ? staticOptions.find((o) => o.label === staticCorrectAnswer)
        : staticOptions.find((o) => o.isCorrect);
      const shuffled = shuffleWithSeed(staticOptions, seed);
      const newCorrectIndex = correctOpt
        ? shuffled.indexOf(correctOpt)
        : 0;
      return {
        shuffledOptions: shuffled.map((opt, idx) => ({
          ...opt,
          originalLabel: opt.label,
          label: String.fromCharCode(65 + idx),
        })),
        correctLabel: String.fromCharCode(65 + newCorrectIndex),
      };
    }
  }, [useVariant, variant, staticOptions, staticCorrectAnswer, staticStem, isLoggedIn, session?.user?.id, shuffleEpoch]);

  const questionId = useVariant ? variant.id : (id || staticStem.slice(0, 50));

  const staticSignature = useMemo(() => {
    const optionText = staticOptions
      .map((opt) => `${opt.label}:${opt.text}`)
      .join(' ');
    return normalizeSnapshot(`${staticStem} ${optionText}`);
  }, [staticStem, staticOptions]);

  const fallbackComponentId = useMemo(
    () => (id ? id : buildFlagId('MCQ', staticSignature)),
    [id, staticSignature]
  );

  const flagTargetType = useVariant && variant ? 'question' : 'component';
  const flagTargetId = useVariant && variant ? variant.id : fallbackComponentId;
  const flagSnapshot = normalizeSnapshot(stem);

  // Fetch variant for logged-in users
  useEffect(() => {
    if (status === 'loading') return;

    if (!isLoggedIn) {
      setLoading(false);
      return;
    }

    const { rotation, week } = parsePathname(pathname);
    if (!rotation) {
      setLoading(false);
      return;
    }

    const fetchVariant = async () => {
      try {
        const exclude = getExcludeIds(pathname);
        const params = new URLSearchParams({
          rotation,
          anchor: staticStem,
          ...(week ? { week: String(week) } : {}),
          ...(topics.length > 0 ? { topics: topics.join(',') } : {}),
          ...(exclude.length > 0 ? { exclude: exclude.join(',') } : {}),
        });

        const res = await fetchWithDeadline(
          `/api/questions/variant?${params}`,
          {},
          CLIENT_FETCH_DEADLINE_MS,
        );
        const data = await res.json();

        if (data.question) {
          markReturned(pathname, data.question.id);
          setVariant(data.question);
          setVariantExhausted(false);
        } else if (data.reason === 'all_answered') {
          setVariant(null);
          setVariantExhausted(true);
        } else {
          setVariantExhausted(false);
        }
      } catch (error) {
        console.error('Failed to fetch question variant:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchVariant();
  }, [isLoggedIn, status, pathname, staticStem, topics]);

  const handleSubmit = useCallback(
    (data: MCQSubmitData) => {
      const ownerLease = captureOfflineOwner();
      // Retry transient cold-start/network failures and fall back to the
      // offline outbox so a content/practice MCQ answer isn't silently lost.
      // Mirrors the study-feed path (useMcqReview).
      const record = (url: string, body: Record<string, unknown>) => {
        const clientRequestId = String(body.clientRequestId);
        enqueueReview(url, body, ownerLease.ownerKey);
        submitWithRetry(url, body, { ownerLease })
          .then((res) => {
            if (!isOfflineOwnerCurrent(ownerLease)) return;
            if (res.ok) {
              acknowledgeReview(url, clientRequestId, ownerLease.ownerKey);
            }
          })
          .catch(() => {
            // The write-ahead row remains available for replay.
          });
      };
      // Record to appropriate endpoint based on whether using variant
      if (useVariant && variant) {
        record('/api/questions/respond', {
          questionId: variant.id,
          selectedOption: data.attemptPayload.selectedOption,
          responseTimeMs: data.responseTimeMs,
          sessionType: 'practice',
          correctDisplayPosition: data.attemptPayload.correctDisplayPosition,
          selectedDisplayPosition: data.attemptPayload.selectedDisplayPosition,
          clientRequestId: genClientRequestId(),
          ...captureReviewWriteClientContext(),
        });
      } else {
        record('/api/cards/review-mcq', {
          stem,
          correct: data.correct,
          responseTimeMs: data.responseTimeMs,
          clientRequestId: genClientRequestId(),
          ...captureReviewWriteClientContext(),
        });
      }
    },
    [useVariant, variant, stem]
  );

  const handleResetExtra = useCallback(() => {
    setExpandedOptions(new Set());
  }, []);

  const {
    selectedAnswer,
    showResult,
    hasAnswered,
    isCorrect,
    handleOptionClick,
    handleReset,
    gradeConfidence,
    confidenceSelected,
    confidenceStatus,
  } = useMCQInteraction({
    questionId,
    correctLabel,
    shuffledOptions,
    onSubmit: handleSubmit,
    onReset: handleResetExtra,
  });

  const toggleOptionExplanation = useCallback((label: string) => {
    setExpandedOptions(prev => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }, []);

  // Image impression / reveal tracking. Identity is the canonical imageKey
  // from the server resolver (or a stable /figures/ src) — never a signed
  // R2 URL. Mirrors the QuestionBankMCQ + CardImage wiring.
  const resolvedImageShowWhen = imageMeta?.showWhen === 'after-reveal' ? 'after-reveal' : 'always';
  const isMcqImageVisible = !!resolvedImage && (resolvedImageShowWhen === 'always' || hasAnswered);
  const trackedMcqImageKey =
    imageKey ?? (typeof resolvedImage === 'string' && resolvedImage.startsWith('/figures/') ? resolvedImage : null);
  const { recordReveal: recordMcqImageReveal } = useImageTracking({
    imageKey: isMcqImageVisible ? trackedMcqImageKey : null,
    componentId: id ?? questionId,
    modality: imageMeta?.modality ?? null,
    condition: imageMeta?.condition ?? null,
  });
  const mcqRevealFiredRef = useRef(false);
  useEffect(() => {
    if (hasAnswered && trackedMcqImageKey && !mcqRevealFiredRef.current) {
      mcqRevealFiredRef.current = true;
      recordMcqImageReveal();
    }
  }, [hasAnswered, trackedMcqImageKey, recordMcqImageReveal]);

  // Keyboard shortcuts:
  // Before answering: 1-5 to select answer (maps to A-E)
  // After answering: 1-4 to rate confidence
  // Only responds when this MCQ is visible in the viewport to prevent
  // all MCQs on the page from answering simultaneously.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const activeWeeklyBlock = getActiveWeeklyKeyboardBlock();
      if (activeWeeklyBlock) {
        if (activeWeeklyBlock !== containerRef.current) return;
      } else {
        // Outside weekly feed-style navigation, fall back to the old visibility check.
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;
      }

      const keyNum = parseInt(e.key);

      if (!hasAnswered) {
        // Before answering: 1-5 selects option
        if (keyNum >= 1 && keyNum <= 5) {
          const labels = ['A', 'B', 'C', 'D', 'E'];
          const label = labels[keyNum - 1];
          if (shuffledOptions.some(o => o.label.toUpperCase() === label)) {
            e.preventDefault();
            handleOptionClick(label);
          }
        }
      } else {
        // After answering: 1-4 rates confidence
        if (keyNum >= 1 && keyNum <= 4) {
          e.preventDefault();
          gradeConfidence(keyNum);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasAnswered, shuffledOptions, handleOptionClick, gradeConfidence]);

  // Jurisdiction filtering - hide if user's jurisdiction doesn't match
  if (!shouldShow) return null;

  // Show skeleton while loading for logged-in users
  if (loading && isLoggedIn) {
    return (
      <article className="mcq animate-pulse">
        <header><div className="h-6 w-24 rounded-full" style={{ background: 'var(--md-surface-container-high)' }} /></header>
        <section className="stem">
          <div className="h-4 w-full rounded mb-2" style={{ background: 'var(--md-surface-container-high)' }} />
          <div className="h-4 w-3/4 rounded" style={{ background: 'var(--md-surface-container-high)' }} />
        </section>
        <ol className="options">
          {[1, 2, 3, 4].map(i => (
            <li key={i}><div className="h-14 rounded-xl" style={{ background: 'var(--md-surface-container-high)' }} /></li>
          ))}
        </ol>
      </article>
    );
  }

  if (isLoggedIn && variantExhausted && !variant) {
    return (
      <article className="mcq" style={{ padding: '1.25rem 1.5rem' }}>
        <p className="text-sm" style={{ color: 'var(--md-on-surface-variant)' }}>
          You&apos;ve completed all available variants for this question. Try{' '}
          <a href="/study" style={{ color: 'var(--md-primary)' }}>Study</a>{' '}
          for fresh mixed practice.
        </p>
      </article>
    );
  }

  return (
    <article ref={containerRef} data-mcq data-content-block className="mcq">
      <header>
        <span className="tags">
          <span className="badge badge-primary">{type}</span>
          <span className={`badge ${difficultyColors[difficulty as keyof typeof difficultyColors] || difficultyColors.medium}`}>
            {difficulty}
          </span>
          {useVariant && <span className="badge badge-variant">✨ variant</span>}
          {topics.map((topic) => (
            <span key={topic} className="badge badge-topic">{topic}</span>
          ))}
          {jurisdiction && jurisdiction !== 'national' && (
            <span className="badge badge-jurisdiction">
              {JURISDICTION_LABELS[jurisdiction] || jurisdiction.toUpperCase()}
            </span>
          )}
        </span>
        <span className="actions">
          {cite && <Citation slug={cite.split('#')[0].split(':')[0]} note={cite.includes('#') ? cite.split('#')[1] : undefined} />}
          <ContentFlag targetType={flagTargetType} targetId={flagTargetId} componentType="MCQ" contentSnapshot={flagSnapshot} />
        </span>
      </header>

      <section className="stem">
        <InlineMarkdown text={stem} />
        {resolvedImage && (() => {
          const showWhen = imageMeta?.showWhen === 'after-reveal' ? 'after-reveal' : 'always';
          const accessTier = imageMeta?.accessTier === 'auth-required' ? 'auth-required' : 'public';
          if (showWhen === 'after-reveal' && !hasAnswered) return null;
          return (
            <figure className="my-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={resolvedImage}
                alt={imageMeta ? imageAltForMeta(imageMeta, hasAnswered) : 'Question figure'}
                loading="lazy"
              />
              {imageMeta && (
                <figcaption className="mt-1 text-xs text-[var(--md-on-surface-variant)]">
                  {accessTier === 'auth-required' && (
                    <span data-testid="restricted-media-chip" className="badge badge-jurisdiction mr-2">
                      Signed-in
                    </span>
                  )}
                  {imageMeta.attributionText}
                  {hasAnswered && imageMeta.class === 'diagnostic' && imageMeta.keyFindings && (
                    <span className="ml-2 italic">— {imageMeta.keyFindings.join('; ')}</span>
                  )}
                </figcaption>
              )}
            </figure>
          );
        })()}
      </section>

      <ol className="options">
        {shuffledOptions.map((option, idx) => {
          const hasExplanation = hasAnswered && !!option.explanation;
          const isExpanded = expandedOptions.has(option.label);

          return (
            <li key={option.label}>
              <button
                onClick={() => {
                  if (!hasAnswered) {
                    handleOptionClick(option.label);
                  } else if (hasExplanation) {
                    toggleOptionExplanation(option.label);
                  }
                }}
                disabled={hasAnswered && !hasExplanation}
                aria-expanded={hasExplanation ? isExpanded : undefined}
                className={getOptionStyle(option.label, selectedAnswer, correctLabel, hasAnswered, hasExplanation)}
              >
                <span className={getOptionLabelStyle(option.label, selectedAnswer, correctLabel, hasAnswered)}>
                  {!hasAnswered ? idx + 1 : option.label}
                </span>
                <span className="flex-1" style={{ color: 'var(--md-on-surface)', paddingTop: '0.25rem' }}>
                  <GlossaryText text={option.text} />
                </span>
                {hasAnswered && option.label === correctLabel && (
                  <span className="ml-auto text-[var(--md-success)] flex-shrink-0"><CheckIcon /></span>
                )}
                {hasAnswered && selectedAnswer === option.label && option.label !== correctLabel && (
                  <span className="ml-auto text-[var(--md-error)] flex-shrink-0"><XIcon /></span>
                )}
                {hasExplanation && (
                  <span aria-hidden="true" className={`ml-auto flex-shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} style={{ color: 'var(--md-on-surface-variant)' }}>
                    <ChevronIcon />
                  </span>
                )}
              </button>
              {hasExplanation && isExpanded && (
                <div className="option-detail">
                  {splitExplanation(option.explanation ?? '').map((block, i) => (
                    <p key={i}><InlineMarkdown text={block} /></p>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {!hasAnswered ? (
        <p className="hint">
          {isLoggedIn ? (
            `Press 1-${shuffledOptions.length} to answer`
          ) : (
            <>
              Press 1-{shuffledOptions.length} to answer •{' '}
              <Link href="/auth/signin" style={{ color: 'var(--md-primary)' }}>Sign in</Link>{' '}
              for personalized questions &amp; progress tracking
            </>
          )}
        </p>
      ) : (
        <p className="hint">1-4 confidence · Space to continue</p>
      )}

      {showResult && (
        <footer className={`result ${isCorrect ? 'correct' : 'incorrect'}`}>
          <p className="verdict">
            {isCorrect ? (
              <>
                <span className="text-[var(--md-success)]"><CheckCircleIcon /></span>
                <span className="text-[var(--md-success)]">Correct!</span>
              </>
            ) : (
              <>
                <span className="text-[var(--md-error)]"><XCircleIcon /></span>
                <span className="text-[var(--md-error)]">Incorrect — The answer is {correctLabel}</span>
              </>
            )}
          </p>
          <div style={{ color: 'var(--md-on-surface)', lineHeight: 1.6 }}>
            {splitExplanation(explanation).map((block, i) => (
              <p key={i} style={{ marginBottom: '0.5rem' }}><InlineMarkdown text={block} /></p>
            ))}
          </div>
          <div className="mt-4">
            <ConfidenceButtons mode="inline" onSelect={gradeConfidence} selected={confidenceSelected} status={confidenceStatus} />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button onClick={handleReset} className="btn btn-outlined btn-sm">Try Again</button>
            {!isLoggedIn && (
              <Link href="/auth/signin" className="btn btn-filled btn-sm">
                Sign in for more practice variations
              </Link>
            )}
          </div>
        </footer>
      )}
    </article>
  );
}
