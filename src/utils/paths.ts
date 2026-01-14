import path from 'path';
import { fileURLToPath } from 'node:url';

export const getBasePath = (): string => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, '..');  // src/utils/paths.ts → src/
};