/**
 * (COMPANION-PAIRING-UI) — a self-contained QR Code encoder (ISO/IEC 18004).
 *
 * WHY THIS EXISTS RATHER THAN A DEPENDENCY
 * ----------------------------------------
 * The pairing QR is the ONLY transport for the 256-bit pairing code (§4.3), so
 * the desktop must be able to draw one. The repo has no QR library, and adding
 * one would change `package.json` + `bun.lock` — which the nightly's
 * dependency-consistency gate `(LOCK-REGEN)` reads, and which every ARM64 build
 * must then resolve. A ~300-line encoder with no I/O and no dependencies is the
 * cheaper half of that trade, so it lives here.
 *
 * SCOPE, deliberately narrow:
 *  - BYTE mode only. The payload is a percent-encoded URI, so alphanumeric mode
 *    would not apply and numeric mode certainly would not.
 *  - Error-correction level M (~15% recovery). Fixed, not a parameter: L is
 *    fragile against a camera at an angle and H inflates the symbol until the
 *    modules are too small to resolve on a dialog-sized canvas.
 *  - Versions 1-40, smallest that fits. The pairing URI is ~150 bytes, which
 *    lands around version 9; the full range costs two table rows.
 *
 * This module NEVER logs, stores, or transforms its input — it receives bytes
 * and returns a bitmap. The caller's secret does not outlive the call.
 */

/** A QR symbol. `modules` is row-major `size * size`; `true` is a dark module. */
export interface QrMatrix {
	/** Modules per side, EXCLUDING the quiet zone (the caller adds that). */
	readonly size: number;
	readonly modules: readonly boolean[];
}

const MIN_VERSION = 1;
const MAX_VERSION = 40;

/** Error-correction level M, as the two bits the format information carries. */
const FORMAT_ECC_BITS = 0b00;

/** ECC codewords per block, indexed by version (index 0 unused). Level M. */
const ECC_CODEWORDS_PER_BLOCK = [
	-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26,
	26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
	28, 28, 28,
];

/** Number of ECC blocks, indexed by version (index 0 unused). Level M. */
const NUM_ECC_BLOCKS = [
	-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17,
	18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/**
 * Encodes `data` and returns the finished symbol.
 *
 * Throws when the payload cannot fit in a version-40 symbol — a caller that
 * built a URI too long to transmit has a bug, and a truncated QR would present
 * to the user as a phone that scans and then fails for no stated reason.
 */
export function encodeQrMatrix(data: Uint8Array): QrMatrix {
	const version = selectVersion(data.length);
	const codewords = addEccAndInterleave(
		buildDataCodewords(data, version),
		version,
	);

	const grid = createGrid(version);
	drawFunctionPatterns(grid, version);
	drawCodewords(grid, codewords);

	const mask = chooseMask(grid);
	applyMask(grid, mask);
	drawFormatBits(grid, mask);

	return { size: grid.size, modules: grid.modules };
}

// ---------------------------------------------------------------------------
// capacity
// ---------------------------------------------------------------------------

/** Bits the byte-mode character count occupies at this version. */
function charCountBits(version: number): number {
	return version <= 9 ? 8 : 16;
}

/** Total modules available to data + ECC, i.e. everything but function patterns. */
function getNumRawDataModules(version: number): number {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const numAlign = Math.floor(version / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (version >= 7) {
			result -= 36;
		}
	}
	return result;
}

function getNumDataCodewords(version: number): number {
	return (
		Math.floor(getNumRawDataModules(version) / 8) -
		ECC_CODEWORDS_PER_BLOCK[version] * NUM_ECC_BLOCKS[version]
	);
}

function selectVersion(byteLength: number): number {
	for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
		const capacityBits = getNumDataCodewords(version) * 8;
		const usedBits = 4 + charCountBits(version) + byteLength * 8;
		if (usedBits <= capacityBits) {
			return version;
		}
	}
	throw new Error(
		`(COMPANION-PAIRING-UI) ${byteLength} bytes exceed the largest QR symbol`,
	);
}

// ---------------------------------------------------------------------------
// data codewords
// ---------------------------------------------------------------------------

