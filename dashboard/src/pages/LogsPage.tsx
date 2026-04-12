import { useState, useRef, useEffect } from "react";
import { useLogs, useSSE, type LogEntry } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Pause, Play } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

const levelColors: Record<string, string> = {
  INFO: "text-secondary",
  WARN: "text-yellow-400",
  ERROR: "text-primary",
  DEBUG: "text-muted-foreground",
  info: "text-secondary",
  warn: "text-yellow-400",
  error: "text-primary",
  debug: "text-muted-foreground",
};

export default function LogsPage() {
  const [filter, setFilter] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const level = filter?.toUpperCase() ?? "INFO";
  const { data: logs = [] } = useLogs(level, 200);

  useSSE<LogEntry[]>("logs", (newLogs) => {
    if (!paused) qc.invalidateQueries({ queryKey: ["logs"] });
  });

  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [paused, logs]);

  return (
    <div className="space-y-4 animate-fade-in-up">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold neon-text-red">Logs</h1>
        <div className="flex items-center gap-2">
          {["INFO", "WARN", "ERROR", "DEBUG"].map((lvl) => (
            <Button
              key={lvl}
              variant="outline"
              size="sm"
              className={`border-border text-xs uppercase ${filter?.toUpperCase() === lvl ? (levelColors[lvl] ?? "") + " border-current" : ""}`}
              onClick={() => setFilter(filter?.toUpperCase() === lvl ? null : lvl)}
            >
              {lvl}
            </Button>
          ))}
          <Button variant="outline" size="sm" className="border-border" onClick={() => setPaused(!paused)}>
            {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="glass-panel rounded-lg p-4 font-mono text-xs max-h-[calc(100vh-200px)] overflow-y-auto space-y-0.5">
        {logs.map((log, i) => (
          <div key={i} className="flex gap-3 py-0.5 hover:bg-muted/20 px-1 rounded">
            <span className="text-muted-foreground shrink-0 w-48">
              {new Date(log.timestamp).toLocaleTimeString()}
            </span>
            <span className={`shrink-0 w-12 uppercase ${levelColors[log.level] ?? "text-muted-foreground"}`}>
              {log.level}
            </span>
            <span className="text-foreground">{log.message}</span>
          </div>
        ))}
        {logs.length === 0 && (
          <div className="text-center text-muted-foreground py-8">No log entries found</div>
        )}
      </div>
    </div>
  );
}
