export const ERA_COLORS: Record<string, string> = {
  Byron: '#9AA6B2',
  Shelley: '#00B3FF',
  Allegra: '#00B3FF',
  Mary: '#00B3FF',
  Alonzo: '#FF8A00',
  Babbage: '#9B59B6',
  Conway: '#00E676',
};

export const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'node', label: 'Node', icon: 'cpu' },
  { id: 'wallet', label: 'Wallet', icon: 'key' },
  { id: 'blocks', label: 'Blocks', icon: 'blocks' },
  { id: 'peers', label: 'Peers', icon: 'users' },
  { id: 'explorer', label: 'Explorer', icon: 'search' },
] as const;

export type NavItemId = (typeof NAV_ITEMS)[number]['id'];
