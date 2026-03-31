import { type Component, createSignal } from "solid-js";
import { cn } from "@/lib/cn";

export interface BlockFilters {
  slotFrom: number | null;
  slotTo: number | null;
  hashPrefix: string;
  era: number | null;
  status: "all" | "finalized" | "volatile";
  sort: "newest" | "oldest";
}

export interface FilterBarProps {
  filters: BlockFilters;
  onChange: (filters: BlockFilters) => void;
}

const ERA_OPTIONS = [
  { value: null, label: "All Eras" },
  { value: 0, label: "Byron" },
  { value: 1, label: "Shelley" },
  { value: 2, label: "Allegra" },
  { value: 3, label: "Mary" },
  { value: 4, label: "Alonzo" },
  { value: 5, label: "Babbage" },
  { value: 6, label: "Conway" },
];

const inputClass = cn(
  "h-[30px] px-2.5 rounded-[var(--radius-sm)] border border-border bg-bg-input text-[12px] text-text",
  "placeholder:text-text-muted/60 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/20",
  "transition-colors duration-150",
);

const selectClass = cn(
  "h-[30px] px-2 rounded-[var(--radius-sm)] border border-border bg-bg-input text-[12px] text-text",
  "focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/20",
  "transition-colors duration-150 appearance-none cursor-pointer",
);

const buttonClass = (active: boolean) => cn(
  "h-[30px] px-3 rounded-[var(--radius-sm)] border text-[11px] font-medium transition-all duration-150",
  active
    ? "border-accent/30 bg-accent-dim text-accent"
    : "border-border bg-bg-input text-text-dim hover:text-text-secondary hover:border-border-bright",
);

export const FilterBar: Component<FilterBarProps> = (props) => {
  const update = (partial: Partial<BlockFilters>) => {
    props.onChange({ ...props.filters, ...partial });
  };

  return (
    <div class="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border-subtle/50 bg-bg-raised/30" role="search" aria-label="Block filters">
      {/* Slot range */}
      <input
        type="number"
        class={cn(inputClass, "w-[100px]")}
        placeholder="Slot from"
        aria-label="Filter by minimum slot number"
        value={props.filters.slotFrom ?? ""}
        onInput={(e) => {
          const v = e.currentTarget.value;
          update({ slotFrom: v ? parseInt(v, 10) : null });
        }}
      />
      <span class="text-text-muted text-[11px]" aria-hidden="true">-</span>
      <input
        type="number"
        class={cn(inputClass, "w-[100px]")}
        placeholder="Slot to"
        aria-label="Filter by maximum slot number"
        value={props.filters.slotTo ?? ""}
        onInput={(e) => {
          const v = e.currentTarget.value;
          update({ slotTo: v ? parseInt(v, 10) : null });
        }}
      />

      {/* Hash prefix search */}
      <input
        type="text"
        class={cn(inputClass, "w-[130px]")}
        placeholder="Hash prefix..."
        aria-label="Filter by block hash prefix"
        value={props.filters.hashPrefix}
        onInput={(e) => update({ hashPrefix: e.currentTarget.value })}
      />

      {/* Era dropdown */}
      <select
        class={cn(selectClass, "w-[100px]")}
        aria-label="Filter by era"
        value={props.filters.era === null ? "" : String(props.filters.era)}
        onChange={(e) => {
          const v = e.currentTarget.value;
          update({ era: v === "" ? null : parseInt(v, 10) });
        }}
      >
        {ERA_OPTIONS.map((opt) => (
          <option value={opt.value === null ? "" : String(opt.value)}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Status filter */}
      <div class="flex items-center gap-1" role="group" aria-label="Filter by block status">
        <button
          class={buttonClass(props.filters.status === "all")}
          onClick={() => update({ status: "all" })}
          aria-pressed={props.filters.status === "all"}
        >
          All
        </button>
        <button
          class={buttonClass(props.filters.status === "finalized")}
          onClick={() => update({ status: "finalized" })}
          aria-pressed={props.filters.status === "finalized"}
        >
          <span class="flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-green" />
            Finalized
          </span>
        </button>
        <button
          class={buttonClass(props.filters.status === "volatile")}
          onClick={() => update({ status: "volatile" })}
          aria-pressed={props.filters.status === "volatile"}
        >
          <span class="flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-orange" />
            Volatile
          </span>
        </button>
      </div>

      {/* Spacer */}
      <div class="flex-1" />

      {/* Sort toggle */}
      <button
        class={cn(
          "h-[30px] px-3 rounded-[var(--radius-sm)] border border-border bg-bg-input",
          "text-[11px] text-text-dim font-medium hover:text-text-secondary hover:border-border-bright",
          "transition-all duration-150 flex items-center gap-1.5",
        )}
        onClick={() => update({ sort: props.filters.sort === "newest" ? "oldest" : "newest" })}
        aria-label={`Sort by ${props.filters.sort === "newest" ? "oldest" : "newest"} first`}
      >
        <svg
          class={cn(
            "w-3 h-3 transition-transform duration-200",
            props.filters.sort === "oldest" && "rotate-180",
          )}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M12 5v14M19 12l-7 7-7-7" />
        </svg>
        {props.filters.sort === "newest" ? "Newest" : "Oldest"}
      </button>
    </div>
  );
};
