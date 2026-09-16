'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import { GlossaryText } from '@/components/content';
import { DetailsButton } from '@/components/content/DetailsButton';
import { ContentFlag } from '@/components/content/ContentFlag';
import {
  type MCQOption,
  buildMcqAttemptPayload,
  getDisplayLabelForOriginalOption,
  processOptions,
} from '@/components/content/mcq-utils';
import { submitWithRetry } from '@/lib/submit-with-retry';
import { acknowledgeReview, enqueueReview } from '@/lib/review-queue';
import { genClientRequestId } from '@/lib/client-request-id';
import { captureReviewWriteClientContext } from '@/lib/review/review-write-observability';
import {
  captureOfflineOwner,
  isOfflineOwnerCurrent,
} from '@/lib/offline/owner';
import {
  fetchWithDeadline,
  STUDY_SESSION_FETCH_DEADLINE_MS,
} from '@/lib/fetch-with-deadline';

interface Question {
  id: string;
  stem: string;
  options: MCQOption[];
  rotation: string;
  questionType: string;
  difficulty: string;
  imageUrl?: string;
  crosslinks?: {
    primary?: string;
    related?: string[];
    concepts?: string[];
  } | null;
}

interface AnswerResult {
  isCorrect: boolean;
  correctOption: string;
  context: string;
  conceptMastery: Array<{
    conceptId: string;
    conceptName: string;
    mastery: number;
  }>;
}

interface SessionStats {
  total: number;
  answered: number;
  correct: number;
}

interface QuestionPracticeProps {
  rotation: string;
  rotationLabel: string;
  conceptId?: string; // Focus on specific concept
}

