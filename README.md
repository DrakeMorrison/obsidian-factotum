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

By default this works on the note you're currently viewing. To always add to one designated TODO note no matter which note is open, set a **TODO note path** in **Settings → Drake's Factotum** (e.g. `TODO.md`). The command then targets that note from anywhere — and stays available even when no note is open. Leave the path blank to keep the original "current note" behavior.

### Inbox: capture now, prioritize later

Add an `## Inbox` heading anywhere in your TODO note (top or bottom — it stays where you put it) and toss unprioritized bullets under it as they occur to you. Inbox items are ignored by ranking sessions — they hold no rank until you triage them. When you're ready:

> **Drake's Factotum: Triage inbox (prioritize and place each item)**

Each inbox item is walked through the usual flow — in a matrix note you classify it (urgent? important?) and then binary-search-place it within its quadrant; in a flat note it's binary-search-placed straight into the ranked list. On save, every item lands in its spot and the Inbox is emptied (the heading stays, ready for the next capture).

### Stopping partway — progress is saved

Every interactive session can be closed at any point (Esc, the ✕, or clicking outside) without losing the decisions you've already made:

- **Ranking session** — comparisons made so far are kept: fully merged groups (and fully sorted quadrants) stay in their decided order, and everything not yet compared keeps its current relative order. Run the session again later to finish the job.
- **Triage inbox** — items you've already placed are saved into position; the current item and anything you didn't reach stay in the Inbox for next time.
- **Add new item** — mid-placement, the item is saved at the midpoint of the range your answers have narrowed it to; in a matrix note, closing before classifying drops it into the Inbox instead.
- **Convert to matrix** — items you've classified land in their quadrants; the rest go to the Inbox.

Closing before making any decision leaves the note untouched. Partial saves go through the editor, so `Ctrl/Cmd+Z` undoes one if you actually meant to cancel.

### Prioritize with Claude

Instead of answering every comparison yourself, you can hand the whole list to Claude:

> **Drake's Factotum: Prioritize with Claude (whole list → Eisenhower matrix)**

It sends every active item — quadrant contents, ranked list, and Inbox alike — to the Anthropic API, which classifies each into an Eisenhower quadrant and orders each quadrant by priority. You review the proposal in a modal before anything is written; **Save to note** applies it (a flat note becomes a matrix note), closing discards it. Items Claude fails to place are left in the Inbox rather than dropped. Requires the **Anthropic API key** in settings (shared with the periodic reviews); one API call per run.

To help Claude match *your* sense of urgency, recently completed items are included as calibration — see the tagging below.

### Done items remember their quadrant

In a matrix note, when a task you check off (`- [x]`) migrates to the `## Done` section on the next save, it's tagged with the quadrant it came from: `#urgent #important` from **Do**, `#important` from **Schedule**, `#urgent` from **Delegate**, nothing from **Delete**. The tags make your history searchable and give Claude concrete examples of how you classify work when it prioritizes for you. Already-tagged items are never double-tagged.

### Checked-off tasks

Lines like `- [x] done thing` are skipped — they don't appear in comparisons and stay put when the list is rewritten. Active tasks (`- [ ] thing`) and plain bullets (`- thing`) are both ranked.

### Nested tasks

Indented lines beneath a bullet — sub-tasks, nested checkboxes, or continuation text — are treated as part of that item. Only the top-level bullets are compared, and each one's nested block travels with it when the list is reordered, so structure like this is preserved:

```markdown
- [ ] Build the side project
    - [ ] Sketch the UI
    - [ ] Pick the stack
- Learn Spanish
    - via Duolingo
```

After ranking, `Sketch the UI` and `Pick the stack` stay under `Build the side project` wherever it lands.

### Scroll offset (nvim-style scrolloff)

Keeps a margin of context lines above and below the cursor while editing, so you're never writing against the very top or bottom edge of the window — the view scrolls a little ahead of you, the way Vim's `scrolloff` does.

Set the number of lines in **Settings → Drake's Factotum → Editing → Scroll offset** (defaults to **10**). Set it to `0` to turn the behavior off. Desktop only — it's ignored on mobile, where the on-screen keyboard already manages the viewport.

### Nightly word count → Beeminder

Optionally, the plugin can post your daily writing output to a [Beeminder](https://www.beeminder.com) goal every night at **11PM**.

Enable it in **Settings → Drake's Factotum** and fill in:

- **Auth token** — from `beeminder.com/api/v1/auth_token.json`
- **Username** and **goal name** (the goal slug, e.g. `writing`)

Each night it counts the words in today's daily note, **subtracts the word count of your daily note template** (so boilerplate doesn't inflate the number), and sends the result. The daily note and template are located automatically from your **Daily Notes** or **Periodic Notes** settings; you can override the template path in settings if needed.

If Obsidian wasn't open at 11PM, it catches up the next time you launch (provided it's still past 11PM and that day hasn't been sent yet). Re-sends for the same day update the datapoint rather than duplicating it. Use **Send now** in settings to test your setup.

### Periodic review notes (weekly, monthly, quarterly, yearly)

Optionally, the plugin can generate a review note whenever a period closes — **weekly** (just after Sunday midnight), **monthly** (just after midnight on the 1st), **quarterly** (Jan/Apr/Jul/Oct 1), and **yearly** (January 1). Each is enabled independently, and each reads the just-finished period's **daily notes** directly — the longer reviews don't summarize the shorter ones — and uses the [Anthropic Claude API](https://www.anthropic.com) to write:

- a prose **`## AI Summary`** of the period, and
- **`## Review Questions`** — one reflective question per goal in your goals note, each as a heading with space to write your answer underneath.

Enable them in **Settings → Drake's Factotum**. All reviews share:

- **Anthropic API key** — from [console.anthropic.com](https://console.anthropic.com)
- **Model** — defaults to `claude-opus-4-8` (any Anthropic model id works)

and each has its own:

- **Review folder** — defaults to `Weekly Reviews`, `Monthly Reviews`, `Quarterly Reviews`, `Yearly Reviews`
- **Header embed** (optional) — inserted at the top of every review, above the summary. Defaults to `![[goals#goals]]` (an embed of your goals note); blank to omit.
- **Goals source** (optional) — a wiki link like `![[goals#goals]]` whose linked section is read so the review ends with one question per goal; blank to skip the questions.

Notes are named by period — `2026-W23.md`, `2026-06.md`, `2026-Q2.md`, `2026.md` — and created automatically in their folder. Daily notes are located from your **Daily Notes** or **Periodic Notes** settings. If Obsidian was closed at the scheduled time (including on mobile, where background timers don't fire), it catches up on the next launch for the most recent period that wasn't yet generated. An existing review note is never overwritten — a manual re-run writes a numbered sibling instead. Use **Generate now** in settings to test your setup (mid-period it reviews the days so far).

> Each run makes one Claude API call (typically a few cents; the yearly review sends a full year of daily notes, so it costs more — very large vaults may approach the model's context limit). The API key is stored locally in the plugin's `data.json`.

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
