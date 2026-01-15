import { stdout } from 'process';
import { toHex } from '@harmoniclabs/uint8array-utils';

let startTime: number | null = null;
let isFirstRender = true;
let lastSlot = 0n;
let lastTime = 0;

const DASHBOARD_HEIGHT = 22;
const INNER_WIDTH = 80;
const PROGRESS_WIDTH = 48;

const colors = {
hlRed: '\x1b[91m',              // Bright ANSI red – main accent
hlRedDeep: '\x1b[38;5;160m',    // Deeper crimson for headers
hlRedBright: '\x1b[38;5;196m',  // Intense for alerts/purge
gray: '\x1b[90m',               // Dim background for progress
lightGray: '\x1b[37m',
white: '\x1b[97m',
dim: '\x1b[2m',
reset: '\x1b[0m',
bold: '\x1b[1m',
};

const glow = colors.bold;

function visibleLength(str: string): number {
return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function center(text: string, width = INNER_WIDTH): string {
const visLen = visibleLength(text);
if (visLen > width) return text.slice(0, width - 3) + '...';
const padTotal = width - visLen;
const left = Math.floor(padTotal / 2);
return `${colors.hlRed}│${colors.reset}${' '.repeat(left)}${text}${' '.repeat(padTotal - left)}${colors.hlRed}│${colors.reset}`;
}

function formatNum(n: number): string {
return n.toLocaleString('en-US');
}

const LAB_HEADER = [
`${colors.hlRed}${glow}  ╔══════════════════════════════════════════════╗  ${colors.reset}`,
`${colors.hlRed}  ║      HARMONIC LABS – GEROLAMO NODE           ║  ${colors.reset}`,
`${colors.hlRed}  ╚══════════════════════════════════════════════╝  ${colors.reset}`,
];

export function prettyBlockValidationLog(
	era: number,
	blockEpoch: number,
	blockHeaderHash: Uint8Array,
	blockSlot: bigint | number,
	tip: bigint | number,
	volatileDbGcCounter: number,
	batchInsertCounter?: number,
): void 
{
	if (startTime === null) startTime = Date.now();

	const now = Date.now();
	const elapsedSec = Math.floor((now - startTime) / 1000);

	const days = Math.floor(elapsedSec / 86400);
	const h = Math.floor((elapsedSec % 86400) / 3600);
	const m = Math.floor((elapsedSec % 3600) / 60);
	const s = elapsedSec % 60;
	const runtime = days > 0
		? `${days}d ${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`
		: `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;

	const slotNum = Number(blockSlot);
	const tipNum = Number(tip);

	const progress = tipNum > 0 ? Math.max(0, Math.min(1, slotNum / tipNum)) : 0;
	const percent = (progress * 100).toFixed(2);

	const hashShort = toHex(blockHeaderHash).slice(0, 10).toUpperCase() + '..';

	// Progress bar: red fill + gray background
	const filled = Math.round(progress * PROGRESS_WIDTH);
	const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_WIDTH - filled);

	// Speed
	let speed = '';
	if (lastTime > 0 && now - lastTime > 4000) {
		const delta = Math.abs(Number(blockSlot) - Number(lastSlot));
		const minDelta = (now - lastTime) / 60000;
		if (minDelta > 0) {
			const bpm = Math.round(delta / minDelta);
			speed = bpm > 0 ? ` ${bpm} b/min` : ' STALLED';
		}
	}
	lastSlot = BigInt(blockSlot);
	lastTime = now;

	const frameTop = `${colors.hlRed}╔${'═'.repeat(INNER_WIDTH)}╗${colors.reset}`;
	const frameBot = `${colors.hlRed}╚${'═'.repeat(INNER_WIDTH)}╝${colors.reset}`;

	const lines = [
		frameTop,
		...LAB_HEADER.map(line => center(line, INNER_WIDTH - 0)),
		center(''),
		center(`${colors.hlRedDeep}${glow}PREPROD`),
		center(`${colors.hlRedDeep}${glow}ERA ${era}${colors.reset}`),
		center(`${colors.lightGray}EPOCH ${blockEpoch.toString().padStart(3,'0')}   SLOT ${formatNum(slotNum).padStart(11)} / ${formatNum(tipNum).padStart(11)}${colors.reset}`),
		center(`${colors.hlRed}PROGRESS [${bar}] ${percent}%${speed}${colors.reset}`),
		center(`${colors.gray}HASH ${hashShort}${colors.reset}`),
		center(`${colors.white}GC CYCLES: ${volatileDbGcCounter.toString().padStart(5)}   BATCH: ${(batchInsertCounter ?? '---').toString().padStart(3)}${colors.reset}`),
		center(`${colors.dim}UPTIME ${runtime}   ${new Date(now).toLocaleString('en-US', { hour12: true })}${colors.reset}`),

		volatileDbGcCounter >= 2150
		? center(`${colors.hlRedBright}${glow}!!! VOLATILE → IMMUTABLE PURGE ACTIVE !!!${colors.reset}`)
		: center(''),

		(batchInsertCounter ?? 0) >= 40
		? center(`${colors.hlRed}${glow}»»» BATCH INSERT SEQUENCE ACTIVE «««${colors.reset}`)
		: center(''),

		center(''),
		center(`${colors.gray}${glow}... GEROLAMO – CARDANO SYNC STABLE ...${colors.reset}`),
		frameBot,
	];

	// Terminal control
	if (isFirstRender) {
		stdout.write('\x1b[2J\x1b[?25l');
		isFirstRender = false;
	} else {
		stdout.write(`\x1b[${process.stdout.rows - DASHBOARD_HEIGHT + 1};1H\x1b[0J`);
	}

		const clearLine = '\r\x1b[K';

		lines.forEach(line => stdout.write(clearLine + line + '\n'));

		stdout.write(`\x1b[${process.stdout.rows - DASHBOARD_HEIGHT};1H`);
}