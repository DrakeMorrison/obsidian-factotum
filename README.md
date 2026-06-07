# Drake's Factotum — Obsidian Plugin

A handy multi-tool for markdown lists. Rank by pairwise comparison, slot in new items via binary-search placement, or sort a flat list into an Eisenhower matrix. The order of the list **is** the ranking — no scores, no frontmatter clutter.

---

## Installation

1. In Obsidian, go to **Settings → Community plugins → Turn off Restricted mode**
2. Open your vault folder in Finder/Explorer
3. Navigate to `.obsidian/plugins/` (create the `plugins` folder if it doesn't exist)
4. Create a new folder called `drake-factotum`
5. Copy `main.js`, `manifest.json`, and `styles.css` into that folder
6. In Obsidian: **Settings → Community plugins → Installed plugins → Refresh**
7. Enable **Drake's Factotum**

---

## Usage

### Setting up your note

Make a markdown note with a simple list. Any bullet style works (`-`, `*`, `+`):

```markdown
- Learn Spanish
- Build the side project
- Read Thinking Fast and Slow
- Start a gym habit
- Write in my journal daily
- Fix the basement
```

### Running a ranking session

Open the note, then use the command palette (`Cmd/Ctrl+P`):

> **Drake's Factotum: Start ranking session**

You'll be shown pairs of items. Click the one that matters more to you. The plugin runs an interactive merge sort, so every comparison is load-bearing — for *n* items expect roughly *n · log₂ n* comparisons. When done, click **Save to note** and the list is rewritten in ranked order.

If you can't decide between two items, hit **Skip** — the current relative order is preserved for that pair.

### Adding a new item

> **Drake's Factotum: Add new item (binary-search placement)**

Type your new item, then answer ~log₂(n) comparisons to slot it in the right place. For a 100-item list that's ~7 questions.

### Checked-off tasks

Lines like `- [x] done thing` are skipped — they don't appear in comparisons and stay put when the list is rewritten. Active tasks (`- [ ] thing`) and plain bullets (`- thing`) are both ranked.

---

## How your note looks after ranking

```markdown
- Build the side project
- Learn Spanish
- Read Thinking Fast and Slow
- Start a gym habit
- Write in my journal daily
- Fix the basement
```

That's it. The list is the ranking; nothing extra is written to the file.

---

## Tips

- You can freely edit the list by hand between sessions — new bullets are picked up automatically next time you run a session or use add-item.
- Data never leaves your machine. Everything is local markdown.
