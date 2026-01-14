import { stdout } from 'process';
import { toHex } from '@harmoniclabs/uint8array-utils';

let logLines = 0;
let startTime: number | null = null;
let isFirstRender = true;
const DASHBOARD_HEIGHT = 20; // Fixed based on your outputLines count

function visibleLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function prettyBlockValidationLog(
  era: number,
  blockEpoch: number,
  blockHeaderHash: Uint8Array,
  blockSlot: bigint | number,
  tip: bigint | number,
  volatileDbGcCounter: number,
  batchInsertCounter?: number,
): void {
  if (startTime === null) {
    startTime = Date.now();
  }
  const now = Date.now();
  const elapsedMs = now - startTime;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  const runningTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')} `;

  const currentDateTime = new Date(now).toLocaleString();

  const slotNum = Number(blockSlot);
  const tipNum = Number(tip);
  const percent = ((slotNum / tipNum) * 100).toFixed(2);
  const hashHex = toHex ? toHex(blockHeaderHash) : blockHeaderHash.toString();
  const shortHash = hashHex.slice(0, 16) + '...';

  const progressWidth = 50;
  const filled = Math.floor((slotNum / tipNum) * progressWidth);
  const progressBar = '█'.repeat(filled) + '░'.repeat(progressWidth - filled);

  const green = '\x1b[32m';
  const yellow = '\x1b[33m';
  const red = '\x1b[31m';
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const clearLine = '\r\x1b[K';

  const asciiHeader = [
    `${red}Harmonic Labs${reset}`,
    `${red}•Gerolamo•${reset}`
  ];

  const innerWidth = 70;
  const titleText = `${green}${bold}(Era: ${era})${reset}`;
  const details = `Epoch: ${blockEpoch.toString().padStart(4)} | Slot: ${slotNum.toLocaleString().padStart(8)} / ${tipNum.toLocaleString()} (${percent}%)`;
  const dbDetails = `${green}Volatile DB GC Counter: ${volatileDbGcCounter.toString().padStart(4)}${batchInsertCounter !== undefined ? ` | Batch Insert Counter: ${batchInsertCounter.toString().padStart(4)}` : ''}${reset}`;
  const timeDetails = `Running Time: ${runningTime} | Current Time: ${currentDateTime}`;
  const gcVolatileMsg = `${green}${bold}Running Volatile→Immutable...${reset}`;
  const batchInsertMsg = `${green}${bold}Running Batch Insert Volatile DB...${reset}`;
  const hashLine = `Header Hash: ${shortHash}`;
  const progressLine = `Progress: [${progressBar}] ${percent}%`;
  const footer = `${yellow}Gerolamo Syncing ${reset}`;

  const frameTop = '╔' + '═'.repeat(innerWidth) + '╗';
  const frameMid = '║' + ' '.repeat(innerWidth) + '║';
  const frameBot = '╚' + '═'.repeat(innerWidth) + '╝';

  const center = (text: string) => {
    const visLen = visibleLength(text);
    const leftPad = Math.floor((innerWidth - visLen) / 2);
    const rightPad = innerWidth - visLen - leftPad;
    return '║' + ' '.repeat(leftPad) + text + ' '.repeat(rightPad) + '║';
  };

  const outputLines = [
    frameTop,
    ...asciiHeader.map(center),
    frameMid,
    center(titleText),
    frameMid,
    center(details),
    center(dbDetails),
    center(timeDetails),
    Number(volatileDbGcCounter) < 2100 ? center('') : center(gcVolatileMsg),
    Number(batchInsertCounter) < 40 ? center('') : center(batchInsertMsg),
    center(hashLine),
    center(progressLine),
    center(footer),
    frameBot
  ];

  if (isFirstRender) {
    const termHeight = process.stdout.rows || 12; // Default if undetectable
    const scrollTop = 1;
    const scrollBottom = termHeight - DASHBOARD_HEIGHT;
    stdout.write(`\x1b[2J`); // Clear entire screen initially
    stdout.write(`\x1b[${scrollTop};${scrollBottom}r`); // Set scroll region for logs
    stdout.write(`\x1b[${scrollBottom + 1};1H`); // Move to start of TUI area
    isFirstRender = false;
  } else {
    stdout.write(`\x1b[${process.stdout.rows - DASHBOARD_HEIGHT + 1};1H`); // Move to TUI start
    stdout.write(`\x1b[0J`); // Clear from cursor to end (clears old TUI)
  }

  outputLines.forEach((line) => {
    stdout.write(clearLine + line + '\n');
  });

  // Reset cursor to top of scroll region for any subsequent logs
  stdout.write(`\x1b[${process.stdout.rows - DASHBOARD_HEIGHT};1H\x1b[1;1H`);
}