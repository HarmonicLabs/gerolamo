import { useState, useRef, useEffect, useCallback } from "react";
import { useBlocks } from "@/lib/api";
import { formatNumber } from "@/lib/format";

export default function ChainDiagramPage() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const { data: allBlocks = [] } = useBlocks(30);
  const blocks = allBlocks.slice(0, 30);
  const blockW = 120;
  const blockH = 60;
  const gap = 30;

  const handleMouseDown = (e: React.MouseEvent) => {
    setDragging(true);
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    setOffset({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  };
  const handleMouseUp = () => setDragging(false);
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.max(0.3, Math.min(3, z - e.deltaY * 0.001)));
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (svg) {
      svg.addEventListener("wheel", handleWheel, { passive: false });
      return () => svg.removeEventListener("wheel", handleWheel);
    }
  }, [handleWheel]);

  const eraNames: Record<number, string> = { 1: "Byron", 2: "Shelley", 3: "Allegra", 4: "Mary", 5: "Alonzo", 6: "Babbage", 7: "Conway" };

  return (
    <div className="space-y-4 animate-fade-in-up">
      <h1 className="text-2xl font-bold neon-text-red">Chain Diagram</h1>
      <p className="text-xs text-muted-foreground">Scroll to zoom, drag to pan. Showing last {blocks.length} blocks from the node.</p>

      <div className="glass-panel rounded-lg overflow-hidden" style={{ height: "calc(100vh - 200px)" }}>
        <svg
          ref={svgRef}
          className="w-full h-full cursor-grab active:cursor-grabbing"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <g transform={`translate(${offset.x + 40}, ${offset.y + 80}) scale(${zoom})`}>
            {blocks.map((block, i) => {
              const x = i * (blockW + gap);
              const y = 0;

              return (
                <g key={block.slot}>
                  {i > 0 && (
                    <line x1={x - gap} y1={blockH / 2} x2={x} y2={blockH / 2} stroke="hsl(186,100%,50%)" strokeWidth="2" opacity="0.5" />
                  )}
                  <rect x={x} y={y} width={blockW} height={blockH} rx="4" fill="hsl(240,15%,7%)" stroke="hsl(186,100%,50%)" strokeWidth="1.5" opacity="0.9" />
                  <text x={x + blockW / 2} y={y + 22} textAnchor="middle" fill="hsl(186,100%,50%)" fontSize="11" fontFamily="monospace">
                    {formatNumber(block.slot)}
                  </text>
                  <text x={x + blockW / 2} y={y + 40} textAnchor="middle" fill="hsl(220,10%,50%)" fontSize="9" fontFamily="monospace">
                    {block.txCount} txs · {(block.size / 1024).toFixed(0)}KB
                  </text>
                </g>
              );
            })}
            {blocks.length === 0 && (
              <text x="200" y="30" textAnchor="middle" fill="hsl(220,10%,50%)" fontSize="14" fontFamily="monospace">
                No blocks synced yet
              </text>
            )}
          </g>
        </svg>
      </div>
    </div>
  );
}
