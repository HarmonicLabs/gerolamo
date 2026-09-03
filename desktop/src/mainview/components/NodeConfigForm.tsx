import { Component, Show } from "solid-js";
import type { NodeSettings } from "../../shared/nodeSettings";
import { TipLabel, btnSecondary, fieldClass } from "./nodeUI";

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
  settings: NodeSettings;
  patchSettings: (p: Partial<NodeSettings>) => void;
  onPickDb: () => void;
  onPickSnap: () => void;
};

export const NodeConfigForm: Component<Props> = (props) => {
  const s = () => props.settings;
  return (
    <div class="space-y-4">
      <p class="text-[11px] text-zinc-500 leading-relaxed">
        Same knobs as <code class="text-zinc-300">src/config/{props.network}/config.json</code>.
        Save writes this instance’s overlay (does not edit the repo file). DB path must be absolute.
      </p>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <TipLabel text="Name (optional)" tip="Friendly label in this Control Center only.\nNot a config.json field." />
          <input type="text" value={props.name} onInput={(e) => props.setName(e.currentTarget.value)} class={fieldClass} />
        </div>
        <div>
          <TipLabel
            text="network"
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
            text="port (HTTP / MiniBF)"
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
            text="syncFrom"
            tip={"config.json → syncFromTip / syncFromPoint\nLive ChainSync cannot pour genesis — it intersects DB tip or peer tip.\nGenesis density = Mithril bootstrap (step 3), then live follows tip."}
          />
          <select
            value={s().syncMode}
            onChange={(e) => props.patchSettings({ syncMode: e.currentTarget.value as NodeSettings["syncMode"] })}
            class={fieldClass}
          >
            <option value="tip">tip (syncFromTip)</option>
            <option value="genesis">genesis</option>
            <option value="point">point (slot + hash)</option>
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
            <TipLabel text="syncFromPointSlot" tip="config.json → syncFromPointSlot\nDecimal slot to intersect." />
            <input
              type="text"
              value={s().syncFromPointSlot}
              onInput={(e) => props.patchSettings({ syncFromPointSlot: e.currentTarget.value })}
              class={`${fieldClass} font-mono text-xs`}
            />
          </div>
          <div>
            <TipLabel text="syncFromPointBlockHash" tip="config.json → syncFromPointBlockHash\n64-char hex of that slot’s block." />
            <input
              type="text"
              value={s().syncFromPointBlockHash}
              onInput={(e) => props.patchSettings({ syncFromPointBlockHash: e.currentTarget.value })}
              class={`${fieldClass} font-mono text-xs`}
            />
          </div>
        </Show>
        <div>
          <TipLabel text="logLevel" tip={"config.json → logs.logLevel (or logLevel)\ndebug is noisy. info is the lab default."} />
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
            text="dbPath (absolute)"
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
            text="snapshot dir (Mithril, absolute)"
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
            text="n2c.socketPath (empty = off)"
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
          logs.logToConsole
        </label>
        <label class="flex items-center gap-2" data-tooltip="config.json → logs.logToFile\nWrites under the instance logs dir.">
          <input
            type="checkbox"
            checked={s().logToFile}
            onChange={(e) => props.patchSettings({ logToFile: e.currentTarget.checked })}
          />
          logs.logToFile
        </label>
        <label class="flex items-center gap-2" data-tooltip="config.json → tuiEnabled\nTerminal UI (q to quit). Off in the desktop app.">
          <input
            type="checkbox"
            checked={s().tuiEnabled}
            onChange={(e) => props.patchSettings({ tuiEnabled: e.currentTarget.checked })}
          />
          tuiEnabled
        </label>
        <label class="flex items-center gap-2" data-tooltip="config.json → unixSocket\nHTTP over unix — not N2C node.socket.">
          <input
            type="checkbox"
            checked={s().unixSocket}
            onChange={(e) => props.patchSettings({ unixSocket: e.currentTarget.checked })}
          />
          unixSocket (HTTP)
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
          Mithril --skip-apply
        </label>
      </div>

      <details class="rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2">
        <summary class="cursor-pointer text-xs text-zinc-300" data-tooltip="Nested config.json objects peerGovernor and n2n">
          peerGovernor + n2n
        </summary>
        <div class="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
          <label
            class="flex items-center gap-2 text-xs text-zinc-400 md:col-span-3"
            data-tooltip="config.json → peerGovernor.enabled\nCold/warm/hot outbound governor."
          >
            <input
              type="checkbox"
              checked={s().peerGovernorEnabled}
              onChange={(e) => props.patchSettings({ peerGovernorEnabled: e.currentTarget.checked })}
            />
            peerGovernor.enabled
          </label>
          <div>
            <TipLabel
              text="validation.workers"
              tip={"config.json → validation.workers\nHeader-validation worker threads (KES/VRF).\nauto = all CPU cores. 0 = inline on the main thread."}
            />
            <input
              type="text"
              value={String(s().validationWorkers)}
              onInput={(e) => {
                const v = e.currentTarget.value.trim();
                props.patchSettings({
                  validationWorkers: v === "" || v.toLowerCase() === "auto" ? "auto" : Math.max(0, Number(v) || 0),
                });
              }}
              class={`${fieldClass} font-mono`}
              placeholder="auto"
            />
          </div>
          <div>
            <TipLabel text="targetHot" tip="ChainSync peers to hold: 1 primary + verifiers.\n3 lets one lying peer be outvoted.\nNever demote the last hot peer." />
            <input
              type="number"
              value={s().targetHot}
              onInput={(e) => props.patchSettings({ targetHot: Number(e.currentTarget.value) || 0 })}
              class={`${fieldClass} font-mono`}
            />
          </div>
          <div>
            <TipLabel text="targetWarm" tip="KeepAlive / ΔQ standbys.\nWarm is not ChainSync." />
            <input
              type="number"
              value={s().targetWarm}
              onInput={(e) => props.patchSettings({ targetWarm: Number(e.currentTarget.value) || 0 })}
              class={`${fieldClass} font-mono`}
            />
          </div>
          <div>
            <TipLabel text="targetCold" tip="Known addresses, no bearer yet.\nFilled by PeerSharing." />
            <input
              type="number"
              value={s().targetCold}
              onInput={(e) => props.patchSettings({ targetCold: Number(e.currentTarget.value) || 0 })}
              class={`${fieldClass} font-mono`}
            />
          </div>
          <div>
            <TipLabel
              text="role"
              tip={"config.json → role\ndata = outbound only: follows the chain, serves MiniBF/N2C locally, no inbound peers, PeerSharing off (spec: only reachable nodes advertise it).\nrelay = also listens for inbound node-to-node peers (ChainSync, BlockFetch, KeepAlive) on n2n.port and advertises PeerSharing."}
            />
            <select
              value={s().role}
              onChange={(e) => {
                const role = e.currentTarget.value as NodeSettings["role"];
                props.patchSettings({ role, n2nEnabled: role === "relay" });
              }}
              class={fieldClass}
            >
              <option value="data">data node (outbound only)</option>
              <option value="relay">relay (accept inbound peers)</option>
            </select>
          </div>
          <div>
            <TipLabel text="n2n.port" tip="Inbound N2N listen port (not HTTP)." />
            <input
              type="number"
              value={s().n2nPort}
              onInput={(e) => props.patchSettings({ n2nPort: Number(e.currentTarget.value) || 3001 })}
              class={`${fieldClass} font-mono`}
            />
          </div>
          <div>
            <TipLabel text="n2n.maxConnections" tip="Cap on inbound N2N connections." />
            <input
              type="number"
              value={s().n2nMaxConnections}
              onInput={(e) => props.patchSettings({ n2nMaxConnections: Number(e.currentTarget.value) || 1 })}
              class={`${fieldClass} font-mono`}
            />
          </div>
        </div>
      </details>
    </div>
  );
};
