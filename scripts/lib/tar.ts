/**
 * Deterministic ustar writer and gzip wrapper for release archives.
 *
 * Why a TypeScript writer: macOS ships bsdtar without GNU tar's
 * `--sort`/`--mtime`/`--owner` normalisation flags, so the same tree
 * packed on a macOS laptop and on Linux CI would differ. Writing the bytes
 * here makes both hosts produce identical archives from identical inputs.
 *
 * Format: POSIX ustar (`magic "ustar\0"`, `version "00"`), regular files
 * only, uid/gid 0, empty uname/gname, one caller-supplied mtime. Pax
 * extended headers are never emitted; names that do not fit ustar are
 * rejected instead. The archive ends with two zero blocks and is padded to
 * a 10240-byte record, matching the POSIX default blocking factor.
 *
 * Dependency-free: Bun built-ins only.
 */

export type TarEntry = {
	/** Relative path stored in the archive; forward slashes, no `..`. */
	readonly name: string;
	readonly data: Uint8Array;
	/** Permission bits, e.g. 0o644 or 0o755. */
	readonly mode: number;
};

const BLOCK = 512;
const RECORD = 10240;
const NAME_LEN = 100;
const PREFIX_LEN = 155;
const MAX_SIZE = 0o77777777777; // 11 octal digits

const enc = new TextEncoder();

function compareBytes(a: string, b: string): number {
	const x = enc.encode(a);
	const y = enc.encode(b);
	const n = Math.min(x.length, y.length);
	for (let i = 0; i < n; i++) {
		const d = (x[i] as number) - (y[i] as number);
		if (d !== 0) return d;
	}
	return x.length - y.length;
}

/** Byte-wise (not locale) ordering, the order archive members are stored in. */
export function sortByteWise(names: readonly string[]): string[] {
	return [...names].sort(compareBytes);
}

function assertName(name: string): void {
	if (name.length === 0) throw new Error("tar: empty member name");
	if (!/^[\x21-\x7e]+$/.test(name)) {
		throw new Error(`tar: member name must be printable ASCII: ${name}`);
	}
	if (name.startsWith("/") || name.endsWith("/")) {
		throw new Error(`tar: member name must be a relative file path: ${name}`);
	}
	if (name.split("/").some((p) => p === "" || p === "." || p === "..")) {
		throw new Error(`tar: member name has an empty, . or .. segment: ${name}`);
	}
}

/** Splits a path into ustar `prefix` and `name`, or throws when it cannot fit. */
function splitName(name: string): { prefix: string; base: string } {
	if (name.length <= NAME_LEN) return { prefix: "", base: name };
	for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) {
		const prefix = name.slice(0, i);
		const base = name.slice(i + 1);
		if (prefix.length <= PREFIX_LEN && base.length <= NAME_LEN) {
			return { prefix, base };
		}
	}
	throw new Error(`tar: member name too long for ustar (no pax): ${name}`);
}

function putString(h: Uint8Array, off: number, len: number, s: string): void {
	const b = enc.encode(s);
	if (b.length > len) throw new Error(`tar: field overflow: ${s}`);
	h.set(b, off);
}

/** NUL-terminated zero-padded octal, `len - 1` digits. */
function putOctal(h: Uint8Array, off: number, len: number, v: number): void {
	putString(h, off, len, `${v.toString(8).padStart(len - 1, "0")}\0`);
}

function header(entry: TarEntry, mtime: number): Uint8Array {
	const { prefix, base } = splitName(entry.name);
	const h = new Uint8Array(BLOCK);
	putString(h, 0, 100, base);
	putOctal(h, 100, 8, entry.mode);
	putOctal(h, 108, 8, 0); // uid
	putOctal(h, 116, 8, 0); // gid
	putOctal(h, 124, 12, entry.data.byteLength);
	putOctal(h, 136, 12, mtime);
	h.fill(0x20, 148, 156); // checksum computed over spaces
	h[156] = 0x30; // typeflag '0' regular file
	putString(h, 257, 6, "ustar\0");
	putString(h, 263, 2, "00");
	// uname (265) and gname (297) stay empty.
	putOctal(h, 329, 8, 0); // devmajor
	putOctal(h, 337, 8, 0); // devminor
	putString(h, 345, 155, prefix);
	let sum = 0;
	for (const b of h) sum += b;
	putString(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
	return h;
}

/**
 * Builds an uncompressed ustar archive. Entries are stored in byte-wise
 * name order regardless of input order; duplicate names are rejected.
 */
export function writeTar(
	entries: readonly TarEntry[],
	mtime: number,
): Uint8Array {
	if (!Number.isInteger(mtime) || mtime < 0 || mtime > MAX_SIZE) {
		throw new Error(`tar: mtime out of range: ${mtime}`);
	}
	const sorted = [...entries].sort((a, b) => compareBytes(a.name, b.name));
	const chunks: Uint8Array[] = [];
	let total = 0;
	let prev: string | null = null;
	for (const e of sorted) {
		assertName(e.name);
		if (e.name === prev) throw new Error(`tar: duplicate member ${e.name}`);
		prev = e.name;
		if (!Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o7777) {
			throw new Error(`tar: bad mode for ${e.name}`);
		}
		if (e.data.byteLength > MAX_SIZE) {
			throw new Error(`tar: ${e.name} too large for ustar`);
		}
		chunks.push(header(e, mtime), e.data);
		total += BLOCK + e.data.byteLength;
		const pad = (BLOCK - (e.data.byteLength % BLOCK)) % BLOCK;
		if (pad > 0) {
			chunks.push(new Uint8Array(pad));
			total += pad;
		}
	}
	total += 2 * BLOCK; // end-of-archive marker
	const size = Math.ceil(total / RECORD) * RECORD;
	const out = new Uint8Array(size);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.byteLength;
	}
	return out;
}

/**
 * Gzips with Bun's zlib at level 9, then pins the header fields that would
 * otherwise vary by host: MTIME (bytes 4..7) is zeroed and OS (byte 9) is
 * forced to 3 (Unix).
 */
export function gzipDeterministic(data: Uint8Array): Uint8Array {
	const gz = new Uint8Array(Bun.gzipSync(data, { level: 9 }));
	if (gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 8) {
		throw new Error("gzip: unexpected stream header");
	}
	if (gz[3] !== 0) {
		throw new Error(`gzip: unexpected header flags ${gz[3]}`);
	}
	gz.fill(0, 4, 8);
	gz[9] = 3;
	return gz;
}
