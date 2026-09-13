import type { Profile, Protocol } from "./types";

export const maxTemperature = (protocol: Protocol) =>
  protocol === "claude" ? 1 : 2;

export function maxFrequencyPenalty(protocol: Protocol) {
  if (protocol === "chat") return 2;
  // Gemini excludes 2.0. Use the highest value at the UI's 0.01 precision.
  if (protocol === "gemini") return 1.99;
  return undefined;
}

export function samplingParameters(
  p: Pick<Profile, "protocol" | "temperature" | "frequencyPenalty">,
) {
  const temperature = p.temperature;
  const temperatureLimit = maxTemperature(p.protocol);
  if (
    temperature !== undefined &&
    (!Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > temperatureLimit)
  )
    throw Error(
      `温度需要在 0 到 ${temperatureLimit} 之间，也可以清空以使用模型默认值。`,
    );

  const penaltyLimit = maxFrequencyPenalty(p.protocol);
  const frequencyPenalty =
    penaltyLimit === undefined || p.frequencyPenalty === null
      ? undefined
      : (p.frequencyPenalty ?? penaltyLimit);
  if (
    frequencyPenalty !== undefined &&
    (!Number.isFinite(frequencyPenalty) ||
      frequencyPenalty < 0 ||
      frequencyPenalty > penaltyLimit!)
  )
    throw Error(
      `重复惩罚需要在 0 到 ${penaltyLimit} 之间，也可以清空以使用模型默认值。`,
    );

  return { temperature, frequencyPenalty };
}
