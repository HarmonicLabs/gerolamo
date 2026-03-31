import { ErrorBoundary as SolidErrorBoundary, type Component, type JSX } from "solid-js";

// ---------------------------------------------------------------------------
// ErrorBoundary -- SolidJS ErrorBoundary wrapper with ROG-themed UI
// ---------------------------------------------------------------------------
interface AppErrorBoundaryProps {
  children: JSX.Element;
}

const ErrorFallback: Component<{ error: Error; retry: () => void }> = (props) => (
  <div
    class="glass-card border-l-2 border-l-accent p-6 flex flex-col gap-4 max-w-lg mx-auto my-8"
    role="alert"
  >
    {/* Error icon */}
    <div class="flex items-center gap-3">
      <div class="flex items-center justify-center h-9 w-9 rounded-[var(--radius-sm)] bg-red-dim border border-accent/20">
        <svg
          class="h-5 w-5 text-accent"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <span class="text-[15px] font-semibold text-text">Something went wrong</span>
    </div>

    {/* Error message */}
    <div class="rounded-[var(--radius-sm)] bg-bg-sunken/60 border border-border-subtle px-4 py-3">
      <p class="text-[13px] font-mono text-text-secondary break-all leading-relaxed">
        {props.error.message || "An unexpected error occurred."}
      </p>
    </div>

    {/* Actions */}
    <div class="flex items-center gap-3">
      <button
        onClick={props.retry}
        class="inline-flex items-center gap-2 rounded-[var(--radius-sm)] bg-accent/10 border border-accent/25 px-4 py-2 text-[13px] font-medium text-accent hover:bg-accent/20 transition-colors cursor-pointer"
      >
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
        Retry
      </button>
      <a
        href="https://github.com/HarmonicLabs/gerolamo/issues/new"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 text-[12px] text-text-dim hover:text-text-secondary transition-colors"
      >
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
        Report issue
      </a>
    </div>
  </div>
);

const AppErrorBoundary: Component<AppErrorBoundaryProps> = (props) => (
  <SolidErrorBoundary
    fallback={(err, reset) => (
      <ErrorFallback error={err instanceof Error ? err : new Error(String(err))} retry={reset} />
    )}
  >
    {props.children}
  </SolidErrorBoundary>
);

export default AppErrorBoundary;
