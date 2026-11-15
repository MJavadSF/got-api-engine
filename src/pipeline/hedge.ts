// ── Hedged requests: cut tail latency for safe requests ──────────
//
// If the primary attempt is slower than the hedge delay (p95 by default), a
// second attempt is started — on another upstream when one exists. The first
// response wins and the other attempt is aborted.

import { Cancellation } from "../core/cancellation";
import type { AttemptRequest, AttemptResponse } from "./transport";

export interface HedgeLauncher {
  /** Delay before hedging, or undefined to skip hedging now. */
  delayMs(): number | undefined;
  /** Prepare a hedge attempt (acquires capacity) or null when not allowed. */
  prepare(): { request: AttemptRequest; release: () => void } | null;
}

export interface HedgedResponse {
  response: AttemptResponse;
  hedged: boolean;
}

export async function sendHedged(
  send: (req: AttemptRequest, isHedge: boolean) => Promise<AttemptResponse>,
  primary: AttemptRequest,
  launcher: HedgeLauncher,
): Promise<HedgedResponse> {
  const delay = launcher.delayMs();
  if (delay === undefined) return { response: await send(primary, false), hedged: false };

  const primaryCtl = new Cancellation().follow(primary.signal, "caller");
  const primaryP = send({ ...primary, signal: primaryCtl.signal }, false);
  // Settled before the hedge started: detach from the request signal.
  primaryP.then(
    () => primaryCtl.release(),
    () => primaryCtl.release(),
  );

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"hedge">((resolve) => {
    timer = setTimeout(() => resolve("hedge"), delay);
    timer.unref?.();
  });

  const first = await Promise.race([primaryP.then((r) => ({ r })), timeout]).catch((err: unknown) => {
    clearTimeout(timer);
    throw err;
  });
  if (first !== "hedge") {
    clearTimeout(timer);
    return { response: first.r, hedged: false };
  }

  const hedge = launcher.prepare();
  if (!hedge) return { response: await primaryP, hedged: false };

  const hedgeCtl = new Cancellation().follow(hedge.request.signal, "caller");
  const hedgeP = send({ ...hedge.request, signal: hedgeCtl.signal }, true);
  try {
    const winner = await Promise.any([
      primaryP.then((response) => ({ response, hedged: false })),
      hedgeP.then((response) => ({ response, hedged: true })),
    ]);
    (winner.hedged ? primaryCtl : hedgeCtl).abort("local");
    return winner;
  } catch (err) {
    // Promise.any rejects with an AggregateError: surface the primary's error.
    throw (err as AggregateError).errors[0];
  } finally {
    // Swallow the loser's rejection (it was aborted or failed later).
    primaryP.catch(() => undefined);
    hedgeP.catch(() => undefined);
    hedge.release();
    hedgeCtl.release();
  }
}