function buildDataCodewords(data: Uint8Array, version: number): number[] {
	const bits: number[] = [];
	const appendBits = (value: number, length: number): void => {
		for (let i = length - 1; i >= 0; i--) {
			bits.push((value >>> i) & 1);
		}
	};

	appendBits(0b0100, 4); // byte mode
	appendBits(data.length, charCountBits(version));
	for (const byte of data) {
		appendBits(byte, 8);
	}

	const capacityBits = getNumDataCodewords(version) * 8;
	appendBits(0, Math.min(4, capacityBits - bits.length)); // terminator
	appendBits(0, (8 - (bits.length % 8)) % 8); // to a byte boundary

	const codewords: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) {
			byte = (byte << 1) | bits[i + j];
		}
		codewords.push(byte);
	}
	// The spec's alternating pad bytes, until the version's data capacity is full.
	for (
		let pad = 0xec;
		codewords.length * 8 < capacityBits;
		pad ^= 0xec ^ 0x11
	) {
		codewords.push(pad);
	}
	return codewords;
}

// ---------------------------------------------------------------------------
// Reed-Solomon over GF(2^8), primitive polynomial 0x11D
// ---------------------------------------------------------------------------

function gfMultiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

/** Coefficients of the generator polynomial, highest power first. */
function reedSolomonDivisor(degree: number): number[] {
	const result = new Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < degree; j++) {
			result[j] = gfMultiply(result[j], root);
			if (j + 1 < degree) {
				result[j] ^= result[j + 1];
			}
		}
		root = gfMultiply(root, 0x02);
	}
	return result;
}

function reedSolomonRemainder(
	data: readonly number[],
	divisor: readonly number[],
): number[] {
	const result = new Array<number>(divisor.length).fill(0);
	for (const byte of data) {
		const factor = byte ^ (result.shift() as number);
		result.push(0);
		for (let i = 0; i < divisor.length; i++) {
			result[i] ^= gfMultiply(divisor[i], factor);
		}
	}
	return result;
}

/**
 * Splits the data into the version's blocks, appends each block's ECC, and
 * interleaves them in the order the symbol is filled.
 *
 * Every block is held at `shortBlockLen + 1` entries with the ECC at the END,
 * so short blocks carry one unused slot in the middle. The interleave loop
 * skips exactly that slot — which is why it can walk all blocks in lockstep.
 */
