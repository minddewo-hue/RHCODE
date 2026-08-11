import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TraceInteraction } from "./useInteractionTrace";

interface ComposerFocusOptions {
  enabled: boolean;
  blocked: boolean;
  traceInteraction: TraceInteraction;
}

export function useComposerFocus({ enabled, blocked, traceInteraction }: ComposerFocusOptions) {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const nativeFocusPendingRef = useRef(false);
  const [focusRequest, setFocusRequest] = useState(0);

  const ensureNativeComposerFocus = useCallback((reason: string): void => {
    if (nativeFocusPendingRef.current) return;
    nativeFocusPendingRef.current = true;
    void window.rhzycode.focusWindowContents().then(() => {
      composerRef.current?.focus({ preventScroll: true });
      traceInteraction("composer-native-focus-restored", { reason });
    }).catch(() => undefined).finally(() => {
      nativeFocusPendingRef.current = false;
    });
  }, [traceInteraction]);

  const focusComposer = useCallback((reason = "requested"): void => {
    traceInteraction("composer-focus-requested", { reason });
    composerRef.current?.focus({ preventScroll: true });
    setFocusRequest((current) => current + 1);
    window.requestAnimationFrame(() => {
      traceInteraction("composer-focus-frame", {
        reason,
        focused: document.activeElement === composerRef.current,
      });
    });
  }, [traceInteraction]);

  useLayoutEffect(() => {
    if (focusRequest === 0 || !enabled || blocked) return;
    composerRef.current?.focus({ preventScroll: true });
    ensureNativeComposerFocus("layout");
  }, [blocked, enabled, ensureNativeComposerFocus, focusRequest]);

  useEffect(() => {
    const focusComposerWhenWindowActivates = () => {
      if (document.visibilityState !== "visible" || !enabled || blocked) return;
      if (!document.hasFocus() || document.activeElement === document.body || document.activeElement === null) {
        composerRef.current?.focus({ preventScroll: true });
        ensureNativeComposerFocus("window-activated");
      }
    };
    window.addEventListener("focus", focusComposerWhenWindowActivates);
    document.addEventListener("visibilitychange", focusComposerWhenWindowActivates);
    return () => {
      window.removeEventListener("focus", focusComposerWhenWindowActivates);
      document.removeEventListener("visibilitychange", focusComposerWhenWindowActivates);
    };
  }, [blocked, enabled, ensureNativeComposerFocus]);

  useEffect(() => window.rhzycode.onWindowFocus(() => {
    if (!enabled || blocked) return;
    if (!document.hasFocus() || document.activeElement === document.body || document.activeElement === null) {
      composerRef.current?.focus({ preventScroll: true });
      ensureNativeComposerFocus("native-window-activated");
    }
  }), [blocked, enabled, ensureNativeComposerFocus]);

  return {
    composerRef,
    ensureNativeComposerFocus,
    focusComposer,
  };
}
