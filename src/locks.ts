export async function withStoryLock<T>(
  id: string,
  work: () => Promise<T>,
): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) return work();
  return navigator.locks.request(
    "little-scene:" + id,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) throw Error("这本故事正在另一个标签页处理，请等待那边完成");
      return work();
    },
  );
}
