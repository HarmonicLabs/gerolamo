// ---------------------------------------------------------------------------
// Pebble Compiler — wraps @harmoniclabs/pebble for in-browser compilation
// Compiles .pebble source code → UPLC → CBOR bytes
// ---------------------------------------------------------------------------

export interface CompileResult {
  success: boolean;
  uplcHex?: string;
  errors: string[];
  warnings: string[];
}

/**
 * Compile Pebble source code to UPLC in the browser.
 * Uses createMemoryCompilerIoApi for filesystem-free compilation.
 */
export async function compilePebble(source: string): Promise<CompileResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const pebble = await import("@harmoniclabs/pebble");

    // Use the in-memory compiler IO API
    const sources = new Map<string, Uint8Array>([
      ["src/index.pebble", new TextEncoder().encode(source)],
    ]);

    const io = pebble.createMemoryCompilerIoApi({
      sources,
    });

    const compiler = new pebble.Compiler(io, {
      entry: "./src/index.pebble",
      root: ".",
      outDir: "./out",
      silent: true,
      removeTraces: true,
    });

    const result = await compiler.compile();

    if (result && result.length > 0) {
      const hex = Array.from(result, (b) => b.toString(16).padStart(2, "0")).join("");
      return { success: true, uplcHex: hex, errors, warnings };
    }

    return { success: false, errors: ["Compilation produced no output"], warnings };
  } catch (err: any) {
    // Pebble may not be browser-compatible yet
    const message = err?.message || String(err);
    if (message.includes("Cannot find module") || message.includes("is not a function")) {
      return {
        success: false,
        errors: ["Pebble compiler is not yet available in the browser environment. This feature requires the @harmoniclabs/pebble package to support browser builds."],
        warnings,
      };
    }
    return { success: false, errors: [message], warnings };
  }
}

/** Default example Pebble source code */
export const PEBBLE_EXAMPLE = `// Simple Pebble validator example
// Docs: https://pluts.harmoniclabs.tech/

contract HelloWorld {
    spend hello() {
        const { tx } = context;
        // Accept any transaction — a minimal validator
        assert tx.inputs.length() > 0;
    }
}
`;
