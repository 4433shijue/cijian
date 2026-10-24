import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
const modalStack: HTMLElement[] = [];
let pageOverflow = "";
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const modalRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const element = modalRef.current!;
    if (!modalStack.length) pageOverflow = document.body.style.overflow;
    modalStack.push(element);
    modalStack.sort((a, b) =>
      a === b
        ? 0
        : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
    );
    document.body.style.overflow = "hidden";
    const previous = document.activeElement as HTMLElement;
    const focusables = () =>
      Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),textarea,select,a[href],summary",
        ) || [],
      ).filter((e) => e.offsetParent !== null);
    if (
      modalStack.at(-1) === element &&
      !modalRef.current?.contains(document.activeElement)
    )
      focusables()[0]?.focus();
    const close = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== element || e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const items = focusables();
        if (!items.length) return;
        const first = items[0],
          last = items.at(-1)!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("keydown", close);
      const index = modalStack.indexOf(element);
      if (index >= 0) modalStack.splice(index, 1);
      if (!modalStack.length) document.body.style.overflow = pageOverflow;
      if (
        previous?.isConnected &&
        (!modalStack.length || modalStack.at(-1)?.contains(previous))
      )
        previous.focus();
    };
  }, []);
  return (
    <div
      className="veil"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
