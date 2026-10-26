import { z } from 'zod';

export const simulationTopics = ['pre-eclampsia','postpartum-haemorrhage','maternal-collapse'] as const;
export const simulationGoalSchema = z.discriminatedUnion('enabled',[
  z.object({v:z.literal(1),enabled:z.literal(false)}).strict(),
  z.object({v:z.literal(1),enabled:z.literal(true),deadline:z.string().datetime({offset:true}),topics:z.array(z.enum(simulationTopics)).min(1).max(3)}).strict(),
]);
export type SimulationGoal = z.infer<typeof simulationGoalSchema>;
export function parseSimulationGoal(value:unknown):SimulationGoal|null {
  const parsed=simulationGoalSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** User-owned dates are provenance-labelled preferences, not cohort allocation evidence. */
export function focusFromGoal(goal:SimulationGoal,now:Date) {
  if(!goal.enabled) return null;
  const deadline=new Date(goal.deadline).toISOString();
  const remaining=Date.parse(deadline)-now.getTime();
  if(!Number.isFinite(remaining)||remaining<=0||remaining>14*86400000) return null;
  const topics=[...new Set(goal.topics)].sort();
  return {deadline,topics,fingerprint:`learner-sim-v1:${deadline}:${topics.join(',')}`};
}
