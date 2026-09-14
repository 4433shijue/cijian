// Shared by prose, chat and memory tasks; local chat sends never acquire this lock.
export const active = new Map<string, AbortController>();
export const isBusy = (id: string) => active.has(id);
export function stop(id: string) {
  active.get(id)?.abort();
}
