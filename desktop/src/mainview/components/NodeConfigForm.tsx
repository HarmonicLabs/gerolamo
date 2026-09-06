import { Component, Show } from "solid-js";
import type { NodeSettings } from "../../shared/nodeSettings";
import { TipLabel, btnSecondary, fieldClass } from "./nodeUI";

/** cores − 2: a core for the ledger thread, one for the OS; never below 2. */
function recommendedFor(cores: number): number {
  return cores ? Math.max(2, cores - 2) : 0;
}


type Props = {
  name: string;
  setName: (v: string) => void;
  network: "preprod" | "mainnet" | "preview";
  setNetwork: (v: "preprod" | "mainnet" | "preview") => void;
  port: number;
  setPort: (v: number) => void;
  dbPath: string;
  setDbPath: (v: string) => void;
  snapshotDir: string;
  setSnapshotDir: (v: string) => void;
  n2cSocket: string;
  setN2cSocket: (v: string) => void;
  skipApply: boolean;
  setSkipApply: (v: boolean) => void;
  /** Logical cores from the Bun side; the webview's navigator.hardwareConcurrency is capped at 8 by WebKit. */
  hostCores?: number;
  settings: NodeSettings;
  patchSettings: (p: Partial<NodeSettings>) => void;
  onPickDb: () => void;
  onPickSnap: () => void;
};

