'use strict';

const { Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, debounce } = require('obsidian');

const DEFAULT_RULES = [
	{ value: 'Backlog', color: '#8a8f98' },
	{ value: 'To Do', color: '#3b82f6' },
	{ value: 'In Progress', color: '#f59e0b' },
	{ value: 'Review', color: '#a855f7' },
	{ value: 'Blocked', color: '#ef4444' },
	{ value: 'Done', color: '#22c55e' },
];

const DEFAULT_SETTINGS = {
	// Comma-separated frontmatter property names; each non-empty one becomes a bubble.
	properties: 'status',
	alignRight: true,
	// Longest bubble text before it is cut with an ellipsis; 0 means no limit.
	maxLength: 20,
	// Give values without a rule a stable color picked from the value itself.
	autoColor: true,
	// Also the sort order when sortOrder is 'values'.
	rules: DEFAULT_RULES,
	// 'off', 'all' (every folder) or 'folders' (only sortFolders and their subfolders).
	sortMode: 'off',
	// The mode the "Toggle sorting" command turns back on.
	lastSortMode: 'all',
	sortFolders: [],
	// Blank means the first of `properties`.
	sortProperty: '',
	// 'values' follows groupOrder (or `rules` when it's empty); 'alphabetical' ignores both.
	sortOrder: 'values',
	// Group values in display order, one per entry. Empty means the order of `rules`.
	groupOrder: [],
	sortDescending: false,
	missingLast: true,
	// How files in the same group are ordered: 'explorer' keeps Obsidian's order, otherwise one of
	// WITHIN_SORTS, with a '-desc' suffix for the reverse.
	withinSort: 'explorer',
	// The property withinSort 'property' sorts by.
	withinProperty: '',
};

const WITHIN_SORTS = {
	name: (file) => file.basename,
	modified: (file) => file.stat?.mtime ?? null,
	created: (file) => file.stat?.ctime ?? null,
	property: (file, frontmatter, settings) => firstValue(frontmatter, settings.withinProperty.trim()),
};

