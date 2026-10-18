import type { SceneEvent } from "./types";
import type { buildContext } from "./context";

export function sameChat(e: SceneEvent, player: string, partner: string) {
  return e.kind === "message" && e.participants.length === 2 &&
    e.participants.includes(player) && e.participants.includes(partner);
}

export function pendingChatMessages(events: SceneEvent[], player: string, partner: string) {
  return events.filter((e) => sameChat(e, player, partner) &&
    e.speaker === player && e.origin === "user" && e.chatPending &&
    !e.chatBatchId && !e.deleted && e.status === "complete")
    .sort((a, b) => a.seq - b.seq);
}

export async function sendChatMessage(_storyId: string, _player: string, _partner: string, _text: string): Promise<string> { throw Error("旧聊天入口已停用，请进入独立手机作品"); }
export async function replyChat(_storyId: string, _batchId?: string, _legacyEventId?: string): Promise<void> { throw Error("旧聊天入口已停用，请进入独立手机作品"); }
export async function previewChat(_storyId: string): Promise<Awaited<ReturnType<typeof buildContext>>> { throw Error("旧聊天入口已停用，请进入独立手机作品"); }
export async function dismissChatBatch(_id: string): Promise<void> { throw Error("旧聊天入口已停用，请进入独立手机作品"); }
