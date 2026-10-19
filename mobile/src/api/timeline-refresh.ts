import type { RemoteTimelineDeltaResult } from "@rhzycode/protocol";

/**
 * orderKey is a position, not a revision. Re-read existing rows as well as new
 * ones: a cached running message can finish without acquiring another key.
 */
export async function refreshThreadTimeline(
  fetchPage: (afterOrderKey: number) => Promise<RemoteTimelineDeltaResult>,
  onPage: (page: RemoteTimelineDeltaResult) => void,
  cancelled: () => boolean = () => false,
): Promise<number | null> {
  let cursor = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    if (cancelled()) return null;
    const page = await fetchPage(cursor);
    if (cancelled()) return null;
    onPage(page);
    if (!page.hasMore) return page.maxOrderKey;
    // maxOrderKey describes the entire history, not the returned page.
    const nextCursor = page.timeline.reduce((max, item) => Math.max(max, item.orderKey ?? 0), cursor);
    if (nextCursor <= cursor) throw new Error("Conversation history pagination did not advance.");
    cursor = nextCursor;
  }
  // Do not mark a partially fetched history complete; callers can use openThread.
  throw new Error("Conversation history refresh exceeded its page budget.");
}
