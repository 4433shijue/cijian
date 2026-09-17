import { useState } from "react";

interface ReadingLayout {
  toolbarCollapsed: boolean;
  composerCollapsed: boolean;
}

// Only presentation choices live here. Story text and model context stay in IndexedDB.
export function useReadingLayout(storyId: string) {
  const key = "cijian:reading-layout:" + storyId;
  const [layout, setLayout] = useState<ReadingLayout>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || "null");
      return {
        toolbarCollapsed: saved?.toolbarCollapsed === true,
        composerCollapsed: saved?.composerCollapsed === true,
      };
    } catch {
      return { toolbarCollapsed: false, composerCollapsed: false };
    }
  });
  const changeLayout = (patch: Partial<ReadingLayout>) => {
    setLayout((current) => {
      const next = { ...current, ...patch };
      try {
        sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Still usable without storage. */
      }
      return next;
    });
  };
  return [layout, changeLayout] as const;
}
