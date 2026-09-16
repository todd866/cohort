'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '../ui/Button';

interface PracticeQuestionProps {
  id?: string;
  question: ReactNode;
  answer: ReactNode;
  difficulty?: 'easy' | 'medium' | 'hard';
  topics?: string[];
}

export function PracticeQuestion({
  question,
  answer,
  difficulty = 'medium',
  topics = []
}: PracticeQuestionProps) {
  const [showAnswer, setShowAnswer] = useState(false);
  const [result, setResult] = useState<'correct' | 'incorrect' | null>(null);

  const difficultyColors = {
    easy: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    hard: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  };

  const handleResult = (isCorrect: boolean) => {
    setResult(isCorrect ? 'correct' : 'incorrect');
    // Progress tracking is not wired up here because PracticeQuestion is a
    // standalone MDX component without a stable card ID. The review API
    // (/api/cards/review) requires a card ID from the database. To track
    // these results, PracticeQuestion would need to be linked to seeded
    // cards or use a separate lightweight endpoint for ad-hoc self-assessment.
  };

  return (
    <div className="my-6 rounded-xl bg-[var(--question-bg)] p-6 shadow-[var(--md-shadow-1)]">
      {/* Header with difficulty and topics */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${difficultyColors[difficulty]}`}>
          {difficulty}
        </span>
        {topics.map((topic) => (
          <span
            key={topic}
            className="px-2 py-0.5 text-xs font-medium rounded-full bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]"
          >
            {topic}
          </span>
        ))}
      </div>

      {/* Question */}
      <div className="text-[var(--md-on-surface)] font-medium mb-4">
        {question}
      </div>

      {/* Show Answer Button */}
      {!showAnswer && (
        <Button
          variant="tonal"
          size="sm"
          onClick={() => setShowAnswer(true)}
        >
          Show Answer
        </Button>
      )}

      {/* Answer section */}
      {showAnswer && (
        <div className="mt-4">
          <div className="p-4 rounded-lg bg-[var(--answer-bg)] text-[var(--md-on-surface)]">
            {answer}
          </div>

          {/* Self-assessment buttons */}
          {result === null && (
            <div className="mt-4 flex gap-2">
              <Button
                variant="outlined"
                size="sm"
                onClick={() => handleResult(false)}
                className="border-[var(--md-error)] text-[var(--md-error)]"
              >
                Got it wrong
              </Button>
              <Button
                variant="filled"
                size="sm"
                onClick={() => handleResult(true)}
                className="bg-[var(--md-success)]"
              >
                Got it right
              </Button>
            </div>
          )}

          {/* Result feedback */}
          {result && (
            <div className={`mt-4 p-3 rounded-lg text-sm font-medium ${
              result === 'correct'
                ? 'bg-[var(--md-success-container)] text-[var(--md-on-success-container)]'
                : 'bg-[var(--md-error-container)] text-[var(--md-on-error-container)]'
            }`}>
              {result === 'correct' ? 'Great job! This will be reviewed less frequently.' : "That's okay! This will come up again soon."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
