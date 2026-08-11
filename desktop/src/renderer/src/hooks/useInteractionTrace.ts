import { useCallback, type RefObject } from "react";

export type InteractionTraceDetail = Record<string, string | number | boolean | null>;
export type TraceInteraction = (event: string, detail?: InteractionTraceDetail) => void;

export function useInteractionTrace(selectedThreadIdRef: RefObject<string | null>): TraceInteraction {
  return useCallback((event: string, detail: InteractionTraceDetail = {}): void => {
    window.rhzycode.recordPerformanceTrace(event, {
      ...detail,
      selectedThreadId: selectedThreadIdRef.current,
      rendererMs: Math.round(performance.now()),
    });
  }, [selectedThreadIdRef]);
}
