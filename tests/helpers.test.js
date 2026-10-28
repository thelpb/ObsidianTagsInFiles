'use strict';

// Tests the pure helpers in main.js against a stub of the obsidian module.
// Run with Node 18+: node --test tests/helpers.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === 'obsidian') {
		class Plugin {}
		class PluginSettingTab {}
		return { Plugin, PluginSettingTab, Setting: class {}, TFile: class {}, debounce: (fn) => fn };
	}
	return originalLoad.call(this, request, ...rest);
};
const plugin = require('../main.js');
Module._load = originalLoad;

const { normalizeKey, parsePropertyNames, getProperty, toDisplayValues, resolveColor, truncate, bubblesFor, isRelevantMutation } = plugin._internals;

test('exports the plugin class as module and default export', () => {
	assert.equal(typeof plugin, 'function');
	assert.equal(plugin.default, plugin);
});

test('normalizeKey ignores case, spaces, dashes and underscores', () => {
	assert.equal(normalizeKey('In Progress'), 'inprogress');
	assert.equal(normalizeKey('in-progress'), 'inprogress');
	assert.equal(normalizeKey(' IN_PROGRESS '), 'inprogress');
	assert.equal(normalizeKey('Über Fertig'), 'überfertig');
});

test('parsePropertyNames splits on commas and drops blanks', () => {
	assert.deepEqual(parsePropertyNames(' status, priority ,,'), ['status', 'priority']);
	assert.deepEqual(parsePropertyNames(''), []);
	assert.deepEqual(parsePropertyNames(undefined), []);
});

test('getProperty prefers an exact key, then falls back to any case', () => {
	assert.equal(getProperty({ Status: 'Done' }, 'status'), 'Done');
	assert.equal(getProperty({ status: 'a', Status: 'b' }, 'Status'), 'b');
	assert.equal(getProperty({ other: 1 }, 'status'), undefined);
	assert.equal(getProperty(undefined, 'status'), undefined);
});

test('toDisplayValues handles scalars, lists and links', () => {
	assert.deepEqual(toDisplayValues('Done'), ['Done']);
	assert.deepEqual(toDisplayValues(3), ['3']);
	assert.deepEqual(toDisplayValues(false), ['false']);
	assert.deepEqual(toDisplayValues(['a', null, '', ' b ']), ['a', 'b']);
	assert.deepEqual(toDisplayValues('[[In Progress]]'), ['In Progress']);
	assert.deepEqual(toDisplayValues('[[people/ann|Ann]]'), ['Ann']);
	assert.deepEqual(toDisplayValues({ nested: true }), []);
	assert.deepEqual(toDisplayValues(null), []);
});

test('resolveColor uses rules, then the auto palette, then neutral', () => {
	const rules = [{ value: 'In Progress', color: '#f59e0b' }, { value: '', color: '#000000' }];
	assert.equal(resolveColor('in_progress', rules, true), '#f59e0b');
	const auto = resolveColor('Someday', rules, true);
	assert.match(auto, /^#[0-9a-f]{6}$/);
	assert.equal(resolveColor('someday', rules, true), auto, 'same value, same color');
	assert.equal(resolveColor('Someday', rules, false), 'var(--text-muted)');
});

test('truncate shortens with an ellipsis and 0 means no limit', () => {
	assert.equal(truncate('In Progress', 0), 'In Progress');
	assert.equal(truncate('In Progress', 20), 'In Progress');
	assert.equal(truncate('In Progress', 5), 'In P…');
	assert.equal(truncate('In Progress', 1), 'I…');
});

test('bubblesFor builds one bubble per value across properties', () => {
	const settings = { properties: 'status, labels', maxLength: 6, autoColor: false, rules: [{ value: 'Done', color: '#22c55e' }] };
	const bubbles = bubblesFor({ Status: 'Done', labels: ['frontend', 'bug'] }, settings);
	assert.deepEqual(bubbles.map((b) => [b.property, b.text, b.label, b.key, b.color]), [
		['status', 'Done', 'Done', 'done', '#22c55e'],
		['labels', 'frontend', 'front…', 'frontend', 'var(--text-muted)'],
		['labels', 'bug', 'bug', 'bug', 'var(--text-muted)'],
	]);
	assert.deepEqual(bubblesFor({}, settings), []);
});

test('isRelevantMutation ignores the plugin\'s own bubble insertions', () => {
	const el = (cls) => ({ nodeType: 1, classList: { contains: (c) => c === cls } });
	assert.equal(isRelevantMutation({ type: 'childList', addedNodes: [el('ptb-bubbles')] }), false);
	assert.equal(isRelevantMutation({ type: 'childList', addedNodes: [] }), false);
	assert.equal(isRelevantMutation({ type: 'childList', addedNodes: [{ nodeType: 3 }] }), false);
	assert.equal(isRelevantMutation({ type: 'childList', addedNodes: [el('tree-item')] }), true);
	assert.equal(isRelevantMutation({ type: 'attributes', addedNodes: [] }), true);
});
