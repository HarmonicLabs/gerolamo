import { rpc } from "./rpc";
import type {
  BootstrapStatus,
  DetectResult,
  HealthResult,
  InstanceConfig,
  LogsResult,
  StatusResult,
} from "../../shared/types";

export const manager = {
  detect: (): Promise<DetectResult> => rpc.request.detect(),
  writeConfig: (config: Partial<InstanceConfig>) => rpc.request.writeConfig({ config }),
  list: (): Promise<InstanceConfig[]> => rpc.request.list(),
  pickPath: (): Promise<{ path: string } | { cancelled: true }> => rpc.request.pickPath(),
  start: (config: Partial<InstanceConfig>) => rpc.request["node.start"]({ config }),
  stop: (id: string) => rpc.request["node.stop"]({ id }),
  status: (id: string): Promise<StatusResult | null> => rpc.request["node.status"]({ id }),
  health: (id: string): Promise<HealthResult> => rpc.request["node.health"]({ id }),
  logs: (id: string, maxLines = 120): Promise<LogsResult> => rpc.request["node.logs"]({ id, maxLines }),
  bootstrapStart: (id: string) => rpc.request["bootstrap.start"]({ id }),
  bootstrapStop: () => rpc.request["bootstrap.stop"](),
  bootstrapStatus: (id: string): Promise<BootstrapStatus> => rpc.request["bootstrap.status"]({ id }),
  bootstrapLogs: (id: string, maxLines = 120) => rpc.request["bootstrap.logs"]({ id, maxLines }),
  bootstrapSkip: (id: string) => rpc.request["bootstrap.skip"]({ id }),
  openExternal: (url: string) => rpc.request.openExternal({ url }),
  wipeDb: (id: string) => rpc.request["wipe.db"]({ id }),
  wipeSnapshots: (id: string) => rpc.request["wipe.snapshots"]({ id }),
};
