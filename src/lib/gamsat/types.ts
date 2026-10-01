/**
 * Transport + corpus types for the GAMSAT reasoning-move engine.
 *
 * Deliberately free of database fields and framework imports: the corpus is
 * static JSON under `open-content/gamsat/`, so a self-hoster (or another client)
 * can consume it without adopting MD3's persistence model.
 */

export type GamsatSection = 's1' | 's2' | 's3' | 'shared';

export interface GamsatMove {
  id: string;
  name: string;
  section: GamsatSection;
  definition: string;
  exemplar: string;
  cues: string[];
  /**
   * The skill in ACER's DECLARED construct that this move maps to. Provenance
   * for the category, not evidence the move discriminates on the live exam:
   * ACER's descriptors are deliberately generic and its free practice material
   * is reported as unrepresentative. Definitions should come from people who
   * teach the exam; validation, ultimately, from response data.
   */
  acerBasis?: { family: string; skill: string };
}

export interface GamsatTaxonomy {
  schemaVersion: number;
  taxonomyVersion: string;
  grounding: {
    state: string;
    note: string;
    design: string;
    source?: string;
    /** Which source is authoritative for what — see the note on acerBasis. */
    authoritativeFor?: Record<string, string>;
    validationPath?: string[];
  };
  moves: GamsatMove[];
}

export interface GamsatOption {
  label: string;
  text: string;
  isCorrect: boolean;
}

export interface GamsatQuestion {
  id: string;
  /** Reasoning moves this question demands. Never empty — enforced at import. */
  moves: string[];
  stem: string;
  options: GamsatOption[];
  explanation: string;
  difficulty: string;
}

export interface GamsatPassage {
  schemaVersion: number;
  id: string;
  section: GamsatSection;
  title: string;
  /** Orthogonal to `moves`: the subject matter, used to measure transfer. */
  domain: string;
  passage: string;
  questions: GamsatQuestion[];
  licence: { id: string; attribution: string };
  origin: string;
}

/** Per-move performance, accumulated client-side across sessions. */
export interface MoveRecord {
  correct: number;
  total: number;
}

export type MasteryState = Record<string, MoveRecord>;
