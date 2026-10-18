import type { SceneEvent } from "./types";
/** Archived phone messages never become prose input, even through old summaries. */
export const mainlineEvents = (events: SceneEvent[]) =>
  events.filter((e) => e.kind === "novel");
