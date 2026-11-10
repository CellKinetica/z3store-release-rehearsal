import { expect, test } from "bun:test";
import { reproducibilityDrift } from "../../scripts/verify-release.ts";

test("two passes with the same hash per target show no drift", () => {
	const pass = new Map([
		["x86_64-linux-musl", "4f00"],
		["aarch64-macos", "c859"],
	]);
	expect(reproducibilityDrift(pass, new Map(pass))).toEqual([]);
});

test("a target whose hash changed between passes is drift", () => {
	const drift = reproducibilityDrift(
		new Map([
			["x86_64-linux-musl", "1b39"],
			["aarch64-macos", "c859"],
		]),
		new Map([
			["x86_64-linux-musl", "e0dc"],
			["aarch64-macos", "c859"],
		]),
	);
	expect(drift).toEqual(["x86_64-linux-musl: first 1b39, second e0dc"]);
});

test("a target built in only one pass is drift", () => {
	const drift = reproducibilityDrift(
		new Map([["x86_64-macos", "b01c"]]),
		new Map(),
	);
	expect(drift).toEqual(["x86_64-macos: first b01c, second (not built)"]);
});

test("two passes that built nothing prove nothing", () => {
	expect(reproducibilityDrift(new Map(), new Map())).toEqual([
		"no release target was built",
	]);
});
