import {
  createContext,
  createSignal,
  useContext,
  For,
  Show,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ToastType = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  exiting: boolean;
}

interface ToastContextValue {
  show: (message: string, type?: ToastType) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
const ToastContext = createContext<ToastContextValue>();

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Styling helpers
// ---------------------------------------------------------------------------
const TYPE_STYLES: Record<ToastType, { border: string; bg: string; text: string; icon: string }> = {
  success: {
    border: "border-green/30",
    bg: "bg-green-dim",
    text: "text-green",
    icon: "M20 6L9 17l-5-5",
  },
  error: {
    border: "border-accent/30",
    bg: "bg-red-dim",
    text: "text-accent",
    icon: "M18 6L6 18M6 6l12 12",
  },
  warning: {
    border: "border-amber/30",
    bg: "bg-amber-dim",
    text: "text-amber",
    icon: "M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z",
  },
  info: {
    border: "border-cyan/30",
    bg: "bg-blue-dim",
    text: "text-cyan",
    icon: "M12 16v-4m0-4h.01M22 12a10 10 0 11-20 0 10 10 0 0120 0z",
  },
};

// ---------------------------------------------------------------------------
// ToastProvider
// ---------------------------------------------------------------------------
interface ToastProviderProps {
  children: JSX.Element;
}

let nextId = 0;

export const ToastProvider: Component<ToastProviderProps> = (props) => {
  const [toasts, setToasts] = createSignal<ToastItem[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  onCleanup(() => {
    for (const t of timers.values()) clearTimeout(t);
  });

  function dismiss(id: number) {
    // Start exit animation
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    // Remove after animation
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 250);
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  function show(message: string, type: ToastType = "info") {
    const id = ++nextId;
    setToasts((prev) => [...prev, { id, message, type, exiting: false }]);

    const timer = setTimeout(() => dismiss(id), 4000);
    timers.set(id, timer);
  }

  return (
    <ToastContext.Provider value={{ show }}>
      {props.children}

      {/* Toast container -- top-right, stacked */}
      <div
        class="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none"
        aria-live="polite"
        aria-relevant="additions"
      >
        <For each={toasts()}>
          {(toast) => {
            const style = TYPE_STYLES[toast.type];
            return (
              <div
                class={`pointer-events-auto flex items-start gap-3 rounded-[var(--radius-sm)] border ${style.border} ${style.bg} px-4 py-3 shadow-lg backdrop-blur-sm min-w-[280px] max-w-[380px] ${
                  toast.exiting ? "toast-exit" : "toast-enter"
                }`}
                role="status"
              >
                {/* Icon */}
                <svg
                  class={`h-4 w-4 mt-0.5 shrink-0 ${style.text}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d={style.icon} />
                </svg>

                {/* Message */}
                <span class="text-[13px] text-text leading-snug flex-1">
                  {toast.message}
                </span>

                {/* Close button */}
                <button
                  onClick={() => dismiss(toast.id)}
                  class="shrink-0 h-5 w-5 flex items-center justify-center rounded text-text-muted hover:text-text transition-colors cursor-pointer"
                  aria-label="Dismiss"
                >
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            );
          }}
        </For>
      </div>
    </ToastContext.Provider>
  );
};
