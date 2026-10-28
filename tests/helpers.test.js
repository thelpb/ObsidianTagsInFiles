'use strict';

// Tests the pure helpers in main.js against a stub of the obsidian module.
// Run with Node 18+: node --test tests/helpers.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

class TFile {
	constructor(path, frontmatter) {
		this.path = path;
		this.frontmatter = frontmatter;
	}
}
class TFolder {
	constructor(path) {
		this.path = path;
	}
}

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === 'obsidian') {
		class Plugin {}
		class PluginSettingTab {}
		return { Notice: class {}, Plugin, PluginSettingTab, Setting: class {}, TFile, TFolder, debounce: (fn) => fn };
	}
	return originalLoad.call(this, request, ...rest);
};
const plugin = require('../main.js');
Module._load = originalLoad;

const {
	DEFAULT_SETTINGS, normalizeKey, parsePropertyNames, getProperty, toDisplayValues, resolveColor, truncate, bubblesFor,
	isRelevantMutation, sortPropertyName, normalizeFolderPath, isFolderSorted, compareSortValues,
} = plugin._internals;

// A plugin instance with just enough of the app for sorting.
function makePlugin(overrides) {
	const instance = Object.create(plugin.prototype);
	instance.settings = { ...DEFAULT_SETTINGS, sortMode: 'all', ...overrides };
	instance.app = { metadataCache: { getFileCache: (file) => ({ frontmatter: file.frontmatter }) } };
	instance.patchedViews = new Set();
	instance.sortValues = new Map();
	return instance;
}

// Items as the explorer returns them: folders first, then files in Obsidian's order.
function folderItems() {
	return [
		{ file: new TFolder('Tickets/Archive') },
		{ file: new TFile('Tickets/a.md', { status: 'Done' }) },
		{ file: new TFile('Tickets/b.md', {}) },
		{ file: new TFile('Tickets/c.md', { status: 'Backlog' }) },
		{ file: new TFile('Tickets/d.md', { status: 'Someday' }) },
		{ file: new TFile('Tickets/e.md', { Status: 'in progress' }) },
		{ file: new TFile('Tickets/f.md', { status: 'Backlog' }) },
	];
}
const names = (items) => items.map((item) => item.file.path.split('/').pop());

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

test('sortPropertyName falls back to the first shown property', () => {
	assert.equal(sortPropertyName({ sortProperty: ' priority ', properties: 'status' }), 'priority');
	assert.equal(sortPropertyName({ sortProperty: '', properties: 'stage, labels' }), 'stage');
	assert.equal(sortPropertyName({ sortProperty: '', properties: '' }), 'status');
});

test('normalizeFolderPath trims slashes and maps blank to the root', () => {
	assert.equal(normalizeFolderPath(' /Projects/Tickets/ '), 'Projects/Tickets');
	assert.equal(normalizeFolderPath('/'), '/');
	assert.equal(normalizeFolderPath(''), '/');
});

test('isFolderSorted covers off, every folder, and chosen folders with subfolders', () => {
	assert.equal(isFolderSorted('Tickets', { sortMode: 'off', sortFolders: ['Tickets'] }), false);
	assert.equal(isFolderSorted('Anything', { sortMode: 'all', sortFolders: [] }), true);
	const chosen = { sortMode: 'folders', sortFolders: ['Tickets'] };
	assert.equal(isFolderSorted('Tickets', chosen), true);
	assert.equal(isFolderSorted('Tickets/2026', chosen), true);
	assert.equal(isFolderSorted('TicketsOld', chosen), false);
	assert.equal(isFolderSorted('/', chosen), false);
	assert.equal(isFolderSorted('Notes', { sortMode: 'folders', sortFolders: ['/'] }), true);
});

test('compareSortValues orders by value list, then alphabetically, with missing values pinned', () => {
	const settings = { ...DEFAULT_SETTINGS, sortOrder: 'values' };
	const sorted = (values, s) => values.slice().sort((a, b) => compareSortValues(a, b, s));
	const values = ['Done', null, 'Zeta', 'backlog', 'Alpha', 'In Progress'];
	assert.deepEqual(sorted(values, settings), ['backlog', 'In Progress', 'Done', 'Alpha', 'Zeta', null]);
	assert.deepEqual(sorted(values, { ...settings, sortDescending: true }), ['Zeta', 'Alpha', 'Done', 'In Progress', 'backlog', null]);
	assert.deepEqual(sorted(values, { ...settings, missingLast: false }), [null, 'backlog', 'In Progress', 'Done', 'Alpha', 'Zeta']);
	assert.deepEqual(sorted(values, { ...settings, sortOrder: 'alphabetical' }), ['Alpha', 'backlog', 'Done', 'In Progress', 'Zeta', null]);
	assert.deepEqual(sorted(['Item 10', 'Item 9'], { ...settings, sortOrder: 'alphabetical' }), ['Item 9', 'Item 10'], 'numbers sort naturally');
});

test('sortFolderItems keeps folders first and ties in Obsidian order', () => {
	const instance = makePlugin();
	const result = instance.sortFolderItems(new TFolder('Tickets'), folderItems());
	assert.deepEqual(names(result), ['Archive', 'c.md', 'f.md', 'e.md', 'a.md', 'd.md', 'b.md']);
	assert.equal(instance.sortValues.get('Tickets/e.md'), 'in progress');
	assert.equal(instance.sortValues.get('Tickets/b.md'), null);
});

test('sortFolderItems leaves folders outside the scope alone', () => {
	const instance = makePlugin({ sortMode: 'folders', sortFolders: ['Projects'] });
	const items = folderItems();
	assert.equal(instance.sortFolderItems(new TFolder('Tickets'), items), items);
});

test('patchExplorer wraps the view\'s sort and unpatching restores it', () => {
	class FakeExplorerView {
		constructor() {
			this.sorts = 0;
		}
		getSortedFolderItems() {
			return folderItems();
		}
		requestSort() {
			this.sorts++;
		}
	}
	const instance = makePlugin();
	const view = new FakeExplorerView();
	assert.equal(instance.patchExplorer(view), true);
	assert.equal(instance.patchExplorer(view), false, 'patches only once');
	assert.deepEqual(names(view.getSortedFolderItems(new TFolder('Tickets'))), ['Archive', 'c.md', 'f.md', 'e.md', 'a.md', 'd.md', 'b.md']);

	instance.settings.sortMode = 'off';
	assert.deepEqual(names(view.getSortedFolderItems(new TFolder('Tickets'))), ['Archive', 'a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md']);

	instance.unpatchExplorer(view);
	assert.equal(Object.prototype.hasOwnProperty.call(view, 'getSortedFolderItems'), false);
	assert.equal(view.sorts, 1, 'unpatching re-sorts');
	assert.equal(instance.patchExplorer({}), false, 'skips views without the method');
});

test('resortIfMoved re-sorts only when the sort value changes', () => {
	const instance = makePlugin();
	let resorts = 0;
	instance.requestResort = () => resorts++;
	instance.patchedViews.add({});
	const file = new TFile('Tickets/a.md', { status: 'Done' });
	file.parent = new TFolder('Tickets');
	instance.sortValues.set(file.path, 'Done');
	instance.resortIfMoved(file);
	assert.equal(resorts, 0);
	file.frontmatter = { status: 'Backlog' };
	instance.resortIfMoved(file);
	assert.equal(resorts, 1);
	instance.resortIfMoved(new TFile('New.md', { status: 'Done' }));
	assert.equal(resorts, 2, 'a file not sorted yet re-sorts when its folder is sorted');
});
