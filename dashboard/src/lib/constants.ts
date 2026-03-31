export const ERA_COLORS: Record<string, string> = {
  Byron: '#9AA6B2',
  Shelley: '#00B3FF',
  Allegra: '#00B3FF',
  Mary: '#00B3FF',
  Alonzo: '#FF8A00',
  Babbage: '#9B59B6',
  Conway: '#00E676',
};

export const BLOCK_STATUS_COLORS: Record<string, string> = {
  finalized: '#00E676',
  volatile: '#FF8A00',
  'rolled-back': '#FF2D55',
};

export const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'blocks', label: 'Blocks', icon: 'cube' },
  { id: 'peers', label: 'Peers', icon: 'network' },
  { id: 'mempool', label: 'Mempool', icon: 'inbox' },
  { id: 'explorer', label: 'Explorer', icon: 'search' },
  { id: 'logs', label: 'Logs', icon: 'terminal' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
] as const;

export type NavItemId = (typeof NAV_ITEMS)[number]['id'];

export const API_ENDPOINTS = {
  status: '/api/status',
  peers: '/api/peers',
  blocks: '/api/blocks',
  logs: '/api/logs',
  utxo: '/api/utxo',
  deltas: '/api/deltas',
  chainState: '/api/chain-state',
  sseStatus: '/api/sse/status',
  sseBlocks: '/api/sse/blocks',
  sseLogs: '/api/sse/logs',
} as const;
