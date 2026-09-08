export type QueuePriority = "critical" | "normal";

type QueueTask = {
  priority: QueuePriority;
  label: string;
  enqueuedAt: number;
  run: () => Promise<void>;
};

const critical: QueueTask[] = [];
const normal: QueueTask[] = [];
const MAX_CONCURRENT = 2;
let running = 0;
let completed = 0;
let failed = 0;
let totalWaitMs = 0;
let maxWaitMs = 0;

function nextTask(): QueueTask | undefined {
  return critical.shift() ?? normal.shift();
}

function drain() {
  while (running < MAX_CONCURRENT) {
    const task = nextTask();
    if (!task) return;
    running += 1;
    const waitMs = Math.max(0, Date.now() - task.enqueuedAt);
    totalWaitMs += waitMs;
    maxWaitMs = Math.max(maxWaitMs, waitMs);
    void task.run()
      .then(() => { completed += 1; })
      .catch((error: any) => {
        failed += 1;
        console.error(`[priorityQueue] ${task.label}:`, error?.message ?? error);
      })
      .finally(() => {
        running -= 1;
        drain();
      });
  }
}

export function enqueueTask(
  priority: QueuePriority,
  label: string,
  run: () => Promise<void>,
) {
  const task = { priority, label, enqueuedAt: Date.now(), run };
  (priority === "critical" ? critical : normal).push(task);
  drain();
}

export function priorityQueueSnapshot() {
  const handled = completed + failed;
  return {
    running,
    pendingCritical: critical.length,
    pendingNormal: normal.length,
    completed,
    failed,
    averageWaitMs: handled > 0 ? Math.round(totalWaitMs / handled) : 0,
    maxWaitMs,
  };
}
