export type ImageJsonState = "incomplete" | "complete" | "invalid";

const whitespace = (c: string) =>
  c === " " || c === "\t" || c === "\r" || c === "\n";

// Find one complete object/array in a single pass. JSON.parse still validates the
// grammar; balanced braces inside strings or unfinished Base64 are never enough.
export function imageJsonBoundary() {
  const closing: string[] = [];
  let started = false,
    inString = false,
    escaped = false;
  let state: ImageJsonState = "incomplete";
  return {
    push(text: string): ImageJsonState {
      for (const c of text) {
        if (state === "invalid") break;
        if (state === "complete") {
          if (!whitespace(c)) state = "invalid";
          continue;
        }
        if (!started) {
          if (whitespace(c)) continue;
          if (c !== "{" && c !== "[") {
            state = "invalid";
            break;
          }
          started = true;
        }
        if (inString) {
          if (c.charCodeAt(0) < 32) {
            state = "invalid";
            break;
          }
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === "{") closing.push("}");
        else if (c === "[") closing.push("]");
        else if (c === "}" || c === "]") {
          if (closing.pop() !== c) {
            state = "invalid";
            break;
          }
          if (!closing.length) state = "complete";
        }
      }
      return state;
    },
  };
}
