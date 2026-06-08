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

### Nightly word count → Beeminder

Optionally, the plugin can post your daily writing output to a [Beeminder](https://www.beeminder.com) goal every night at **11PM**.

Enable it in **Settings → Drake's Factotum** and fill in:

- **Auth token** — from `beeminder.com/api/v1/auth_token.json`
- **Username** and **goal name** (the goal slug, e.g. `writing`)

Each night it counts the words in today's daily note, **subtracts the word count of your daily note template** (so boilerplate doesn't inflate the number), and sends the result. The daily note and template are located automatically from your **Daily Notes** or **Periodic Notes** settings; you can override the template path in settings if needed.

If Obsidian wasn't open at 11PM, it catches up the next time you launch (provided it's still past 11PM and that day hasn't been sent yet). Re-sends for the same day update the datapoint rather than duplicating it. Use **Send now** in settings to test your setup.

### Weekly review note

Optionally, the plugin can generate a **weekly review note** just before midnight every **Sunday** (11:55PM). It reads the past week's daily notes (Monday–Sunday) and uses the [Anthropic Claude API](https://www.anthropic.com) to write:

- a prose **`## Summary`** of the week, and
- a **`## Potential TODOs`** checkbox list — every still-open `- [ ]` task from the week, plus action items inferred from your notes.

Enable it in **Settings → Drake's Factotum** and fill in:

- **Anthropic API key** — from [console.anthropic.com](https://console.anthropic.com)
- **Model** — defaults to `claude-opus-4-8` (any Anthropic model id works)
- **Review folder** — defaults to `Weekly Reviews`
- **Header embed** (optional) — inserted at the top of every review, above the summary. Defaults to `![[goals#goals]]` (an embed of your goals note); blank to omit.

The note is saved as `Weekly Reviews/<ISO-week>.md` (e.g. `Weekly Reviews/2026-W23.md`), created and named automatically. Daily notes are located from your **Daily Notes** or **Periodic Notes** settings. If Obsidian was closed at the scheduled time (including on mobile, where background timers don't fire), it catches up on the next launch for the most recent Sunday that wasn't yet generated. Re-running overwrites that week's note rather than duplicating it. Use **Generate now** in settings to test your setup.

> Each run makes one Claude API call (typically a few cents). The API key is stored locally in the plugin's `data.json`.

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
