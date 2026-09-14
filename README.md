# Factotum — Obsidian Plugin

A handy multi-tool for markdown lists. Rank by pairwise comparison, slot in new items via binary-search placement, or sort a flat list into an Eisenhower matrix. The order of the list **is** the ranking — no scores, no frontmatter clutter.

---

## Installation

1. In Obsidian, go to **Settings → Community plugins → Turn off Restricted mode**
2. Open your vault folder in Finder/Explorer
3. Navigate to `.obsidian/plugins/` (create the `plugins` folder if it doesn't exist)
4. Create a new folder called `drake-factotum`
5. Copy `main.js`, `manifest.json`, and `styles.css` into that folder
6. In Obsidian: **Settings → Community plugins → Installed plugins → Refresh**
7. Enable **Factotum**

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

> **Factotum: Start ranking session**

On a **flat note**, you'll be shown pairs of items. Click the one that matters more to you. The plugin runs an interactive merge sort, so every comparison is load-bearing — for *n* items expect roughly *n · log₂ n* comparisons. When done, click **Save to note** and the list is rewritten in ranked order.

If you can't decide between two items, hit **Skip** — the current relative order is preserved for that pair.

On a **matrix note**, the quadrant *is* the rank — there are no within-quadrant comparisons. The session instead walks every active item and asks two quick questions (urgent? important?), moving each item to the quadrant its answers pick. That's a flat 2 decisions per item instead of *n · log₂ n*, and it doubles as a periodic re-triage when priorities shift. Order within a quadrant stays as-is; rearrange bullets by hand if you care.

### Adding a new item

> **Factotum: Add new item to the note**

Type your new item, then answer ~log₂(n) comparisons to slot it in the right place. For a 100-item list that's ~7 questions. In a matrix note it's just the two classification questions (urgent? important?) — the item lands at the end of its quadrant, no comparisons.

By default this works on the note you're currently viewing. To always add to one designated TODO note no matter which note is open, set a **TODO note path** in **Settings → Factotum** (e.g. `TODO.md`). The command then targets that note from anywhere — and stays available even when no note is open. Leave the path blank to keep the original "current note" behavior.

### Categorizing already-done items

> **Factotum: Categorize done items (tag urgent/important for Claude calibration)**

Items checked off inside a quadrant carry `#urgent` / `#important` (or `#neither`) into Done automatically — landing at the top, so Done reads newest-first — and the Claude prioritizer sends the whole Done section along to learn how you classify work. Items that were finished before the matrix existed have no tags, so they teach it nothing. This command walks the untagged Done items, newest first, and asks one four-way question per item — **1** Urgent & Important, **2** Important only, **3** Urgent only, **4** Neither, **s** to skip. Tags are appended to the existing lines; nothing else in the note moves. Close anytime and the items already answered are saved; run it again to continue.

### Inbox: capture now, prioritize later

Add an `## Inbox` heading to your TODO note and toss unprioritized bullets under it as they occur to you (the [nightly sweep](#nightly-to-do-sweep--inbox) can fill it from your daily notes too). The Inbox lives at the **top** of the note, with a `## TODO` heading below it marking where the ranked list starts — the plugin adds the TODO heading (and keeps both sections in place) whenever it saves. Inbox items are ignored by ranking sessions — they hold no rank until you triage them. When you're ready:

> **Factotum: Triage inbox (prioritize and place each item)**

Each inbox item is walked through the usual flow — in a matrix note you classify it (urgent? important?) and it lands at the end of that quadrant; in a flat note it's binary-search-placed into the ranked list. On save, every item lands in its spot and the Inbox is emptied (the heading stays, ready for the next capture).

### Stopping partway — progress is saved

Every interactive session can be closed at any point (Esc, the ✕, or clicking outside) without losing the decisions you've already made:

- **Ranking session** — decisions made so far are kept: in a flat note, fully merged groups stay in their decided order; in a matrix note, items already re-classified keep their new quadrant. Everything not yet reached keeps its current place. Run the session again later to finish the job.
- **Triage inbox** — items you've already placed are saved into position; the current item and anything you didn't reach stay in the Inbox for next time.
- **Add new item** — in a flat note, closing mid-placement saves the item at the midpoint of the range your answers have narrowed it to; in a matrix note, closing before classifying drops it into the Inbox instead.
- **Convert to matrix** — items you've classified land in their quadrants; the rest go to the Inbox.

Closing before making any decision leaves the note untouched. Partial saves go through the editor, so `Ctrl/Cmd+Z` undoes one if you actually meant to cancel.

### Prioritize with Claude

Instead of answering every comparison yourself, you can hand the whole list to Claude:

> **Factotum: Prioritize with Claude (whole list → Eisenhower matrix)**

It sends every active item — quadrant contents, ranked list, and Inbox alike — to the Anthropic API, which classifies each into an Eisenhower quadrant and orders each quadrant by priority. You review the proposal in a modal before anything is written; **Save to note** applies it (a flat note becomes a matrix note), closing discards it. Items Claude fails to place are left in the Inbox rather than dropped. Requires the **Anthropic API key** in settings (shared with the periodic reviews); one API call per run.

To help Claude match *your* sense of urgency, recently completed items are included as calibration — see the tagging below.

### Undoing the matrix

To collapse a matrix note back into one prioritized list:

> **Factotum: Convert Eisenhower matrix back to flat list**

The quadrant headings disappear and their items become a single ranked list — **Do** first, then **Delegate**, then **Schedule**, then **Delete** — with each quadrant's internal order intact. The note's layout is untouched: the Inbox stays at the top, the list sits under `## TODO`, and `## Done` stays at the bottom with checkboxes and quadrant tags intact. No questions asked; it's deterministic, and `Ctrl/Cmd+Z` undoes it.

### Done items remember their quadrant

In a matrix note, when a task you check off (`- [x]`) migrates to the `## Done` section on the next save, it's tagged with the quadrant it came from: `#urgent #important` from **Do**, `#important` from **Schedule**, `#urgent` from **Delegate**, nothing from **Delete**. The tags make your history searchable and give Claude concrete examples of how you classify work when it prioritizes for you. Already-tagged items are never double-tagged.

### Checked-off tasks

Lines like `- [x] done thing` are skipped — they don't appear in comparisons, and on save they collect under a `## Done` heading at the bottom of the note (created if needed). Unchecking an item under `## Done` revives it: the next save ranks it back into the list. Active tasks (`- [ ] thing`) and plain bullets (`- thing`) are both ranked.

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

### Reflection feed: scroll random notes instead of a timeline

> **Factotum: Open reflection feed (scroll random notes)** — or click the shuffle icon in the ribbon

Opens a tab that's an endless, read-only scroll of random notes from your vault — a vault-flavored stand-in for the infinite feeds elsewhere, for the moments you'd otherwise reach for one. Each note is rendered in reading mode right there in the feed; scroll toward the bottom and the next few are drawn automatically, so there's no button to press between notes. Long notes are clipped with a **Read more** button that expands them in place. Tap a note's title to open it properly (in a new tab), and wiki links inside the rendered text work as usual.

Notes are dealt from a shuffled deck, so nothing repeats until every note has been shown once — the feed then reshuffles and keeps going. The shuffle icon in the view's header starts a fresh deck. Works on mobile: add the command to the mobile toolbar, or find the shuffle icon in the left sidebar.

With a keyboard, the feed takes vim-style keys whenever it's the focused pane: `j`/`k` scroll a few lines, `d`/`u` (or `Ctrl-d`/`Ctrl-u`) half a page, `J`/`K` snap to the next/previous note, `gg`/`G` jump to the top/bottom of what's loaded, `o` or `Enter` opens the note you're looking at in a new tab, and `r` reshuffles.

In **Settings → Factotum → Reflection feed** you can list **excluded folders** (templates, attachments, whatever isn't worth re-reading — subfolders are excluded with them), set a **minimum note length** so empty stubs are skipped (default 40 characters of body text, frontmatter ignored), and adjust how many **notes per load** are drawn at a time.

### Scroll offset (nvim-style scrolloff)

Keeps a margin of context lines above and below the cursor while editing, so you're never writing against the very top or bottom edge of the window — the view scrolls a little ahead of you, the way Vim's `scrolloff` does.

Set the number of lines in **Settings → Factotum → Editing → Scroll offset** (defaults to **10**). Set it to `0` to turn the behavior off. Desktop only — it's ignored on mobile, where the on-screen keyboard already manages the viewport.

### Nightly word count → Beeminder

Optionally, the plugin can post your daily writing output to a [Beeminder](https://www.beeminder.com) goal every night at **midnight**, as the day closes — like the periodic reviews, it processes the day that just ended, so late-evening writing counts.

Enable it in **Settings → Factotum** and fill in:

- **Auth token** — from `beeminder.com/api/v1/auth_token.json`
- **Username** and **goal name** (the goal slug, e.g. `writing`)

Each night it counts the words in today's daily note, **subtracts the word count of your daily note template** (so boilerplate doesn't inflate the number), and sends the result. The daily note and template are located automatically from your **Daily Notes** or **Periodic Notes** settings; you can override the template path in settings if needed.

If Obsidian wasn't open at midnight, it catches up the next time you launch, walking back up to a week for days with a note. While Obsidian is open, the clock is checked once a minute rather than relying on a single timer — so a laptop that was asleep at midnight submits within a minute of waking, and a submission that fails (no network yet after a wake, say) is retried with backoff instead of waiting for the next launch. Re-sends for the same day update the datapoint rather than duplicating it. Use **Send now** in settings to test your setup.

### Nightly to-do sweep → Inbox

Optionally, the plugin can sweep each day's daily note for the to-dos you wrote into it and drop them under the **`## Inbox`** heading of your TODO note, ready for the next triage. It runs every night at **midnight** on the day that just ended — the same day-close timing as the Beeminder submission and the periodic reviews, so late-evening writing is included — and catches up on the next launch for nights the app was closed (up to a week back, oldest first).

The sweep uses Claude, so it finds to-dos written as prose — *"I need to remember to ask Lauren what I'm authorized to spend"*, *"gotta get an air pump before I can ride the ebike"* — not just checkboxes. Each is rewritten as a short imperative that stands on its own (`- [ ] Buy an air pump for the ebike tires ([[2026-09-12]])`), with a link back to the day it came from. Routine daily intentions (exercise, write, shave), musings, and anything the note shows was already done are left alone, and the whole TODO note is sent along as context so items already captured — in the Inbox, the ranked list, or Done — aren't added twice. A day whose note is still the untouched template costs no API call.

Enable it in **Settings → Factotum → Daily to-do sweep**. It needs the **TODO note path** (top of the settings) and the shared **Anthropic API key**. The daily note is located from your **Daily Notes** or **Periodic Notes** settings, and the template is subtracted the same way the word count does it. **Sweep now** in settings, or the command palette entry

> **Factotum: Sweep today's daily note for to-dos (into the TODO note's Inbox)**

runs it on demand — handy on a phone, where background timers don't fire. A manual sweep works on today's note and doesn't count as the night's sweep, so the midnight run still happens and picks up anything written later; what the manual run already captured is skipped. The link suffix can be turned off in settings.

### Periodic review notes (weekly, monthly, quarterly, yearly, decade, century)

Optionally, the plugin can generate a review note whenever a period closes — **weekly** (just after Sunday midnight), **monthly** (just after midnight on the 1st), **quarterly** (Jan/Apr/Jul/Oct 1), **yearly** (January 1), **decade** (January 1 of years ending in 0), and **century** (January 1 of years ending in 00). Each is enabled independently, reads the just-finished period's **daily notes**, and uses the [Anthropic Claude API](https://www.anthropic.com) to write:

- a prose **`## AI Summary`** of the period, and
- **`## Review Questions`** — one reflective question per goal in your goals note, each as a heading with space to write your answer underneath.

Enable them in **Settings → Factotum**. All reviews share:

- **Anthropic API key** — from [console.anthropic.com](https://console.anthropic.com)
- **Model** — defaults to `claude-opus-4-8` (any Anthropic model id works)

and each has its own:

- **Review folder** — defaults to `Weekly Reviews`, `Monthly Reviews`, `Quarterly Reviews`, `Yearly Reviews`, `Decade Reviews`, `Century Reviews`
- **Header embed** (optional) — a wiki link like `![[goals#goals]]` (the default) whose linked section's text is **copied** into the top of every review, above the summary. Copying, rather than embedding, preserves what your goals were at the time the review was written even as the goals note changes later; blank to omit.
- **Goals source** (optional) — a wiki link like `![[goals#goals]]` whose linked section is read so the review ends with one question per goal; blank to skip the questions.

Notes are named by period — `2026-W23.md`, `2026-06.md`, `2026-Q2.md`, `2026.md`, `2020s.md`, `21st Century.md` — and created automatically in their folder. Daily notes are located from your **Daily Notes** or **Periodic Notes** settings. If Obsidian was closed at the scheduled time (including on mobile, where background timers don't fire), it catches up on the next launch for the most recent period that wasn't yet generated; while it is open, the period boundary is checked once a minute, so a machine that slept through midnight generates within a minute of waking, and a run that fails (network error, API error) is retried with backoff — 5 minutes, doubling to an hour — rather than left until the next launch. An existing review note is never overwritten — a manual re-run writes a numbered sibling instead. Use **Generate now** in settings to test your setup (mid-period it reviews the days so far). Each review also has a **Generate a past review** field: enter any date inside a bygone period — `2019`, `2019-06`, or `2019-06-15` — to build that period's review from the notes of that time (useful for backfilling, e.g. last decade's review from old journals); it never touches the schedule's bookkeeping.

The longer spans handle the model's context window gracefully: when a period's daily notes would exceed the input budget (~150k tokens, estimated at 4 characters per token), the **yearly**, **decade**, and **century** reviews keep as many recent daily notes as fit and consolidate the older remainder into the plugin's own previously generated review notes, coarser the farther back they reach — the oldest weeks become their weekly reviews, then monthly, quarterly, yearly (and, for the century, decade reviews) — read from those reviews' configured folders. A year that runs slightly over might send nine recent months day by day plus a dozen weekly reviews for the spring; a decade reads as yearly reviews at the far end tapering to daily notes at the near end. A consolidated period whose review note doesn't exist drops out of the input, and the note's frontmatter records the mix used (`source: weekly reviews and daily notes`). Weekly, monthly, and quarterly reviews always read daily notes directly.

> Each run makes one Claude API call (typically a few cents; the longer reviews send more input, so they cost more — up to the ~150k-token input budget). The API key and the Beeminder token are kept in Obsidian's keychain (encrypted with the OS keyring, per device, outside the vault) on Obsidian 1.11.4+; older builds fall back to the plugin's `data.json`. Any key found in `data.json` is moved into the keychain on the next load.

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

Once a note has an Inbox or completed items, every save keeps them in a stable layout — Inbox at the top, the ranked list under `## TODO`, Done at the bottom:

```markdown
## Inbox
- something I just thought of

## TODO
- Build the side project
- Learn Spanish

## Done
- [x] Fix the basement
```

A matrix note follows the same shape, with the quadrants nested under `## TODO`:

```markdown
## Inbox
- something I just thought of

## TODO

### Do — Urgent & Important
- [ ] File taxes

### Delegate — Urgent, Not Important
- Book flights

### Schedule — Important, Not Urgent
- Learn Spanish

### Delete — Neither
- Reorganize the sock drawer

## Done
- [x] Fix the basement #urgent
```

Converting between the two never moves the Inbox or Done sections — only the middle changes.

---

## Tips

- You can freely edit the list by hand between sessions — new bullets are picked up automatically next time you run a session or use add-item.
- Data never leaves your machine. Everything is local markdown.