function addEccAndInterleave(
	data: readonly number[],
	version: number,
): number[] {
	const numBlocks = NUM_ECC_BLOCKS[version];
	const eccLen = ECC_CODEWORDS_PER_BLOCK[version];
	const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
	const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
	const shortBlockLen = Math.floor(rawCodewords / numBlocks);
	const divisor = reedSolomonDivisor(eccLen);

	const blocks: number[][] = [];
	for (let i = 0, offset = 0; i < numBlocks; i++) {
		const dataLen = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
		const chunk = data.slice(offset, offset + dataLen);
		offset += dataLen;

		const block = new Array<number>(shortBlockLen + 1).fill(0);
		for (let j = 0; j < chunk.length; j++) {
			block[j] = chunk[j];
		}
		const ecc = reedSolomonRemainder(chunk, divisor);
		for (let j = 0; j < eccLen; j++) {
			block[shortBlockLen + 1 - eccLen + j] = ecc[j];
		}
		blocks.push(block);
	}

	const result: number[] = [];
	for (let i = 0; i < shortBlockLen + 1; i++) {
		for (let j = 0; j < numBlocks; j++) {
			if (i !== shortBlockLen - eccLen || j >= numShortBlocks) {
				result.push(blocks[j][i]);
			}
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// the module grid
// ---------------------------------------------------------------------------

interface Grid {
	size: number;
	modules: boolean[];
	/** Function modules are immune to masking and to the data walk. */
	isFunction: boolean[];
}

function createGrid(version: number): Grid {
	const size = version * 4 + 17;
	return {
		size,
		modules: new Array<boolean>(size * size).fill(false),
		isFunction: new Array<boolean>(size * size).fill(false),
	};
}

function setFunctionModule(
	grid: Grid,
	x: number,
	y: number,
	dark: boolean,
): void {
	const index = y * grid.size + x;
	grid.modules[index] = dark;
	grid.isFunction[index] = true;
}

function getBit(value: number, index: number): boolean {
	return ((value >>> index) & 1) !== 0;
}

function drawFunctionPatterns(grid: Grid, version: number): void {
	const { size } = grid;

	for (let i = 0; i < size; i++) {
		setFunctionModule(grid, 6, i, i % 2 === 0);
		setFunctionModule(grid, i, 6, i % 2 === 0);
	}

	drawFinderPattern(grid, 3, 3);
	drawFinderPattern(grid, size - 4, 3);
	drawFinderPattern(grid, 3, size - 4);

	const positions = alignmentPatternPositions(version, size);
	const last = positions.length - 1;
	for (let i = 0; i <= last; i++) {
		for (let j = 0; j <= last; j++) {
			// The three corners are occupied by finder patterns.
			const isCorner =
				(i === 0 && j === 0) ||
				(i === 0 && j === last) ||
				(i === last && j === 0);
			if (!isCorner) {
				drawAlignmentPattern(grid, positions[i], positions[j]);
			}
		}
	}

	// Reserves the format area; the real bits are written once a mask is chosen.
	drawFormatBits(grid, 0);
	drawVersionBits(grid, version);
}

/** The 7x7 finder plus its separator ring, centred on (cx, cy). */
function drawFinderPattern(grid: Grid, cx: number, cy: number): void {
	for (let dy = -4; dy <= 4; dy++) {
		for (let dx = -4; dx <= 4; dx++) {
			const x = cx + dx;
			const y = cy + dy;
			if (x < 0 || x >= grid.size || y < 0 || y >= grid.size) {
				continue;
			}
			const distance = Math.max(Math.abs(dx), Math.abs(dy));
			setFunctionModule(grid, x, y, distance !== 2 && distance !== 4);
		}
	}
}

function drawAlignmentPattern(grid: Grid, cx: number, cy: number): void {
	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -2; dx <= 2; dx++) {
			setFunctionModule(
				grid,
				cx + dx,
				cy + dy,
				Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
			);
		}
	}
}

function alignmentPatternPositions(version: number, size: number): number[] {
	if (version === 1) {
		return [];
	}
	const count = Math.floor(version / 7) + 2;
	const step =
		version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
	const positions = [6];
	for (let pos = size - 7; positions.length < count; pos -= step) {
		positions.splice(1, 0, pos);
	}
	return positions;
}

/** The 15-bit format information (ECC level + mask), written twice. */
function drawFormatBits(grid: Grid, mask: number): void {
	const { size } = grid;
	const data = (FORMAT_ECC_BITS << 3) | mask;
	let remainder = data;
	for (let i = 0; i < 10; i++) {
		remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
	}
	const bits = ((data << 10) | remainder) ^ 0x5412;

	for (let i = 0; i <= 5; i++) {
		setFunctionModule(grid, 8, i, getBit(bits, i));
	}
	setFunctionModule(grid, 8, 7, getBit(bits, 6));
	setFunctionModule(grid, 8, 8, getBit(bits, 7));
	setFunctionModule(grid, 7, 8, getBit(bits, 8));
	for (let i = 9; i < 15; i++) {
		setFunctionModule(grid, 14 - i, 8, getBit(bits, i));
	}

	for (let i = 0; i < 8; i++) {
		setFunctionModule(grid, size - 1 - i, 8, getBit(bits, i));
	}
	for (let i = 8; i < 15; i++) {
		setFunctionModule(grid, 8, size - 15 + i, getBit(bits, i));
	}
	setFunctionModule(grid, 8, size - 8, true); // always dark
}

/** The 18-bit version information, present from version 7 upwards. */
function drawVersionBits(grid: Grid, version: number): void {
	if (version < 7) {
		return;
	}
	let remainder = version;
	for (let i = 0; i < 12; i++) {
		remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
	}
	const bits = (version << 12) | remainder;

	for (let i = 0; i < 18; i++) {
		const dark = getBit(bits, i);
		const a = grid.size - 11 + (i % 3);
		const b = Math.floor(i / 3);
		setFunctionModule(grid, a, b, dark);
		setFunctionModule(grid, b, a, dark);
	}
}

/** The zigzag walk: two-module columns, right to left, alternating direction. */
function drawCodewords(grid: Grid, codewords: readonly number[]): void {
	const { size } = grid;
	let bitIndex = 0;
	const totalBits = codewords.length * 8;

	for (let right = size - 1; right >= 1; right -= 2) {
		// Column 6 is the vertical timing pattern; the walk skips over it.
		if (right === 6) {
			right = 5;
		}
		for (let vertical = 0; vertical < size; vertical++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - vertical : vertical;
				const index = y * size + x;
				if (!grid.isFunction[index] && bitIndex < totalBits) {
					grid.modules[index] = getBit(
						codewords[bitIndex >>> 3],
						7 - (bitIndex & 7),
					);
					bitIndex++;
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// masking
// ---------------------------------------------------------------------------

function maskCondition(mask: number, x: number, y: number): boolean {
	switch (mask) {
		case 0:
			return (x + y) % 2 === 0;
		case 1:
			return y % 2 === 0;
		case 2:
			return x % 3 === 0;
		case 3:
			return (x + y) % 3 === 0;
		case 4:
			return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
		case 5:
			return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6:
			return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		case 7:
			return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
		default:
			throw new Error(`(COMPANION-PAIRING-UI) invalid QR mask ${mask}`);
	}
}

/** XOR — applying the same mask twice restores the grid. */
function applyMask(grid: Grid, mask: number): void {
	for (let y = 0; y < grid.size; y++) {
		for (let x = 0; x < grid.size; x++) {
			const index = y * grid.size + x;
			if (!grid.isFunction[index] && maskCondition(mask, x, y)) {
				grid.modules[index] = !grid.modules[index];
			}
		}
	}
}

/** The spec's mask selection: try all eight, keep the least penalised. */
function chooseMask(grid: Grid): number {
	let bestMask = 0;
	let bestPenalty = Number.POSITIVE_INFINITY;
	for (let mask = 0; mask < 8; mask++) {
		applyMask(grid, mask);
		drawFormatBits(grid, mask);
		const penalty = penaltyScore(grid);
		if (penalty < bestPenalty) {
			bestPenalty = penalty;
			bestMask = mask;
		}
		applyMask(grid, mask); // undo
	}
	return bestMask;
}

function penaltyScore(grid: Grid): number {
	const { size, modules } = grid;
	let result = 0;

	// Rule 1 — runs of five or more same-coloured modules in a line.
	for (let y = 0; y < size; y++) {
		result += lineRunPenalty((i) => modules[y * size + i], size);
	}
	for (let x = 0; x < size; x++) {
		result += lineRunPenalty((i) => modules[i * size + x], size);
	}

	// Rule 2 — 2x2 blocks of one colour.
	for (let y = 0; y < size - 1; y++) {
		for (let x = 0; x < size - 1; x++) {
			const colour = modules[y * size + x];
			if (
				colour === modules[y * size + x + 1] &&
				colour === modules[(y + 1) * size + x] &&
				colour === modules[(y + 1) * size + x + 1]
			) {
				result += PENALTY_N2;
			}
		}
	}

	// Rule 3 — finder-like 1:1:3:1:1 patterns with a four-module light run.
	for (let y = 0; y < size; y++) {
		result += finderLikePenalty((i) => modules[y * size + i], size);
	}
	for (let x = 0; x < size; x++) {
		result += finderLikePenalty((i) => modules[i * size + x], size);
	}

	// Rule 4 — deviation from an even split of dark and light.
	let dark = 0;
	for (const module of modules) {
		if (module) {
			dark++;
		}
	}
	const total = size * size;
	const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
	result += k * PENALTY_N4;

	return result;
}

function lineRunPenalty(at: (index: number) => boolean, size: number): number {
	let result = 0;
	let runColour = at(0);
	let runLength = 1;
	for (let i = 1; i < size; i++) {
		const colour = at(i);
		if (colour === runColour) {
			runLength++;
			if (runLength === 5) {
				result += PENALTY_N1;
			} else if (runLength > 5) {
				result += 1;
			}
		} else {
			runColour = colour;
			runLength = 1;
		}
	}
	return result;
}

/** `1011101 0000` and its mirror — the sequences a decoder mistakes for a finder. */
const FINDER_LIKE = [
	[true, false, true, true, true, false, true, false, false, false, false],
	[false, false, false, false, true, false, true, true, true, false, true],
];

function finderLikePenalty(
	at: (index: number) => boolean,
	size: number,
): number {
	let result = 0;
	for (let start = 0; start + 11 <= size; start++) {
		for (const pattern of FINDER_LIKE) {
			let matches = true;
			for (let i = 0; i < 11; i++) {
				if (at(start + i) !== pattern[i]) {
					matches = false;
					break;
				}
			}
			if (matches) {
				result += PENALTY_N3;
			}
		}
	}
	return result;
}
