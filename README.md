# Property Bubbles (ObsidianTagsInFiles)

An Obsidian plugin that reads a frontmatter property from each note and shows its value as a small colored bubble next to the file name in the file explorer.

If you keep tickets or user stories as notes, you can see each one's status (Backlog, To Do, In Progress, Done) in the file list without opening it:

```
Tickets
  Add login page          (In Progress)
  Dark mode               (Backlog)
  Fix broken export       (Blocked)
  Set up CI               (Done)
```

## Using it

Give your notes the property in their frontmatter (by default `status`):

```yaml
---
status: In Progress
---
```

- **Lists** show one bubble per item, so `labels: [frontend, auth]` shows two.
- **Links** show their text: `status: "[[In Progress]]"` shows `In Progress`.
- **Property names** match regardless of case (`Status` works for `status`).
- Notes without the property show nothing.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Properties | `status` | Properties to show, separated by commas, e.g. `status, priority`. |
| Align to the right | on | Bubbles line up at the right edge. When off, they sit right after the name. |
| Maximum length | 20 | Longer values are cut with an ellipsis; hover for the full value. 0 means no limit. |
| Automatic colors | on | Values with no color set get a color of their own, the same one every time. When off they're gray. |
| Value colors | Backlog, To Do, In Progress, Review, Blocked, Done | A color for each value. Matching ignores case, spaces, dashes and underscores, so `in-progress` and `IN_PROGRESS` use the `In Progress` color. |

## Styling with CSS snippets

Each bubble is a `span.ptb-bubble` with `data-property` (the property name) and `data-value` (the value, lowercase, with spaces and punctuation removed). Its color comes from `--ptb-color`:

```css
.ptb-bubble[data-value="done"] { --ptb-color: #16a34a; }
.ptb-bubble[data-property="priority"] { font-weight: 600; }
```

## Installing

The plugin is plain JavaScript, so there is nothing to build. Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/property-bubbles/`, or on Windows run:

```powershell
.\install.ps1 -Vault "X:\path\to\vault"
```

Then in Obsidian go to **Settings → Community plugins**, turn off Restricted mode if it's on, and enable **Property Bubbles**. After installing a new version, turn the plugin off and on again (or reload Obsidian).

To try it out, open [example-vault](example-vault) as a vault in Obsidian, install the plugin into it, and look at the `Tickets` folder.

## Development

- [main.js](main.js) is the whole plugin (CommonJS, loaded directly by Obsidian). [styles.css](styles.css) styles the bubbles.
- The file explorer adds and reuses its rows as folders open and the list scrolls, so the plugin watches each explorer with a `MutationObserver` and adds bubbles to new rows. It also updates a note's bubble when its frontmatter changes (`metadataCache` `changed`) and after renames.
- Tests cover the parsing and color helpers: `node --test tests/helpers.test.js` (Node 18 or later). Without Node installed, VS Code's Electron can run them: set `ELECTRON_RUN_AS_NODE=1` and run `Code.exe --test tests/helpers.test.js`.
