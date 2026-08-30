// tests/setup.ts — auto-serve is off in the suite by default (spec §9.1, S5).
//
// A write command now starts `diagram serve` when it leaves content on the
// page and no viewer is running (§9.1). The suite runs hundreds of patches
// across dozens of temp directories; without this, every one of them would
// try to bind a port in the 4400..4410 range, spawn a detached node process
// and raise a browser tab. That is the same damage S5 protects the eval rig
// from, one order of magnitude worse.
//
// Vitest loads this before every test file in this package, so the default is
// "off" and any test that wants the real behaviour has to say so out loud —
// tests/autoserve.test.ts deletes the variable per test and installs a
// launcher it can account for and kill. Making the dangerous case explicit is
// the point; a suite that silently spawned servers would pass either way.

process.env['DIAGRAM_NO_AUTOSERVE'] = '1';