export function QuestionPractice({
  rotation,
  rotationLabel,
  conceptId,
}: QuestionPracticeProps) {
  const { data: session } = useSession();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedDisplayOption, setSelectedDisplayOption] = useState<string | null>(null);
  const [answerResult, setAnswerResult] = useState<AnswerResult | null>(null);
  const [stats, setStats] = useState<SessionStats>({
    total: 0,
    answered: 0,
    correct: 0,
  });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionComplete, setSessionComplete] = useState(false);
  const [startTime, setStartTime] = useState<number>(Date.now());
  const [shuffleSessionSeed, setShuffleSessionSeed] = useState(() => String(Date.now()));

  const fetchQuestions = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const nextShuffleSessionSeed = String(Date.now());
      const params = new URLSearchParams({ rotation, limit: '10' });
      if (conceptId) params.set('conceptId', conceptId);
      const url = `/api/questions/respond?${params}`;

      const res = await fetchWithDeadline(url, {}, STUDY_SESSION_FETCH_DEADLINE_MS);
      if (!res.ok) throw new Error('Failed to fetch questions');

      const data = await res.json();
      setShuffleSessionSeed(nextShuffleSessionSeed);
      setQuestions(data.questions || []);
      setStats({
        total: data.questions?.length || 0,
        answered: 0,
        correct: 0,
      });
      setCurrentIndex(0);
      setSelectedDisplayOption(null);
      setAnswerResult(null);
      setSessionComplete(false);
      setStartTime(Date.now());
    } catch (err) {
      setError('Failed to load questions');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [rotation, conceptId]);

  useEffect(() => {
    fetchQuestions();
  }, [fetchQuestions]);

  const handleSelectOption = (label: string) => {
    if (answerResult) return; // Already answered
    setSelectedDisplayOption(label);
  };

  const currentQuestion = questions[currentIndex];

  const { shuffledOptions } = useMemo(() => {
    if (!currentQuestion) {
      return { shuffledOptions: [] as MCQOption[] };
    }

    return processOptions(
      currentQuestion.options,
      `${shuffleSessionSeed}-${currentQuestion.id}-${currentIndex}`
    );
  }, [currentQuestion, shuffleSessionSeed, currentIndex]);

  const handleSubmitAnswer = async () => {
    if (!selectedDisplayOption || answerResult) return;

    const question = currentQuestion;
    if (!question) return;

    const ownerLease = captureOfflineOwner();

    const responseTimeMs = Date.now() - startTime;
    const attemptPayload = buildMcqAttemptPayload(
      shuffledOptions,
      selectedDisplayOption
    );
    const respondBody = {
      questionId: question.id,
      selectedOption: attemptPayload.selectedOption,
      responseTimeMs,
      sessionType: 'practice',
      correctDisplayPosition: attemptPayload.correctDisplayPosition,
      selectedDisplayPosition: attemptPayload.selectedDisplayPosition,
      clientRequestId: genClientRequestId(),
      ...captureReviewWriteClientContext(),
    };
    enqueueReview('/api/questions/respond', respondBody, ownerLease.ownerKey);
    setSubmitting(true);

    // The local write is durable before transport starts. A successful live
    // response acknowledges exactly that row; any failure leaves it for replay.
    try {
      const res = await submitWithRetry(
        '/api/questions/respond',
        respondBody,
        { ownerLease },
      );
      if (!isOfflineOwnerCurrent(ownerLease)) return;

      if (!res.ok) {
        throw new Error(`Failed to submit answer (HTTP ${res.status})`);
      }

      acknowledgeReview(
        '/api/questions/respond',
        respondBody.clientRequestId,
        ownerLease.ownerKey,
      );
      const result: AnswerResult = await res.json();
      if (!isOfflineOwnerCurrent(ownerLease)) return;
      setAnswerResult({
        ...result,
        correctOption: getDisplayLabelForOriginalOption(
          shuffledOptions,
          result.correctOption
        ),
      });

      setStats((prev) => ({
        ...prev,
        answered: prev.answered + 1,
        correct: result.isCorrect ? prev.correct + 1 : prev.correct,
      }));
    } catch (err) {
      if (!isOfflineOwnerCurrent(ownerLease)) return;
      console.error('Error submitting answer:', err);
      // Still show feedback even if save failed — the attempt is queued for replay.
      const correctOpt = shuffledOptions.find((option) => option.isCorrect);
      setAnswerResult({
        isCorrect: correctOpt?.label === selectedDisplayOption,
        correctOption: correctOpt?.label || '',
        context: 'Saved offline — will sync when you reconnect',
        conceptMastery: [],
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleNext = () => {
    if (currentIndex < questions.length - 1) {
      setCurrentIndex((prev) => prev + 1);
      setSelectedDisplayOption(null);
      setAnswerResult(null);
      setStartTime(Date.now());
    } else {
      setSessionComplete(true);
    }
  };
  const progress =
    questions.length > 0 ? ((currentIndex + 1) / questions.length) * 100 : 0;

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-[var(--md-primary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[var(--md-on-surface-variant)]">
            Loading questions...
          </p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-4">:(</div>
          <p className="text-[var(--md-error)] mb-4">{error}</p>
          <button
            onClick={fetchQuestions}
            className="px-6 py-2 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] font-medium"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  // No questions state
  if (questions.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-4">?</div>
          <h2 className="text-2xl font-bold text-[var(--md-on-surface)] mb-2">
            No Questions Yet
          </h2>
          <p className="text-[var(--md-on-surface-variant)] mb-6">
            No practice questions available for {rotationLabel} yet. Check back
            soon!
          </p>
          <a
            href={`/${rotation}`}
            className="inline-block px-6 py-2 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] font-medium"
          >
            Go to {rotationLabel} Content
          </a>
        </div>
      </div>
    );
  }

  // Session complete state
  if (sessionComplete) {
    const accuracy =
      stats.answered > 0
        ? Math.round((stats.correct / stats.answered) * 100)
        : 0;

    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-4">
            {accuracy >= 80 ? ':D' : accuracy >= 60 ? ':)' : ':|'}
          </div>
          <h2 className="text-2xl font-bold text-[var(--md-on-surface)] mb-2">
            Practice Complete!
          </h2>
          <div className="grid grid-cols-3 gap-4 my-6">
            <div className="p-4 rounded-xl bg-[var(--md-surface-container)]">
              <div className="text-3xl font-bold text-[var(--md-primary)]">
                {stats.answered}
              </div>
              <div className="text-sm text-[var(--md-on-surface-variant)]">
                Answered
              </div>
            </div>
            <div className="p-4 rounded-xl bg-[var(--md-surface-container)]">
              <div className="text-3xl font-bold text-green-600 dark:text-green-400">
                {stats.correct}
              </div>
              <div className="text-sm text-[var(--md-on-surface-variant)]">
                Correct
              </div>
            </div>
            <div className="p-4 rounded-xl bg-[var(--md-surface-container)]">
              <div className="text-3xl font-bold text-[var(--md-tertiary)]">
                {accuracy}%
              </div>
              <div className="text-sm text-[var(--md-on-surface-variant)]">
                Accuracy
              </div>
            </div>
          </div>
          <div className="flex gap-4 justify-center">
            <button
              onClick={fetchQuestions}
              className="px-6 py-2 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] font-medium"
            >
              Practice More
            </button>
            <a
              href={`/${rotation}`}
              className="px-6 py-2 rounded-xl border border-[var(--md-outline)] text-[var(--md-on-surface)] font-medium"
            >
              Back to Content
            </a>
          </div>
        </div>
      </div>
    );
  }

  // Active question state
  return (
    <div>
      {/* Progress bar */}
      <div className="mb-6">
        <div className="flex justify-between text-sm text-[var(--md-on-surface-variant)] mb-2">
          <span>
            Question {currentIndex + 1} of {questions.length}
          </span>
          <span>{stats.correct} correct</span>
        </div>
        <div className="h-2 bg-[var(--md-surface-container)] rounded-full overflow-hidden">
          <div
            className="h-full bg-[var(--md-primary)] transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Question */}
      {currentQuestion && (
        <div className="bg-[var(--md-surface-container)] rounded-2xl p-6">
          {/* Question type badge */}
          <div className="flex gap-2 mb-4">
            <span className="px-3 py-1 text-xs rounded-full bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]">
              {currentQuestion.questionType}
            </span>
            <span className="px-3 py-1 text-xs rounded-full bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]">
              {currentQuestion.difficulty}
            </span>
          </div>

          {/* Stem */}
          <div className="text-[var(--md-on-surface)] text-lg mb-6 whitespace-pre-wrap">
            <GlossaryText text={currentQuestion.stem} />
          </div>

          {/* Options */}
          <div className="space-y-3">
            {shuffledOptions.map((option) => {
              const isSelected = selectedDisplayOption === option.label;
              const isCorrect =
                answerResult && option.label === answerResult.correctOption;
              const isWrong =
                answerResult && isSelected && !answerResult.isCorrect;

              let optionClass =
                'border-[var(--md-outline-variant)] bg-[var(--md-surface)]';

              if (answerResult) {
                if (isCorrect) {
                  optionClass =
                    'border-green-500 bg-green-50 dark:bg-green-900/20';
                } else if (isWrong) {
                  optionClass = 'border-red-500 bg-red-50 dark:bg-red-900/20';
                }
              } else if (isSelected) {
                optionClass =
                  'border-[var(--md-primary)] bg-[var(--md-primary-container)]';
              }

              return (
                <button
                  key={option.label}
                  onClick={() => handleSelectOption(option.label)}
                  disabled={!!answerResult}
                  className={`w-full text-left p-4 rounded-xl border-2 transition-all ${optionClass} ${
                    !answerResult
                      ? 'hover:border-[var(--md-primary)] cursor-pointer'
                      : ''
                  }`}
                >
                  <span className="font-bold mr-3">{option.label}.</span>
                  <span><GlossaryText text={option.text} /></span>
                  {isCorrect && <span className="ml-2">✓</span>}
                  {isWrong && <span className="ml-2">✗</span>}
                </button>
              );
            })}
          </div>

          {/* Answer result */}
          {answerResult && (
            <div
              className={`mt-6 p-4 rounded-xl ${
                answerResult.isCorrect
                  ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
                  : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
              }`}
            >
              <div
                className={`font-bold mb-2 ${
                  answerResult.isCorrect
                    ? 'text-green-700 dark:text-green-300'
                    : 'text-red-700 dark:text-red-300'
                }`}
              >
                {answerResult.isCorrect ? 'Correct!' : 'Incorrect'}
              </div>
              {!answerResult.isCorrect && answerResult.context && (
                <div className="text-sm text-[var(--md-on-surface-variant)] whitespace-pre-wrap">
                  <GlossaryText text={answerResult.context} />
                </div>
              )}
              {!answerResult.isCorrect && currentQuestion.crosslinks?.primary && (
                <a
                  href={currentQuestion.crosslinks.primary}
                  className="inline-flex items-center text-sm text-[var(--md-primary)] hover:underline mt-2"
                >
                  Learn more →
                </a>
              )}
              {/* Details and Flag buttons */}
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[var(--md-outline-variant)]/30">
                <DetailsButton type="question" id={currentQuestion.id} />
                <ContentFlag targetType="question" targetId={currentQuestion.id} />
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="mt-6 flex gap-4">
            {!answerResult ? (
              <button
                onClick={handleSubmitAnswer}
                disabled={!selectedDisplayOption || submitting}
                className="flex-1 px-6 py-3 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Checking...' : 'Check Answer'}
              </button>
            ) : (
              <button
                onClick={handleNext}
                className="flex-1 px-6 py-3 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] font-medium"
              >
                {currentIndex < questions.length - 1
                  ? 'Next Question'
                  : 'Finish'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Guest warning */}
      {!session?.user && (
        <div className="mt-6 p-4 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] text-center">
          <p className="text-sm text-[var(--md-on-surface-variant)]">
            Sign in to save your progress and track concept mastery.
          </p>
        </div>
      )}
    </div>
  );
}
