import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorPanelProps {
  message?: string;
  onRetry?: () => void;
}

export function ErrorPanel({ message = "Failed to load data", onRetry }: ErrorPanelProps) {
  return (
    <div className="glass-panel rounded-lg p-8 flex flex-col items-center justify-center gap-4 text-center">
      <AlertTriangle className="h-10 w-10 text-primary" />
      <p className="text-muted-foreground">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="border-primary/30 hover:border-primary">
          <RefreshCw className="h-4 w-4 mr-2" /> Retry
        </Button>
      )}
    </div>
  );
}
