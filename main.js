'use strict';

const { Plugin, PluginSettingTab, Setting, TFile, debounce } = require('obsidian');

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
	rules: DEFAULT_RULES,
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

		this.addSettingTab(new PropertyBubblesSettingTab(this.app, this));
		this.applyBodyClasses();

		this.app.workspace.onLayoutReady(() => {
			this.attachToExplorers();
			this.refreshAll();
		});
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			this.attachToExplorers();
			this.requestRefresh();
		}));
		this.registerEvent(this.app.metadataCache.on('changed', (file) => this.refreshPath(file.path)));
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.requestRefresh()));
		this.registerEvent(this.app.vault.on('rename', () => this.requestRefresh()));
	}

	onunload() {
		for (const observer of this.observers.values()) observer.disconnect();
		this.observers.clear();
		document.querySelectorAll(`.${BUBBLES_CLASS}`).forEach((el) => el.remove());
		document.body.classList.remove(ALIGN_RIGHT_CLASS);
	}

	async loadSettings() {
		const data = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.rules = (Array.isArray(data.rules) ? data.rules : DEFAULT_RULES).map((r) => ({ ...r }));
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.revision++;
		this.applyBodyClasses();
		this.refreshAll();
	}

	applyBodyClasses() {
		document.body.classList.toggle(ALIGN_RIGHT_CLASS, !!this.settings.alignRight);
	}

	attachToExplorers() {
		const live = new Set();
		for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
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
			.setDesc('Matching ignores case, spaces, dashes and underscores, so "In Progress" also matches "in-progress".')
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
	}
}

module.exports = PropertyBubblesPlugin;
module.exports.default = PropertyBubblesPlugin;
// Exposed for the tests in tests/; Obsidian ignores it.
module.exports._internals = { normalizeKey, parsePropertyNames, getProperty, toDisplayValues, resolveColor, truncate, bubblesFor, isRelevantMutation };
