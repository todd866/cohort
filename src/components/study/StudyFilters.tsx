'use client';

import { useState } from 'react';
export interface FilterOptions {
  type?: 'card' | 'question' | 'group';
  difficulty?: 'easy' | 'medium' | 'hard';
  topics?: string[];
}

export interface AvailableFilters {
  types: string[];
  difficulties: string[];
  topics: string[];
}

interface StudyFiltersProps {
  filters: FilterOptions;
  onChange: (filters: FilterOptions) => void;
  availableFilters?: AvailableFilters;
  onFilterChange?: (filterType: string, filterValue: string | null, activeFilters: FilterOptions) => void;
}

const TYPE_LABELS: Record<string, string> = {
  card: 'Cards',
  question: 'MCQs',
  group: 'ECG Cases',
};

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

export function StudyFilters({ filters, onChange, availableFilters, onFilterChange }: StudyFiltersProps) {
  const [expanded, setExpanded] = useState(false);

  // Derive available options from data
  const availableTypes = availableFilters?.types || [];
  const availableDifficulties = availableFilters?.difficulties || [];
  const availableTopics = availableFilters?.topics || [];

  const hasActiveFilters = !!(filters.type || filters.difficulty || filters.topics?.length);
  const hasAnyFilters = availableTypes.length > 1 || availableDifficulties.length > 0 || availableTopics.length > 0;

  // Don't show filter button if there's nothing to filter by
  if (!hasAnyFilters && !hasActiveFilters) {
    return null;
  }

  const handleTypeChange = (value: 'card' | 'question' | 'group' | undefined) => {
    const newFilters = { ...filters, type: value };
    onChange(newFilters);
    onFilterChange?.('type', value ?? null, newFilters);
  };

  const handleDifficultyChange = (value: 'easy' | 'medium' | 'hard' | undefined) => {
    const newFilters = { ...filters, difficulty: value };
    onChange(newFilters);
    onFilterChange?.('difficulty', value ?? null, newFilters);
  };

  const handleTopicToggle = (topic: string) => {
    const currentTopics = filters.topics || [];
    const newTopics = currentTopics.includes(topic)
      ? currentTopics.filter((t) => t !== topic)
      : [...currentTopics, topic];
    const newFilters = { ...filters, topics: newTopics.length ? newTopics : undefined };
    onChange(newFilters);
    onFilterChange?.('topic', newTopics.length ? topic : null, newFilters);
  };

  const handleClear = () => {
    const newFilters: FilterOptions = {};
    onChange(newFilters);
    onFilterChange?.('clear', null, newFilters);
  };

  // Collapsed view - just show a button to expand
  if (!expanded && !hasActiveFilters) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-[var(--md-on-surface-variant)] hover:text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container)] rounded-lg transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
          />
        </svg>
        Filter
      </button>
    );
  }

  return (
    <div className="space-y-3 p-3 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--md-on-surface)]">Filters</span>
        <div className="flex items-center gap-2">
          {hasActiveFilters && (
            <button
              onClick={handleClear}
              className="text-xs text-[var(--md-primary)] hover:underline"
            >
              Clear all
            </button>
          )}
          <button
            onClick={() => setExpanded(false)}
            className="p-1 hover:bg-[var(--md-surface-container-high)] rounded"
          >
            <svg className="w-4 h-4 text-[var(--md-on-surface-variant)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Type filter - only show if multiple types available */}
      {availableTypes.length > 1 && (
        <div>
          <span className="text-xs text-[var(--md-on-surface-variant)] mb-1.5 block">Type</span>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => handleTypeChange(undefined)}
              className={`px-3 py-1 text-xs rounded-full transition-colors ${
                !filters.type
                  ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]'
                  : 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-highest)]'
              }`}
            >
              All
            </button>
            {availableTypes.map((type) => (
              <button
                key={type}
                onClick={() => handleTypeChange(type as 'card' | 'question' | 'group')}
                className={`px-3 py-1 text-xs rounded-full transition-colors ${
                  filters.type === type
                    ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]'
                    : 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-highest)]'
                }`}
              >
                {TYPE_LABELS[type] || type}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Difficulty filter - only show if difficulties exist */}
      {availableDifficulties.length > 0 && (
        <div>
          <span className="text-xs text-[var(--md-on-surface-variant)] mb-1.5 block">Difficulty</span>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => handleDifficultyChange(undefined)}
              className={`px-3 py-1 text-xs rounded-full transition-colors ${
                !filters.difficulty
                  ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]'
                  : 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-highest)]'
              }`}
            >
              All
            </button>
            {availableDifficulties.map((diff) => (
              <button
                key={diff}
                onClick={() => handleDifficultyChange(diff as 'easy' | 'medium' | 'hard')}
                className={`px-3 py-1 text-xs rounded-full transition-colors ${
                  filters.difficulty === diff
                    ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]'
                    : 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-highest)]'
                }`}
              >
                {DIFFICULTY_LABELS[diff] || diff}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Topic filter - only show if topics exist */}
      {availableTopics.length > 0 && (
        <div>
          <span className="text-xs text-[var(--md-on-surface-variant)] mb-1.5 block">Topics</span>
          <div className="flex flex-wrap gap-1.5">
            {availableTopics.map((topic) => {
              const isActive = filters.topics?.includes(topic);
              return (
                <button
                  key={topic}
                  onClick={() => handleTopicToggle(topic)}
                  className={`px-3 py-1 text-xs rounded-full transition-colors ${
                    isActive
                      ? 'bg-[var(--md-secondary)] text-[var(--md-on-secondary)]'
                      : 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-highest)]'
                  }`}
                >
                  {topic}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Active filter summary */}
      {hasActiveFilters && (
        <div className="pt-2 border-t border-[var(--md-outline-variant)]">
          <div className="flex items-center flex-wrap gap-2 text-xs text-[var(--md-on-surface-variant)]">
            <span>Active:</span>
            {filters.type && (
              <span className="px-2 py-0.5 rounded bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]">
                {TYPE_LABELS[filters.type] || filters.type}
              </span>
            )}
            {filters.difficulty && (
              <span className="px-2 py-0.5 rounded bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]">
                {DIFFICULTY_LABELS[filters.difficulty] || filters.difficulty}
              </span>
            )}
            {filters.topics?.map((t) => (
              <span key={t} className="px-2 py-0.5 rounded bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
