import {
  createElement,
  lazy,
  Suspense,
  type ComponentProps,
  type ComponentType,
} from "react";

export function lazyPanel<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
) {
  const Panel = lazy(load);
  return function DeferredPanel(props: ComponentProps<T>) {
    return (
      <Suspense fallback={<p role="status">正在打开…</p>}>
        {createElement(Panel, props)}
      </Suspense>
    );
  };
}
