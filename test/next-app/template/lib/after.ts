// `after` exists from Next 15; on Next 14 background work simply runs untracked.
import * as server from "next/server";

type After = (task: Promise<unknown>) => void;
const nextAfter = (server as unknown as { after?: After; unstable_after?: After }).after;

export const after: After | undefined = nextAfter
  ? (task) => {
      try {
        nextAfter(task);
      } catch {
        // called outside a request scope — the task still runs
      }
    }
  : undefined;
