import { useSyncExternalStore } from "react";
import { keyFor } from "./db";
import type { Profile } from "./types";

export const STARTER_KEY = "little-scene-onboarding-v2";
export const starterSteps = ["连接模型", "创建角色", "开启故事", "写出第一段"];
export interface StarterState {
  version: 2;
  status: "new" | "active" | "paused" | "complete";
  step: number;
  roleIds: string[];
  worldIds: string[];
  storyId: string;
  roleName: string;
  persona: string;
  title: string;
  background: string;
  profileDraft?: Omit<Profile, "key">;
  dismissedTips: string[];
}
const initial = (): StarterState => ({
  version: 2,
  status: "new",
  step: 0,
  roleIds: [],
  worldIds: [],
  storyId: "",
  roleName: "",
  persona: "",
  title: "",
  background: "",
  dismissedTips: [],
});
function readState(): StarterState {
  try {
    const value = JSON.parse(localStorage.getItem(STARTER_KEY) || "null");
    if (value?.version !== 2) return initial();
    const state = initial();
    for (const field of [
      "storyId",
      "roleName",
      "persona",
      "title",
      "background",
    ] as const)
      if (typeof value[field] === "string") state[field] = value[field];
    if (["new", "active", "paused", "complete"].includes(value.status))
      state.status = value.status;
    if (Number.isInteger(value.step))
      state.step = Math.max(0, Math.min(3, value.step));
    state.roleIds = Array.isArray(value.roleIds)
      ? value.roleIds.filter((id: unknown) => typeof id === "string")
      : [];
    state.worldIds = Array.isArray(value.worldIds)
      ? value.worldIds.filter((id: unknown) => typeof id === "string")
      : [];
    state.dismissedTips = Array.isArray(value.dismissedTips)
      ? value.dismissedTips.filter((id: unknown) => typeof id === "string")
      : [];
    if (value.profileDraft && typeof value.profileDraft.id === "string") {
      const { key: _key, ...draft } = value.profileDraft;
      state.profileDraft = draft;
    }
    return state;
  } catch {
    return initial();
  }
}
let current = readState();
const listeners = new Set<() => void>();
export function updateStarter(patch: Partial<StarterState>) {
  const next = { ...current, ...patch };
  // Never retain credentials in the onboarding draft, including imported state.
  if (next.profileDraft) {
    const { key: _key, ...draft } = next.profileDraft as Profile;
    next.profileDraft = draft;
  }
  localStorage.setItem(STARTER_KEY, JSON.stringify(next));
  current = next;
  listeners.forEach((notify) => notify());
}
export function useStarter() {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    () => current,
  );
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === STARTER_KEY || event.key === null) {
      current = readState();
      listeners.forEach((notify) => notify());
    }
  });
export function connectionReady(profile?: Profile) {
  return !!(
    profile?.testedAt &&
    profile.url &&
    profile.model &&
    (keyFor(profile) || profile.testedWithoutKey)
  );
}
export function openStarter(step?: number) {
  updateStarter({
    status: current.status === "complete" ? "complete" : "active",
    ...(step === undefined ? {} : { step }),
  });
  location.hash = "start";
}
export function dismissStarterTip(id: string) {
  updateStarter({
    dismissedTips: [...new Set([...current.dismissedTips, id])],
  });
}
