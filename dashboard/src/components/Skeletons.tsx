import { Skeleton } from "@/components/ui/skeleton";

export function StatCardSkeleton() {
  return (
    <div className="glass-panel rounded-lg p-4 space-y-2">
      <Skeleton className="h-4 w-20 bg-muted" />
      <Skeleton className="h-8 w-32 bg-muted" />
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} className="h-6 flex-1 bg-muted" />
          ))}
        </div>
      ))}
    </div>
  );
}