export const NodeConfigForm: Component<Props> = (props) => {
  const hostCores = () => props.hostCores || (typeof navigator !== "undefined" && Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 0);
  const recommendedWorkers = () => recommendedFor(hostCores());
  const s = () => props.settings;
  return (
    <div class="space-y-4">
      <p class="text-[11px] text-zinc-500 leading-relaxed">
        Same knobs as <code class="text-zinc-300">src/config/{props.network}/config.json</code>.
        Save writes this instance’s overlay (does not edit the repo file). DB path must be absolute.
      </p>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <TipLabel text="Name" tip="Friendly label in this Control Center only.\nNot a config.json field." />
          <input type="text" value={props.name} onInput={(e) => props.setName(e.currentTarget.value)} class={fieldClass} />
        </div>
        <div>
          <TipLabel
            text="Network"
            tip={"config.json → network\npreprod = testnet, magic 1 (default).\nmainnet = magic 764824073.\npreview = testnet, magic 2."}
          />
          <select
            value={props.network}
            onChange={(e) => props.setNetwork(e.currentTarget.value as "preprod" | "mainnet" | "preview")}
            class={fieldClass}
          >
            <option value="preprod">preprod</option>
            <option value="mainnet">mainnet</option>
            <option value="preview">preview</option>
          </select>
        </div>
        <div>
          <TipLabel
            text="HTTP port (MiniBF API)"
            tip={"config.json → port\nServes /stats, /docs, /api/v0/*.\nDefault 3030. One writer per port."}
          />
          <input
            type="number"
            value={props.port}
            onInput={(e) => props.setPort(Number(e.currentTarget.value) || 3030)}
            class={`${fieldClass} font-mono`}
          />
        </div>
        <div>
          <TipLabel
            text="Sync from"
            tip={"config.json → syncFromTip / syncFromPoint\nLive ChainSync cannot pour genesis — it intersects DB tip or peer tip.\nGenesis density = Mithril bootstrap (step 3), then live follows tip."}
          />
          <select
            value={s().syncMode}
            onChange={(e) => props.patchSettings({ syncMode: e.currentTarget.value as NodeSettings["syncMode"] })}
            class={fieldClass}
          >
            <option value="tip">chain tip</option>
            <option value="genesis">genesis</option>
            <option value="point">a specific block (slot + hash)</option>
          </select>
        </div>
        <Show when={s().syncMode === "tip"}>
          <div class="md:col-span-2 rounded-md border border-amber/30 bg-amber-dim px-3 py-2 text-[11px] text-amber">
            Tip sync has no ledger state behind the tip, so transaction rules and scripts cannot be enforced; they run in
            report-only mode. Headers, body hashes and peer agreement are still verified. For a fully validated ledger
            sync from genesis (or bootstrap with Mithril). Validation is not a setting.
          </div>
        </Show>
        <Show when={s().syncMode === "point"}>
          <div>
            <TipLabel text="Start slot" tip="config.json → syncFromPointSlot\nDecimal slot to intersect." />
            <input
              type="text"
              value={s().syncFromPointSlot}
              onInput={(e) => props.patchSettings({ syncFromPointSlot: e.currentTarget.value })}
              class={`${fieldClass} font-mono text-xs`}
            />
          </div>
          <div>
            <TipLabel text="Start block hash" tip="config.json → syncFromPointBlockHash\n64-char hex of that slot’s block." />
            <input
              type="text"
              value={s().syncFromPointBlockHash}
              onInput={(e) => props.patchSettings({ syncFromPointBlockHash: e.currentTarget.value })}
              class={`${fieldClass} font-mono text-xs`}
            />
          </div>
        </Show>
        <div>
          <TipLabel text="Log level" tip={"config.json → logs.logLevel (or logLevel)\ndebug is noisy. info is the lab default."} />
          <select
            value={s().logLevel}
            onChange={(e) => props.patchSettings({ logLevel: e.currentTarget.value as NodeSettings["logLevel"] })}
            class={fieldClass}
          >
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </div>
        <div class="md:col-span-2">
          <TipLabel
            text="Database path"
            tip={"config.json → dbPath\nSQLite chain DB. Must be absolute.\nOne writer only — never share with hydrate/soak."}
          />
          <div class="flex gap-2">
            <input
              type="text"
              value={props.dbPath}
              onInput={(e) => props.setDbPath(e.currentTarget.value)}
              placeholder="default: ~/.local/share/gerolamo/<id>/data/gerolamo.db"
              class={`${fieldClass} font-mono text-xs`}
            />
            <button
              type="button"
              class={btnSecondary}
              data-tooltip="Pick a folder or .db file.\nFolders become …/gerolamo.db"
              onClick={() => props.onPickDb()}
            >
              Browse
            </button>
          </div>
        </div>
        <div class="md:col-span-2">
          <TipLabel
            text="Mithril snapshot directory"
            tip={"Where mithril-bootstrap stores immutable chunks.\nDefaults to repo snapshots/mithril if that tree exists."}
          />
          <div class="flex gap-2">
            <input
              type="text"
              value={props.snapshotDir}
              onInput={(e) => props.setSnapshotDir(e.currentTarget.value)}
              placeholder="default: repo snapshots/mithril if present"
              class={`${fieldClass} font-mono text-xs`}
            />
            <button
              type="button"
              class={btnSecondary}
              data-tooltip="Pick the Mithril snapshot directory"
              onClick={() => props.onPickSnap()}
            >
              Browse
            </button>
          </div>
        </div>
        <div class="md:col-span-2">
          <TipLabel
            text="Node-to-client socket (empty = off)"
            tip={"config.json → n2c.socketPath\nOuroboros node.socket (wallets).\nEmpty / unset = N2C off (GEROLAMO_N2C=0)."}
          />
          <input
            type="text"
            value={props.n2cSocket}
            onInput={(e) => props.setN2cSocket(e.currentTarget.value)}
            placeholder="absolute path to node.socket"
            class={`${fieldClass} font-mono text-xs`}
          />
        </div>
      </div>

      <div class="flex flex-wrap gap-4 text-xs text-zinc-400">
        <label class="flex items-center gap-2" data-tooltip="config.json → logs.logToConsole">
          <input
            type="checkbox"
            checked={s().logToConsole}
            onChange={(e) => props.patchSettings({ logToConsole: e.currentTarget.checked })}
          />
          Log to console
        </label>
        <label class="flex items-center gap-2" data-tooltip="config.json → logs.logToFile\nWrites under the instance logs dir.">
          <input
            type="checkbox"
            checked={s().logToFile}
            onChange={(e) => props.patchSettings({ logToFile: e.currentTarget.checked })}
          />
          Log to file
        </label>
        <label class="flex items-center gap-2" data-tooltip="config.json → tuiEnabled\nTerminal UI (q to quit). Off in the desktop app.">
          <input
            type="checkbox"
            checked={s().tuiEnabled}
            onChange={(e) => props.patchSettings({ tuiEnabled: e.currentTarget.checked })}
          />
          Terminal UI
        </label>
        <label class="flex items-center gap-2" data-tooltip="config.json → unixSocket\nHTTP over unix — not N2C node.socket.">
          <input
            type="checkbox"
            checked={s().unixSocket}
            onChange={(e) => props.patchSettings({ unixSocket: e.currentTarget.checked })}
          />
          HTTP over Unix socket
        </label>
        <label
          class="flex items-center gap-2"
          data-tooltip="Mithril --skip-apply\nDownload snapshot files only; do not pour into SQLite."
        >
          <input
            type="checkbox"
            checked={props.skipApply}
            onChange={(e) => props.setSkipApply(e.currentTarget.checked)}
          />
          Mithril: download only (skip apply)
        </label>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label
            class="flex items-center gap-2 text-xs text-zinc-400 md:col-span-3"
            data-tooltip={"config.json → peerGovernor.enabled\nOn: the node finds peers through the topology and peer sharing, keeps the hot / warm / cold targets below and replaces peers that fail or fall behind.\nOff (legacy): connects only to the peers listed in the topology file, no discovery, no rotation."}
          >
            <input
              type="checkbox"
              checked={s().peerGovernorEnabled}
              onChange={(e) => props.patchSettings({ peerGovernorEnabled: e.currentTarget.checked })}
            />
            Peer discovery and rotation (P2P governor)
          </label>
          <div>
            <TipLabel
              text={`Validation worker threads · this machine has ${hostCores() || "?"} cores`}
              tip={"config.json → validation.workers\nThreads that verify block headers and witness signatures in parallel while the main thread applies the ledger.\n\"auto\" = one worker per core (all " + (hostCores() || "?") + "). Recommended: cores − 2, leaving a core for the ledger thread and one for the OS. 0 = no workers (everything on the main thread; slow)."}
            />
            <div class="flex items-center gap-2">
              <input
                type="number"
                min="0"
                value={s().validationWorkers === "auto" ? "" : String(s().validationWorkers)}
                placeholder={`auto (all ${hostCores() || "?"} cores)`}
                onInput={(e) => {
                  const v = e.currentTarget.value.trim();
                  props.patchSettings({ validationWorkers: v === "" ? "auto" : Math.max(0, Number(v) || 0) });
                }}
                class={`${fieldClass} font-mono`}
              />
              <button
                type="button"
                class={btnSecondary}
                disabled={!hostCores() || s().validationWorkers === recommendedWorkers()}
                data-tooltip={`Set ${recommendedWorkers()} (cores − 2)`}
                onClick={() => props.patchSettings({ validationWorkers: recommendedWorkers() })}
              >
                Use recommended ({recommendedWorkers() || "?"})
              </button>
            </div>
            <div class="mt-1 text-[10px] text-zinc-500">
              {s().validationWorkers === "auto"
                ? `auto: one worker per core (${hostCores() || "?"}). Recommended ${recommendedWorkers() || "?"} so the ledger thread and the OS keep a core each.`
                : `${s().validationWorkers} worker thread(s) on ${hostCores() || "?"} cores${hostCores() && Number(s().validationWorkers) > hostCores() ? " — more than the machine has" : ""}.`}
            </div>
          </div>
          <div>
            <TipLabel text="Hot peers (target)" tip="ChainSync peers to hold: 1 primary + verifiers.\n3 lets one lying peer be outvoted.\nNever demote the last hot peer." />
            <input
              type="number"
              value={s().targetHot}
              onInput={(e) => props.patchSettings({ targetHot: Number(e.currentTarget.value) || 0 })}
              class={`${fieldClass} font-mono`}
            />
          </div>
          <div>
            <TipLabel text="Warm peers (target)" tip="KeepAlive / ΔQ standbys.\nWarm is not ChainSync." />
            <input
              type="number"
              value={s().targetWarm}
              onInput={(e) => props.patchSettings({ targetWarm: Number(e.currentTarget.value) || 0 })}
              class={`${fieldClass} font-mono`}
            />
          </div>
          <div>
            <TipLabel text="Cold peers (target)" tip="Known addresses, no bearer yet.\nFilled by PeerSharing." />
            <input
              type="number"
              value={s().targetCold}
              onInput={(e) => props.patchSettings({ targetCold: Number(e.currentTarget.value) || 0 })}
              class={`${fieldClass} font-mono`}
            />
          </div>
          <div>
            <TipLabel
              text="Node role"
              tip={"config.json → role\nClient: outbound connections only — follows the chain and serves the local HTTP / node-to-client APIs.\nFull-duplex relay: additionally listens on the inbound peer port so other nodes (and your block producer) can sync from this one; the port must be reachable."}
            />
            <select
              value={s().role}
              onChange={(e) => {
                const role = e.currentTarget.value as NodeSettings["role"];
                props.patchSettings({ role, n2nEnabled: role === "relay" });
              }}
              class={fieldClass}
            >
              <option value="data">Client — outbound connections only</option>
              <option value="relay">Full-duplex relay — accepts inbound peers and serves the chain</option>
            </select>
          </div>
          <div>
            <TipLabel text="Inbound peer port" tip="Inbound N2N listen port (not HTTP)." />
            <input
              type="number"
              value={s().n2nPort}
              onInput={(e) => props.patchSettings({ n2nPort: Number(e.currentTarget.value) || 3001 })}
              class={`${fieldClass} font-mono`}
            />
          </div>
          <div>
            <TipLabel text="Max inbound connections" tip="Cap on inbound N2N connections." />
            <input
              type="number"
              value={s().n2nMaxConnections}
              onInput={(e) => props.patchSettings({ n2nMaxConnections: Number(e.currentTarget.value) || 1 })}
              class={`${fieldClass} font-mono`}
            />
          </div>
      </div>
    </div>
  );
};
