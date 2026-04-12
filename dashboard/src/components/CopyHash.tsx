import React from "react";
import { Copy, Check } from "lucide-react";
import { truncateHash } from "@/lib/format";

interface CopyHashProps {
  hash: string;
  chars?: number;
}

export function CopyHash({ hash, chars = 8 }: CopyHashProps) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span className="inline-flex items-center gap-1 font-mono text-sm">
      <span className="text-muted-foreground">{truncateHash(hash, chars)}</span>
      <button onClick={handleCopy} className="text-muted-foreground hover:text-secondary transition-colors">
        {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}
