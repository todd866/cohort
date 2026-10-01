/**
 * Citation Management System
 *
 * Safety-critical versioned citation storage with full audit trail.
 * Designed for regulatory compliance in medical education.
 */

export {
  harvestCitation,
  checkCitation,
  getCitationHistory,
  findCitationByUrl,
} from './harvester';

export type { HarvestResult, HarvestOptions } from './harvester';