// Used by autoColor: the same value always lands on the same color.
const AUTO_PALETTE = ['#3b82f6', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444', '#22c55e', '#06b6d4'];
const NEUTRAL_COLOR = 'var(--text-muted)';

const TITLE_SELECTOR = '.nav-file-title[data-path]';
const BUBBLES_CLASS = 'ptb-bubbles';
const ALIGN_RIGHT_CLASS = 'property-bubbles-align-right';

// "In Progress", "in-progress" and "in_progress" all match the same rule.
function normalizeKey(text) {
	return String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function parsePropertyNames(text) {
	return String(text || '').split(',').map((name) => name.trim()).filter(Boolean);
}

// Frontmatter keys are case-sensitive in YAML, but people write Status and status interchangeably.
function getProperty(frontmatter, name) {
	if (!frontmatter) return undefined;
	if (Object.prototype.hasOwnProperty.call(frontmatter, name)) return frontmatter[name];
	const lower = name.toLowerCase();
	const key = Object.keys(frontmatter).find((k) => k.toLowerCase() === lower);
	return key === undefined ? undefined : frontmatter[key];
}

// A property can be a scalar or a list; links like [[In Progress]] or [[note|Alias]] show their text.
function toDisplayValues(raw) {
	if (raw === null || raw === undefined) return [];
	const items = Array.isArray(raw) ? raw : [raw];
	const values = [];
	for (const item of items) {
		if (item === null || item === undefined || typeof item === 'object') continue;
		let text = String(item).trim();
		const link = text.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
		if (link) text = (link[2] || link[1]).trim();
		if (text) values.push(text);
	}
	return values;
}

function hashString(text) {
	let hash = 0;
	for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
	return Math.abs(hash);
}

function resolveColor(text, rules, autoColor) {
	const key = normalizeKey(text);
	const rule = rules.find((r) => r.value && normalizeKey(r.value) === key);
	if (rule && rule.color) return rule.color;
	if (autoColor) return AUTO_PALETTE[hashString(key) % AUTO_PALETTE.length];
	return NEUTRAL_COLOR;
}

function truncate(text, maxLength) {
	if (!maxLength || maxLength < 1 || text.length <= maxLength) return text;
	return text.slice(0, Math.max(1, maxLength - 1)).trimEnd() + '…';
}

function bubblesFor(frontmatter, settings) {
	const bubbles = [];
	for (const property of parsePropertyNames(settings.properties)) {
		for (const text of toDisplayValues(getProperty(frontmatter, property))) {
			bubbles.push({
				property,
				text,
				label: truncate(text, settings.maxLength),
				key: normalizeKey(text),
				color: resolveColor(text, settings.rules, settings.autoColor),
			});
		}
	}
	return bubbles;
}

function sortPropertyName(settings) {
	return (settings.sortProperty || '').trim() || parsePropertyNames(settings.properties)[0] || 'status';
}

// Folder paths as Obsidian writes them: no leading or trailing slash, and "/" for the vault root.
function normalizeFolderPath(path) {
	return String(path).trim().replace(/^\/+|\/+$/g, '') || '/';
}

function isFolderSorted(folderPath, settings) {
	if (settings.sortMode === 'all') return true;
	if (settings.sortMode !== 'folders') return false;
	return settings.sortFolders.some((entry) => {
		const scope = normalizeFolderPath(entry);
		return scope === '/' || folderPath === scope || folderPath.startsWith(scope + '/');
	});
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function firstValue(frontmatter, property) {
	return toDisplayValues(getProperty(frontmatter, property))[0] ?? null;
}

// The normalized group values in display order.
function groupOrderKeys(settings) {
	const values = settings.groupOrder?.length ? settings.groupOrder : settings.rules.map((r) => r.value);
	return values.map(normalizeKey).filter(Boolean);
}

// Listed values sort in list order, before values that aren't listed.
function valueRank(text, orderKeys) {
	const index = orderKeys.indexOf(normalizeKey(text));
	return index === -1 ? orderKeys.length : index;
}

// a and b are a file's first value of the sort property, or null when it has none.
// Files without a value stay at the top or bottom whichever way the sort runs.
// Values that normalize alike ("To Do", "to-do") are the same group and compare equal.
function compareSortValues(a, b, settings, orderKeys = groupOrderKeys(settings)) {
	if (a === null || b === null) {
		if (a === b) return 0;
		return (a === null) === settings.missingLast ? 1 : -1;
	}
	let result = settings.sortOrder === 'values' ? valueRank(a, orderKeys) - valueRank(b, orderKeys) : 0;
	if (result === 0) result = collator.compare(normalizeKey(a), normalizeKey(b));
	return settings.sortDescending ? -result : result;
}

// a and b are what WITHIN_SORTS returned for two files in the same group. Missing values go last.
function compareWithinValues(a, b, descending) {
	if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
	const result = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
	return descending ? -result : result;
}

function parseWithinSort(settings) {
	const [kind, direction] = String(settings.withinSort || 'explorer').split('-');
	if (!WITHIN_SORTS[kind] || (kind === 'property' && !settings.withinProperty.trim())) return null;
	return { valueOf: WITHIN_SORTS[kind], descending: direction === 'desc' };
}

// Our own bubble insertions also show up as mutations; ignore them so a refresh can't trigger another.
function isRelevantMutation(mutation) {
	if (mutation.type === 'attributes') return true;
	for (const node of mutation.addedNodes) {
		if (node.nodeType === 1 && !node.classList.contains(BUBBLES_CLASS)) return true;
	}
	return false;
}

class PropertyBubblesPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		// The file explorer creates and recycles title elements as folders open and the list scrolls,
		// so each explorer is watched and any new title gets its bubbles.
		this.observers = new Map();
		// What each title element currently shows, so unchanged titles aren't touched.
		this.rendered = new WeakMap();
		this.revision = 0;
		this.requestRefresh = debounce(() => this.refreshAll(), 50, true);
		// Explorer views whose getSortedFolderItems is wrapped to sort by the property.
		this.patchedViews = new Set();
		// Each sorted file's sort value as of the last sort, so an edit only re-sorts when it changes.
		this.sortValues = new Map();
		this.requestResort = debounce(() => this.resortExplorers(), 200, true);

		this.addSettingTab(new PropertyBubblesSettingTab(this.app, this));
		this.applyBodyClasses();
		this.addCommands();

		this.app.workspace.onLayoutReady(() => {
			this.attachToExplorers();
			this.refreshAll();
		});
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			this.attachToExplorers();
			this.requestRefresh();
		}));
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			this.refreshPath(file.path);
			this.resortIfMoved(file);
		}));
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.requestRefresh()));
		this.registerEvent(this.app.vault.on('rename', () => this.requestRefresh()));
		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => this.addFolderMenuItem(menu, file)));
	}

	onunload() {
		for (const observer of this.observers.values()) observer.disconnect();
		this.observers.clear();
		for (const view of this.patchedViews) this.unpatchExplorer(view);
		this.patchedViews.clear();
		document.querySelectorAll(`.${BUBBLES_CLASS}`).forEach((el) => el.remove());
		document.body.classList.remove(ALIGN_RIGHT_CLASS);
	}

	async loadSettings() {
		const data = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.rules = (Array.isArray(data.rules) ? data.rules : DEFAULT_RULES).map((r) => ({ ...r }));
		this.settings.sortFolders = Array.isArray(data.sortFolders) ? data.sortFolders.slice() : [];
		this.settings.groupOrder = Array.isArray(data.groupOrder) ? data.groupOrder.slice() : [];
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.revision++;
		this.applyBodyClasses();
		this.refreshAll();
		this.resortExplorers();
	}

	addCommands() {
		this.addCommand({
			id: 'toggle-sort',
			name: 'Toggle sorting by property',
			callback: async () => {
				const settings = this.settings;
				if (settings.sortMode === 'off') {
					settings.sortMode = settings.lastSortMode === 'folders' ? 'folders' : 'all';
				} else {
					settings.lastSortMode = settings.sortMode;
					settings.sortMode = 'off';
				}
				await this.saveSettings();
				new Notice(settings.sortMode === 'off' ? 'Sorting by property is off' : `Sorting by ${sortPropertyName(settings)}`);
			},
		});
		this.addCommand({
			id: 'reverse-sort',
			name: 'Reverse the property sort order',
			callback: async () => {
				this.settings.sortDescending = !this.settings.sortDescending;
				await this.saveSettings();
				new Notice(`Sorting by ${sortPropertyName(this.settings)}, ${this.settings.sortDescending ? 'reversed' : 'in order'}`);
			},
		});
	}

	// Right-clicking a folder turns sorting on or off for it, unless every folder is sorted
	// or a parent folder already is.
	addFolderMenuItem(menu, file) {
		const settings = this.settings;
		if (!(file instanceof TFolder) || settings.sortMode === 'all') return;
		const path = file.path;
		const listed = settings.sortMode === 'folders' && settings.sortFolders.some((f) => normalizeFolderPath(f) === path);
		if (!listed && isFolderSorted(path, settings)) return;
		const property = sortPropertyName(settings);
		menu.addItem((item) => item
			.setTitle(listed ? `Stop sorting by ${property}` : `Sort by ${property}`)
			.setIcon('arrow-up-down')
			.onClick(async () => {
				if (listed) {
					settings.sortFolders = settings.sortFolders.filter((f) => normalizeFolderPath(f) !== path);
				} else {
					settings.sortFolders.push(path);
					settings.sortMode = 'folders';
				}
				await this.saveSettings();
			}));
	}

	// Obsidian calls getSortedFolderItems(folder) on the explorer view for every folder it sorts. It returns
	// the folder's items with subfolders first, then files in the user's chosen order. The wrapper
	// re-sorts the files by the property; files with equal values keep Obsidian's order.
	patchExplorer(view) {
		if (this.patchedViews.has(view) || typeof view.getSortedFolderItems !== 'function') return false;
		const original = view.getSortedFolderItems;
		const plugin = this;
		view.getSortedFolderItems = function (folder) {
			const items = original.call(this, folder);
			try {
				return plugin.sortFolderItems(folder, items);
			} catch (error) {
				console.error('Property Bubbles: sorting failed', error);
				return items;
			}
		};
		this.patchedViews.add(view);
		return true;
	}

	unpatchExplorer(view) {
		// Removing the own property brings back the method on the view's prototype.
		delete view.getSortedFolderItems;
		view.requestSort?.();
	}

	sortFolderItems(folder, items) {
		if (!folder || !isFolderSorted(folder.path, this.settings)) return items;
		const settings = this.settings;
		const orderKeys = groupOrderKeys(settings);
		const within = parseWithinSort(settings);
		const keys = new Map();
		for (const item of items) {
			if (!(item.file instanceof TFile)) continue;
			const key = this.sortKeyOf(item.file, within);
			keys.set(item, key);
			this.sortValues.set(item.file.path, JSON.stringify(key));
		}
		const folders = items.filter((item) => !keys.has(item));
		const files = items.filter((item) => keys.has(item));
		files.sort((a, b) => {
			const ka = keys.get(a);
			const kb = keys.get(b);
			const result = compareSortValues(ka.group, kb.group, settings, orderKeys);
			return result || !within ? result : compareWithinValues(ka.within, kb.within, within.descending);
		});
		return folders.concat(files);
	}

	// The file's group value and, when files are sorted within groups, the value they're sorted by.
	sortKeyOf(file, within = parseWithinSort(this.settings)) {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return {
			group: firstValue(frontmatter, sortPropertyName(this.settings)),
			within: within ? within.valueOf(file, frontmatter, this.settings) : null,
		};
	}

	resortIfMoved(file) {
		if (this.settings.sortMode === 'off' || !this.patchedViews.size) return;
		const previous = this.sortValues.get(file.path);
		const current = JSON.stringify(this.sortKeyOf(file));
		const moved = previous === undefined ? isFolderSorted(file.parent?.path ?? '/', this.settings) : previous !== current;
		if (moved) this.requestResort();
	}

	resortExplorers() {
		this.sortValues.clear();
		for (const view of this.patchedViews) view.requestSort?.();
	}

	applyBodyClasses() {
		document.body.classList.toggle(ALIGN_RIGHT_CLASS, !!this.settings.alignRight);
	}

	attachToExplorers() {
		const live = new Set();
		const liveViews = new Set();
		for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
			liveViews.add(leaf.view);
			if (this.patchExplorer(leaf.view)) leaf.view.requestSort?.();
			const container = leaf.view.containerEl;
			live.add(container);
			if (this.observers.has(container)) continue;
			const observer = new MutationObserver((mutations) => {
				if (mutations.some(isRelevantMutation)) this.requestRefresh();
			});
			observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-path'] });
			this.observers.set(container, observer);
		}
		for (const [container, observer] of this.observers) {
			if (live.has(container)) continue;
			observer.disconnect();
			this.observers.delete(container);
		}
		for (const view of this.patchedViews) {
			if (!liveViews.has(view)) this.patchedViews.delete(view);
		}
	}

	refreshAll() {
		for (const container of this.observers.keys()) {
			container.querySelectorAll(TITLE_SELECTOR).forEach((el) => this.decorate(el));
		}
	}

	refreshPath(path) {
		const selector = `.nav-file-title[data-path="${CSS.escape(path)}"]`;
		for (const container of this.observers.keys()) {
			container.querySelectorAll(selector).forEach((el) => this.decorate(el));
		}
	}

	decorate(titleEl) {
		const path = titleEl.getAttribute('data-path');
		const file = this.app.vault.getAbstractFileByPath(path);
		const frontmatter = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
		const bubbles = frontmatter ? bubblesFor(frontmatter, this.settings) : [];

		const signature = bubbles.length ? `${this.revision}\u0000${path}\u0000${JSON.stringify(bubbles)}` : '';
		const existing = titleEl.querySelector(`:scope > .${BUBBLES_CLASS}`);
		if (this.rendered.get(titleEl) === signature && !!existing === !!signature) return;
		this.rendered.set(titleEl, signature);

		existing?.remove();
		if (!bubbles.length) return;

		const wrap = createSpan({ cls: BUBBLES_CLASS });
		for (const bubble of bubbles) {
			const el = wrap.createSpan({ cls: 'ptb-bubble', text: bubble.label });
			el.style.setProperty('--ptb-color', bubble.color);
			el.dataset.property = bubble.property;
			el.dataset.value = bubble.key;
			el.setAttribute('aria-label', `${bubble.property}: ${bubble.text}`);
		}
		const content = titleEl.querySelector(':scope > .nav-file-title-content');
		if (content) content.after(wrap);
		else titleEl.appendChild(wrap);
	}
}

class PropertyBubblesSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
		// Typing in a text box saves after a pause instead of on every key.
		this.saveSoon = debounce(() => this.plugin.saveSettings(), 400, true);
	}

	display() {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Properties')
			.setDesc('Frontmatter properties to show, separated by commas. Each value gets its own bubble; list properties get one bubble per item.')
			.addText((text) => text
				.setPlaceholder('status')
				.setValue(settings.properties)
				.onChange((value) => {
					settings.properties = value;
					this.saveSoon();
				}));

		new Setting(containerEl)
			.setName('Align to the right')
			.setDesc('Line bubbles up at the right edge of the file list. When off, they sit right after the file name.')
			.addToggle((toggle) => toggle
				.setValue(settings.alignRight)
				.onChange(async (value) => {
					settings.alignRight = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Maximum length')
			.setDesc('Longer values are shortened with an ellipsis (the full value shows on hover). 0 means no limit.')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text
					.setValue(String(settings.maxLength))
					.onChange((value) => {
						const parsed = parseInt(value, 10);
						settings.maxLength = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
						this.saveSoon();
					});
			});

		new Setting(containerEl)
			.setName('Automatic colors')
			.setDesc('Give values without a color below a color of their own, always the same for the same value. When off, they are gray.')
			.addToggle((toggle) => toggle
				.setValue(settings.autoColor)
				.onChange(async (value) => {
					settings.autoColor = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Value colors')
			.setDesc('Matching ignores case, spaces, dashes and underscores, so "In Progress" also matches "in-progress". Unless you set a custom group order under Sorting, groups sort in the order of this list; use the arrows to change it.')
			.setHeading();

		settings.rules.forEach((rule, index) => {
			new Setting(containerEl)
				.addText((text) => text
					.setPlaceholder('Value')
					.setValue(rule.value)
					.onChange((value) => {
						rule.value = value;
						this.saveSoon();
					}))
				.addColorPicker((picker) => picker
					.setValue(rule.color)
					.onChange(async (value) => {
						rule.color = value;
						await this.plugin.saveSettings();
					}))
				.addExtraButton((button) => button
					.setIcon('arrow-up')
					.setTooltip('Move up')
					.setDisabled(index === 0)
					.onClick(() => this.moveRule(index, -1)))
				.addExtraButton((button) => button
					.setIcon('arrow-down')
					.setTooltip('Move down')
					.setDisabled(index === settings.rules.length - 1)
					.onClick(() => this.moveRule(index, 1)))
				.addExtraButton((button) => button
					.setIcon('trash')
					.setTooltip('Remove')
					.onClick(async () => {
						settings.rules.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					}));
		});

		new Setting(containerEl)
			.addButton((button) => button
				.setButtonText('Add value')
				.setCta()
				.onClick(async () => {
					settings.rules.push({ value: '', color: AUTO_PALETTE[settings.rules.length % AUTO_PALETTE.length] });
					await this.plugin.saveSettings();
					this.display();
				}))
			.addButton((button) => button
				.setButtonText('Reset to defaults')
				.onClick(async () => {
					settings.rules = DEFAULT_RULES.map((r) => ({ ...r }));
					await this.plugin.saveSettings();
					this.display();
				}));

		this.displaySorting(containerEl);
	}

	displaySorting(containerEl) {
		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName('Sorting')
			.setDesc('Sort files in the file explorer by a property. Files with the same value form a group; you choose the order of the groups and how files are sorted inside each one. Folders stay on top. You can also right-click a folder to sort just that folder, or use the commands "Toggle sorting by property" and "Reverse the property sort order".')
			.setHeading();

		new Setting(containerEl)
			.setName('Sort files by property')
			.addDropdown((dropdown) => dropdown
				.addOption('off', 'Off')
				.addOption('all', 'In every folder')
				.addOption('folders', 'Only in chosen folders')
				.setValue(settings.sortMode)
				.onChange(async (value) => {
					settings.sortMode = value;
					if (value !== 'off') settings.lastSortMode = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (settings.sortMode === 'folders') {
			new Setting(containerEl)
				.setName('Folders')
				.setDesc('One folder path per line, e.g. Projects/Tickets. Their subfolders are sorted too. Use / for the whole vault.')
				.addTextArea((text) => {
					text.inputEl.rows = 4;
					text
						.setPlaceholder('Tickets')
						.setValue(settings.sortFolders.join('\n'))
						.onChange((value) => {
							settings.sortFolders = value.split('\n').filter((line) => line.trim()).map(normalizeFolderPath);
							this.saveSoon();
						});
				});
		}

		new Setting(containerEl)
			.setName('Group by property')
			.setDesc('Files with the same value of this property form a group. Leave blank to use the first property shown in bubbles. For list properties, the first item counts.')
			.addText((text) => text
				.setPlaceholder(parsePropertyNames(settings.properties)[0] || 'status')
				.setValue(settings.sortProperty)
				.onChange((value) => {
					settings.sortProperty = value;
					this.saveSoon();
				}));

		new Setting(containerEl)
			.setName('Group order')
			.setDesc('Custom order puts groups in the order you list below, then other values alphabetically after them.')
			.addDropdown((dropdown) => dropdown
				.addOption('values', 'Custom order')
				.addOption('alphabetical', 'Alphabetical')
				.setValue(settings.sortOrder)
				.onChange(async (value) => {
					settings.sortOrder = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (settings.sortOrder === 'values') {
			new Setting(containerEl)
				.setName('Custom group order')
				.setDesc('One value per line, top group first. Matching ignores case, spaces, dashes and underscores. Leave empty to use the order of the Value colors list above.')
				.addTextArea((text) => {
					text.inputEl.rows = 6;
					text
						.setPlaceholder(settings.rules.map((r) => r.value).filter(Boolean).join('\n'))
						.setValue(settings.groupOrder.join('\n'))
						.onChange((value) => {
							settings.groupOrder = value.split('\n').map((line) => line.trim()).filter(Boolean);
							this.saveSoon();
						});
				})
				.addExtraButton((button) => button
					.setIcon('copy')
					.setTooltip('Fill in from the Value colors list')
					.onClick(async () => {
						settings.groupOrder = settings.rules.map((r) => r.value.trim()).filter(Boolean);
						await this.plugin.saveSettings();
						this.display();
					}));
		}

		new Setting(containerEl)
			.setName('Reverse group order')
			.setDesc('Flips the order of the groups. The order inside each group is set below.')
			.addToggle((toggle) => toggle
				.setValue(settings.sortDescending)
				.onChange(async (value) => {
					settings.sortDescending = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Files without the property')
			.addDropdown((dropdown) => dropdown
				.addOption('last', 'At the bottom')
				.addOption('first', 'At the top')
				.setValue(settings.missingLast ? 'last' : 'first')
				.onChange(async (value) => {
					settings.missingLast = value === 'last';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sort within each group')
			.setDesc('How files in the same group are ordered. "Same as the file explorer" follows the explorer\'s own sort menu.')
			.addDropdown((dropdown) => dropdown
				.addOption('explorer', 'Same as the file explorer')
				.addOption('name', 'File name (A to Z)')
				.addOption('name-desc', 'File name (Z to A)')
				.addOption('modified-desc', 'Modified time (new to old)')
				.addOption('modified', 'Modified time (old to new)')
				.addOption('created-desc', 'Created time (new to old)')
				.addOption('created', 'Created time (old to new)')
				.addOption('property', 'Another property (A to Z)')
				.addOption('property-desc', 'Another property (Z to A)')
				.setValue(settings.withinSort)
				.onChange(async (value) => {
					settings.withinSort = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (settings.withinSort.startsWith('property')) {
			new Setting(containerEl)
				.setName('Sort within groups by')
				.setDesc('The property that orders files inside each group, e.g. priority or due. Numbers sort naturally; files without it go last.')
				.addText((text) => text
					.setPlaceholder('priority')
					.setValue(settings.withinProperty)
					.onChange((value) => {
						settings.withinProperty = value;
						this.saveSoon();
					}));
		}
	}

	async moveRule(index, offset) {
		const rules = this.plugin.settings.rules;
		const target = index + offset;
		if (target < 0 || target >= rules.length) return;
		[rules[index], rules[target]] = [rules[target], rules[index]];
		await this.plugin.saveSettings();
		this.display();
	}
}

module.exports = PropertyBubblesPlugin;
module.exports.default = PropertyBubblesPlugin;
// Exposed for the tests in tests/; Obsidian ignores it.
module.exports._internals = {
	DEFAULT_SETTINGS, normalizeKey, parsePropertyNames, getProperty, toDisplayValues, resolveColor, truncate, bubblesFor,
	isRelevantMutation, sortPropertyName, normalizeFolderPath, isFolderSorted, compareSortValues, compareWithinValues,
	groupOrderKeys, parseWithinSort,
};
