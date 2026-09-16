/**
 * The shipped GAMSAT corpus.
 *
 * Static imports rather than a filesystem read: the corpus is bundled, so it
 * works identically in a serverless function, a static export, and a test, and
 * there is no generated artifact that can be empty at build time.
 *
 * Adding a passage means adding an import here — deliberately explicit, because
 * every file is also an exact-path entry in the FOSS distribution manifest.
 */
import taxonomyJson from '../../../open-content/gamsat/moves-v1.json';
import historyIndustrialRevolution from '../../../open-content/gamsat/passages/s1/history-industrial-revolution.v1.json';
import literatureModernism from '../../../open-content/gamsat/passages/s1/literature-modernism.v1.json';
import philosophyFreeWill from '../../../open-content/gamsat/passages/s1/philosophy-free-will.v1.json';
import philosophyKnowledge from '../../../open-content/gamsat/passages/s1/philosophy-knowledge.v1.json';
import poetryDickinson from '../../../open-content/gamsat/passages/s1/poetry-dickinson.v1.json';
import sociologySocialCapital from '../../../open-content/gamsat/passages/s1/sociology-social-capital.v1.json';
import acidBaseTitration from '../../../open-content/gamsat/passages/s3/acid-base-titration.v1.json';
import enzymeKinetics from '../../../open-content/gamsat/passages/s3/enzyme-kinetics.v1.json';
import geneticsPedigree from '../../../open-content/gamsat/passages/s3/genetics-pedigree.v1.json';
import osmosisDiffusion from '../../../open-content/gamsat/passages/s3/osmosis-diffusion.v1.json';
import projectileMotion from '../../../open-content/gamsat/passages/s3/projectile-motion.v1.json';
import type { GamsatMove, GamsatPassage, GamsatTaxonomy } from './types';
import type { PassageSummary } from './select';

export const TAXONOMY = taxonomyJson as GamsatTaxonomy;

export const PASSAGES: GamsatPassage[] = [
  historyIndustrialRevolution,
  literatureModernism,
  philosophyFreeWill,
  philosophyKnowledge,
  poetryDickinson,
  sociologySocialCapital,
  acidBaseTitration,
  enzymeKinetics,
  geneticsPedigree,
  osmosisDiffusion,
  projectileMotion,
] as GamsatPassage[];

const MOVES_BY_ID = new Map<string, GamsatMove>(TAXONOMY.moves.map((m) => [m.id, m]));

export function getMove(id: string): GamsatMove | null {
  return MOVES_BY_ID.get(id) ?? null;
}

export function getPassage(id: string): GamsatPassage | null {
  return PASSAGES.find((p) => p.id === id) ?? null;
}

/** Distinct moves a passage's questions demand. */
export function passageMoves(passage: GamsatPassage): string[] {
  return [...new Set(passage.questions.flatMap((q) => q.moves))].sort();
}

/** The lightweight index the client fetches to run selection. */
export function corpusSummaries(): PassageSummary[] {
  return PASSAGES.map((passage) => ({
    id: passage.id,
    domain: passage.domain,
    moves: passageMoves(passage),
  }));
}

export interface CorpusStats {
  passages: number;
  questions: number;
  movesInTaxonomy: number;
  movesCovered: number;
  /** Moves appearing in only one domain — contrast is impossible for these. */
  singleDomainMoves: string[];
}

/**
 * Coverage, including the measure that matters for the product's central claim:
 * a move present in only one domain cannot distinguish transfer from
 * recognition, so it reads as covered while buying no evidence.
 */
export function corpusStats(): CorpusStats {
  const domainsByMove = new Map<string, Set<string>>();
  let questions = 0;

  for (const passage of PASSAGES) {
    questions += passage.questions.length;
    for (const move of passageMoves(passage)) {
      const set = domainsByMove.get(move) ?? new Set<string>();
      set.add(passage.domain);
      domainsByMove.set(move, set);
    }
  }

  return {
    passages: PASSAGES.length,
    questions,
    movesInTaxonomy: TAXONOMY.moves.length,
    movesCovered: domainsByMove.size,
    singleDomainMoves: [...domainsByMove.entries()]
      .filter(([, domains]) => domains.size < 2)
      .map(([move]) => move)
      .sort(),
  };
}
