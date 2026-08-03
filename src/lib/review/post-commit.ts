import { logger } from '@/lib/logger';

export type PostCommitScheduler = (work: () => Promise<void>) => void;

export type NamedPostCommitTask = {
  name: string;
  run: () => Promise<unknown>;
};

type DispatchPostCommitInput = {
  owner: string;
  context?: Record<string, unknown>;
  tasks: NamedPostCommitTask[];
  scheduler?: PostCommitScheduler;
};

/**
 * Own best-effort work after a canonical write has committed.
 *
 * Request handlers can provide Next's `after()` as a scheduler. Other callers
 * await the same work inline, so scripts and tests never leave naked promises
 * behind. Each enrichment is isolated and identified in structured logs.
 */
export async function dispatchPostCommit({
  owner,
  context = {},
  tasks,
  scheduler,
}: DispatchPostCommitInput): Promise<void> {
  if (tasks.length === 0) return;

  let execution: Promise<void> | null = null;

  async function runTaskBatch(): Promise<void> {
    const results = await Promise.allSettled(
      tasks.map((task) => Promise.resolve().then(() => task.run())),
    );

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return;

      logger.error('Post-commit task failed', {
        ...context,
        owner,
        task: tasks[index].name,
        error: String(result.reason),
      });
    });
  }

  function runOwnedPostCommit(): Promise<void> {
    execution ??= runTaskBatch();
    return execution;
  }

  if (!scheduler) {
    await runOwnedPostCommit();
    return;
  }

  try {
    scheduler(runOwnedPostCommit);
  } catch (error) {
    logger.error('Failed to schedule post-commit work; running inline', {
      ...context,
      owner,
      error: String(error),
    });
    await runOwnedPostCommit();
  }
}
