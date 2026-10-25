import type { ImageConnection } from "./image-types";
import {
  resolveImageEndpoint,
  resolvedImageProtocol,
} from "./image-connection";

/** Decide before dispatch; never probe an endpoint with a paid image request. */
export function imageReferencePolicy(
  profile: ImageConnection,
  textOnly = false,
) {
  if (textOnly) return { enabled: false, reason: "本次选择仅用文字外貌" };
  if (profile.references === "off")
    return { enabled: false, reason: "此接口未启用参考图，使用文字外貌" };
  if (
    resolvedImageProtocol(profile) === "images" &&
    /\/images\/generations\/?$/.test(
      new URL(resolveImageEndpoint(profile, true)).pathname,
    )
  )
    return {
      enabled: false,
      reason:
        "当前完整 generations 端点按文字生图处理；参考图需在接口预设中配置编辑能力",
    };
  if (
    resolvedImageProtocol(profile) === "custom" &&
    !profile.requestTemplate.includes("{{references}}")
  )
    return {
      enabled: false,
      reason: "此自定义接口未配置参考图参数，使用文字外貌",
    };
  return { enabled: true, reason: "" };
}
