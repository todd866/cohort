/**
 * Public build: the exam-target registry ships EMPTY, by design.
 *
 * The engine in this directory is general — it takes an exam blueprint and
 * aims a scheduler at it. The blueprints the private instance runs on are the
 * University of Sydney's Year-3 KAT domains, their per-domain weightings, and
 * receipts referencing official assessment reports. That is the institution's
 * material, not ours to publish, so the fail-closed exporter excludes the real
 * registry and substitutes this reviewed replacement.
 *
 * Nothing about the engine is withheld — only one institution's exam data.
 *
 * To use it, register your own target: one entry per rotation carrying the
 * domain codes, labels and counts of the exam YOU are aiming at. See
 * ./types.ts for the shape and ./contract.ts for what is validated on load.
 */
import type { ExamTargetRegistrySource } from './types';

export const EXAM_TARGET_REGISTRY_SOURCE: Record<string, ExamTargetRegistrySource> = {};
