'use strict';

var obsidian = require('obsidian');

// ── Eisenhower matrix config ────────────────────────────────────────────────

const QUADRANTS = [
    { key: 'Q1', heading: 'Do — Urgent & Important',          urgent: true,  important: true  },
    { key: 'Q3', heading: 'Delegate — Urgent, Not Important', urgent: true,  important: false },
    { key: 'Q2', heading: 'Schedule — Important, Not Urgent', urgent: false, important: true  },
    { key: 'Q4', heading: 'Delete — Neither',                 urgent: false, important: false },
];
const DONE_HEADING = 'Done';
const INBOX_HEADING = 'Inbox';
const TODO_HEADING = 'TODO';

function classifyHeading(text) {
    const t = text.trim().toLowerCase();
    if (/^inbox\b/.test(t)) return 'inbox';
    if (/^todo\b/.test(t)) return 'todo';
    if (/^done\b/.test(t)) return 'done';
    if (/^do\b/.test(t))       return 'Q1';
    if (/^schedule\b/.test(t)) return 'Q2';
    if (/^delegate\b/.test(t)) return 'Q3';
    if (/^delete\b/.test(t))   return 'Q4';
    return null;
}

function emptySections() {
    return { inbox: [], Q1: [], Q2: [], Q3: [], Q4: [], done: [] };
}

function findQuadrant(urgent, important) {
    return QUADRANTS.find(q => q.urgent === urgent && q.important === important);
}

// A task checked off inside a quadrant carries that classification along as
// #urgent / #important tags when it migrates to Done — the metadata survives
// the move and later doubles as calibration when Claude prioritizes the list.
function withDoneTags(text, quadrant) {
    let out = text;
    if (quadrant.urgent && !/(^|\s)#urgent\b/.test(out)) out += ' #urgent';
    if (quadrant.important && !/(^|\s)#important\b/.test(out)) out += ' #important';
    if (!quadrant.urgent && !quadrant.important && !/(^|\s)#(urgent|important|neither)\b/.test(out)) out += ' #neither';
    return out;
}

// ── Markdown parsing / serialization ────────────────────────────────────────

// Markdown (and Obsidian's editor) treats a bullet indented up to three
// spaces as still top-level, so the note can render as a plain list while a
// column-0-only match misses every item. A line belongs to an item's nested
// block only when indented past the item's own bullet; tabs count four wide.
const BULLET_RE = /^( {0,3})[-*+] (.+)$/;

function indentWidth(line) {
    let w = 0;
    for (const ch of line) {
        if (ch === ' ') w += 1;
        else if (ch === '\t') w += 4;
        else break;
    }
    return w;
}

function isNestedLine(line, bulletIndent) {
    return /^\s+\S/.test(line) && indentWidth(line) > bulletIndent;
}

function parseNote(content) {
    const lines = content.split('\n');

    // Detect matrix mode: any heading line that classifies as a quadrant.
    // Inbox, TODO, and Done headings don't make a note a matrix — a flat
    // ranked list has those sections too.
    let matrixMode = false;
    for (const line of lines) {
        const m = line.match(/^#{1,6}\s+(.+)$/);
        const cls = m ? classifyHeading(m[1]) : null;
        if (cls !== null && QUADRANTS.some(q => q.key === cls)) { matrixMode = true; break; }
    }

    if (!matrixMode) {
        const items = [];
        const done  = [];
        const inbox = [];
        let inInbox = false;
        let i = 0;
        while (i < lines.length) {
            const h = lines[i].match(/^#{1,6}\s+(.+)$/);
            if (h) { inInbox = classifyHeading(h[1]) === 'inbox'; i++; continue; }
            const m = lines[i].match(BULLET_RE);
            if (!m) { i++; continue; }
            // A top-level bullet owns the contiguous deeper-indented lines
            // below it (nested bullets, sub-tasks, continuation text). They
            // travel with it as a block so sorting preserves nested structure.
            const indent = m[1].length;
            const children = [];
            let j = i + 1;
            while (j < lines.length && isNestedLine(lines[j], indent)) { children.push(lines[j]); j++; }
            i = j;
            let text = m[2].trim();
            const doneMatch = text.match(/^\[[xX]\]\s+(.+)$/);
            if (doneMatch) { done.push({ text: doneMatch[1], isTask: true, children }); continue; }
            let isTask = false;
            const taskMatch = text.match(/^\[ \]\s+(.+)$/);
            if (taskMatch) { isTask = true; text = taskMatch[1]; }
            (inInbox ? inbox : items).push({ text, isTask, children });
        }
        return { mode: 'flat', items, done, inbox };
    }

    // Matrix mode: bucket items by surrounding heading. Active bullets above
    // the first quadrant heading default to Q2. Done items always go to done.
    const sections = emptySections();
    let section = 'preamble';
    let sawQuadrant = false;
    let lastItem = null;
    let lastIndent = 0;
    const preamble = [];

    for (const line of lines) {
        const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
        if (headingMatch) {
            lastItem = null;
            const cls = classifyHeading(headingMatch[1]);
            if (cls !== null) { section = cls; sawQuadrant = true; continue; }
            if (!sawQuadrant) preamble.push(line);
            continue;
        }

        // Lines indented past a bullet are its nested block — keep them with it.
        if (lastItem && isNestedLine(line, lastIndent)) { lastItem.children.push(line); continue; }

        const bulletMatch = line.match(BULLET_RE);
        if (bulletMatch) {
            lastIndent = bulletMatch[1].length;
            let text = bulletMatch[2].trim();
            const doneMatch = text.match(/^\[[xX]\]\s+(.+)$/);
            if (doneMatch) {
                const quadrant = QUADRANTS.find(q => q.key === section);
                const doneText = quadrant ? withDoneTags(doneMatch[1], quadrant) : doneMatch[1];
                lastItem = { text: doneText, isTask: true, children: [] };
                sections.done.push(lastItem);
                continue;
            }
            let isTask = false;
            const taskMatch = text.match(/^\[ \]\s+(.+)$/);
            if (taskMatch) { isTask = true; text = taskMatch[1]; }
            const bucket = (section === 'preamble' || section === 'todo' || section === 'done') ? 'Q2' : section;
            lastItem = { text, isTask, children: [] };
            sections[bucket].push(lastItem);
            continue;
        }

        lastItem = null;
        if (!sawQuadrant) preamble.push(line);
    }

    return { mode: 'matrix', preamble, sections };
}

function renderItemLine(item) {
    return item.isTask ? `- [ ] ${item.text}` : `- ${item.text}`;
}

// An item plus its nested lines, rendered as a block of lines that move together.
function renderItemBlock(item) {
    const block = [renderItemLine(item)];
    if (item.children && item.children.length) block.push(...item.children);
    return block;
}

// `inboxItems` controls the Inbox section: null leaves its bullets untouched
// (ordinary saves — inbox items are unranked and stay put); an array rewrites
// the section to exactly those items (a triage passes what's still unplaced,
// or [] when everything was placed).
//
// Whatever the note looked like before, the save lands in the canonical
// layout: Inbox at the top, the ranked list under a TODO heading, Done at
// the bottom. Prose outside those sections stays where it was. The TODO
// heading only appears when there's an Inbox section to terminate (or the
// note already had one), and Done only when there are done items to hold
// (or the heading already existed) — a plain list stays a plain list.
function serializeFlat(content, sortedItems, inboxItems = null) {
    const replacements = sortedItems.map(renderItemBlock);

    const lines = content.split('\n');
    const body = [];
    const inboxBlock = [];   // captured contents of the original Inbox section
    const doneBlocks = [];
    let hadInbox = false, hadTodo = false, hadDone = false;
    let firstSortedIdx = -1;
    let lastSortedIdx = -1;
    let inInbox = false;
    let idx = 0;
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const h = line.match(/^#{1,6}\s+(.+)$/);
        if (h) {
            const cls = classifyHeading(h[1]);
            inInbox = cls === 'inbox';
            // Recognized section headings are re-emitted in canonical
            // position below; everything else stays in place.
            if (cls === 'inbox') { hadInbox = true; i++; continue; }
            if (cls === 'todo')  { hadTodo = true;  i++; continue; }
            if (cls === 'done')  { hadDone = true;  i++; continue; }
            body.push(line);
            i++;
        } else if (/^ {0,3}[-*+] \[[xX]\]\s/.test(line)) {
            // Done item: keep its block verbatim and stash it for the Done section.
            const indent = indentWidth(line);
            const block = [line];
            i++;
            while (i < lines.length && isNestedLine(lines[i], indent)) { block.push(lines[i]); i++; }
            doneBlocks.push(block);
        } else if (inInbox) {
            // The Inbox section travels to the top as-is. Its bullets are
            // unranked and don't participate in sorting — unless the caller
            // is rewriting the Inbox, in which case they're replaced.
            if (BULLET_RE.test(line)) {
                const indent = indentWidth(line);
                const block = [line];
                i++;
                while (i < lines.length && isNestedLine(lines[i], indent)) { block.push(lines[i]); i++; }
                if (!inboxItems) inboxBlock.push(...block);
            } else {
                if (line.trim() !== '') inboxBlock.push(line);
                i++;
            }
        } else if (BULLET_RE.test(line)) {
            // Active bullet: swap in the next ranked block, dropping the original
            // nested lines (they ride along inside the replacement block).
            const indent = indentWidth(line);
            i++;
            while (i < lines.length && isNestedLine(lines[i], indent)) i++;
            if (idx < replacements.length) {
                if (firstSortedIdx < 0) firstSortedIdx = body.length;
                body.push(...replacements[idx++]);
                lastSortedIdx = body.length - 1;
            }
        } else {
            body.push(line);
            i++;
        }
    }

    // Ranked items beyond the original bullet slots (a placement added items)
    // go right after the last ranked line.
    if (idx < replacements.length) {
        const extra = replacements.slice(idx).flat();
        const at = lastSortedIdx >= 0 ? lastSortedIdx + 1 : body.length;
        if (firstSortedIdx < 0) firstSortedIdx = at;
        body.splice(at, 0, ...extra);
    }

    // Inbox (and the TODO heading that ends it) land right above the first
    // ranked item, so prose above the list keeps acting as a preamble.
    const newInbox = inboxItems || [];
    const emitInbox = hadInbox || newInbox.length > 0 || inboxBlock.length > 0;
    const head = [];
    if (emitInbox) {
        head.push(`## ${INBOX_HEADING}`);
        for (const item of newInbox) head.push(...renderItemBlock(item));
        head.push(...inboxBlock);
        head.push('');
    }
    if (emitInbox || hadTodo) head.push(`## ${TODO_HEADING}`);
    if (head.length > 0) {
        const at = firstSortedIdx >= 0 ? firstSortedIdx : body.length;
        if (at > 0 && body[at - 1].trim() !== '') head.unshift('');
        body.splice(at, 0, ...head);
    }

    if (hadDone || doneBlocks.length > 0) {
        while (body.length && body[body.length - 1].trim() === '') body.pop();
        body.push('');
        body.push(`## ${DONE_HEADING}`);
        for (const block of doneBlocks) body.push(...block);
    }

    // Extracting headings can leave doubled blank lines behind — collapse them.
    const out = [];
    for (const line of body) {
        if (line.trim() === '' && out.length && out[out.length - 1].trim() === '') continue;
        out.push(line);
    }
    return out.join('\n');
}

// Everything above the first recognized heading, minus top-level bullet
// blocks — those were parsed into sections and re-render below the preamble.
function extractPreamble(lines) {
    const preamble = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^#{1,6}\s+(.+)$/);
        if (m && classifyHeading(m[1]) !== null) break;
        if (BULLET_RE.test(lines[i])) {
            const indent = indentWidth(lines[i]);
            while (i + 1 < lines.length && isNestedLine(lines[i + 1], indent)) i++;
            continue;
        }
        preamble.push(lines[i]);
    }
    while (preamble.length && preamble[preamble.length - 1].trim() === '') preamble.pop();
    return preamble;
}

// Rewrite a matrix note in the canonical layout: preamble, Inbox at the top,
// the four quadrants nested under a TODO heading, Done at the bottom.
function serializeMatrix(originalContent, sections) {
    const lines = originalContent.split('\n');
    let hadInbox = false;
    for (const line of lines) {
        const m = line.match(/^#{1,6}\s+(.+)$/);
        if (m && classifyHeading(m[1]) === 'inbox') { hadInbox = true; break; }
    }
    const preamble = extractPreamble(lines);

    const out = [];
    if (preamble.length > 0) { out.push(...preamble); out.push(''); }

    const inboxItems = sections.inbox || [];
    // Keep the (possibly emptied) Inbox heading around as a capture spot.
    if (hadInbox || inboxItems.length > 0) {
        out.push(`## ${INBOX_HEADING}`);
        for (const item of inboxItems) out.push(...renderItemBlock(item));
        out.push('');
    }

    out.push(`## ${TODO_HEADING}`);
    out.push('');
    for (const q of QUADRANTS) {
        out.push(`### ${q.heading}`);
        for (const item of sections[q.key]) out.push(...renderItemBlock(item));
        out.push('');
    }

    out.push(`## ${DONE_HEADING}`);
    for (const item of sections.done) {
        out.push(`- [x] ${item.text}`);
        if (item.children && item.children.length) out.push(...item.children);
    }

    return out.join('\n');
}

// The inverse of serializeMatrix: flatten a matrix note back into a single
// ranked list, in the same canonical layout — Inbox still at the top, the
// list under TODO, Done still at the bottom. Quadrant order becomes list
// order — Do, then Delegate, then Schedule, then Delete — with each
// quadrant's internal ranking intact. Done items keep their checkboxes (and
// the #urgent/#important tags they picked up in the matrix, so the
// classification survives a round-trip).
function serializeFlatFromMatrix(originalContent, sections) {
    const lines = originalContent.split('\n');
    let hadInbox = false, hadTodo = false;
    for (const line of lines) {
        const m = line.match(/^#{1,6}\s+(.+)$/);
        const cls = m ? classifyHeading(m[1]) : null;
        if (cls === 'inbox') hadInbox = true;
        if (cls === 'todo') hadTodo = true;
    }
    const preamble = extractPreamble(lines);

    const out = [];
    if (preamble.length > 0) { out.push(...preamble); out.push(''); }

    const inboxItems = sections.inbox || [];
    const emitInbox = hadInbox || inboxItems.length > 0;
    if (emitInbox) {
        out.push(`## ${INBOX_HEADING}`);
        for (const item of inboxItems) out.push(...renderItemBlock(item));
        out.push('');
    }
    if (emitInbox || hadTodo) out.push(`## ${TODO_HEADING}`);

    for (const q of QUADRANTS) {
        for (const item of sections[q.key]) out.push(...renderItemBlock(item));
    }

    out.push('');
    out.push(`## ${DONE_HEADING}`);
    for (const item of sections.done) {
        out.push(`- [x] ${item.text}`);
        if (item.children && item.children.length) out.push(...item.children);
    }

    return out.join('\n');
}

// A one-line footer telling the user that closing the modal doesn't lose work.
function closeHint(contentEl, text) {
    contentEl.createEl('p', { text, cls: 'ordinal-hint ordinal-close-hint' });
}

// ── Pairwise ranking session (interactive merge sort) ───────────────────────

class RankSessionModal extends obsidian.Modal {
    constructor(app, payload, onComplete) {
        super(app);
        this.payload = payload;
        this.onComplete = onComplete;
        this.comparisonCount = 0;
        // Partial-progress state, so closing mid-session saves what's decided.
        this.finished = false;      // a result was already handed to onComplete
        this.finalResult = null;    // full result shown on the results screen
        this.sortState = null;      // flat mode: live view into the merge sort
        this.matrixOut = null;      // matrix mode: quadrants re-filled so far
        this.entries = [];          // matrix mode: every active item with its current quadrant
        this.entryIdx = 0;

        if (payload.mode === 'flat') {
            const n = Math.max(payload.items.length, 2);
            this.estimatedTotal = n * Math.ceil(Math.log2(n));
        } else {
            let total = 0;
            for (const q of QUADRANTS) total += payload.sections[q.key].length;
            this.estimatedTotal = Math.max(total * 2, 1);
        }
    }

    onOpen() {
        this.modalEl.addClass('ordinal-modal');
        this.run();
    }

    // Closing mid-session keeps every decision made so far: in a flat note
    // completed merges stay ordered; in a matrix note items already
    // re-classified keep their new quadrant. Whatever wasn't reached keeps
    // its current place. Zero answers → nothing to save.
    onClose() {
        this.contentEl.empty();
        if (this.finished) return;
        const result = this.finalResult ||
            (this.comparisonCount > 0 ? this.buildPartialResult() : null);
        if (!result) return;
        this.finished = true;
        this.onComplete(result, !this.finalResult);
    }

    async run() {
        if (this.payload.mode === 'flat') {
            if (this.payload.items.length < 2) {
                this.renderResults({ mode: 'flat', items: this.payload.items });
                return;
            }
            const sorted = await this.mergeSort(this.payload.items);
            this.renderResults({ mode: 'flat', items: sorted });
            return;
        }

        // Matrix mode: no within-quadrant comparisons — the quadrant is the
        // rank. Walk every active item and re-classify it (urgent?
        // important?), keeping encounter order inside each quadrant.
        const out = emptySections();
        out.done = this.payload.sections.done;
        out.inbox = this.payload.sections.inbox;
        this.matrixOut = out;
        for (const q of QUADRANTS) {
            for (const item of this.payload.sections[q.key]) this.entries.push({ item, from: q });
        }
        for (this.entryIdx = 0; this.entryIdx < this.entries.length; this.entryIdx++) {
            const { item } = this.entries[this.entryIdx];
            const urgent = await this.askClassify(item, 'Must it get done this week?',
                'If so, it\'s urgent.',
                'Yes, urgent', 'No, not urgent');
            const important = await this.askClassify(item, 'If you never did it, would you die?',
                'If so, it\'s important.',
                'Yes, important', 'No, not important');
            out[findQuadrant(urgent, important).key].push(item);
        }
        this.renderResults({ mode: 'matrix', sections: out });
    }

    // Bottom-up merge sort so an interrupted session has usable state: runs
    // already merged this pass, the merge in flight, and runs not yet reached.
    async mergeSort(arr) {
        let runs = arr.map(x => [x]);
        while (runs.length > 1) {
            const next = [];
            for (let i = 0; i < runs.length; i += 2) {
                this.sortState = { done: next, pending: runs.slice(i), inflight: null };
                if (i + 1 === runs.length) { next.push(runs[i]); continue; }
                next.push(await this.merge(runs[i], runs[i + 1]));
            }
            runs = next;
        }
        this.sortState = null;
        return runs[0];
    }

    async merge(left, right) {
        const result = [];
        let i = 0, j = 0;
        const inflight = { result, left, right, i: 0, j: 0 };
        if (this.sortState) this.sortState.inflight = inflight;
        while (i < left.length && j < right.length) {
            const leftWins = await this.askCompare(left[i], right[j]);
            if (leftWins) result.push(left[i++]);
            else result.push(right[j++]);
            inflight.i = i;
            inflight.j = j;
        }
        while (i < left.length) result.push(left[i++]);
        while (j < right.length) result.push(right[j++]);
        return result;
    }

    // The best full ordering an interrupted sort supports: merged runs first,
    // then the in-flight merge (its merged prefix plus both unmerged tails),
    // then untouched runs. Every item appears exactly once.
    bestEffortSorted() {
        const s = this.sortState;
        if (!s) return null;
        const out = s.done.flat();
        if (s.inflight) {
            out.push(...s.inflight.result);
            out.push(...s.inflight.left.slice(s.inflight.i));
            out.push(...s.inflight.right.slice(s.inflight.j));
            out.push(...s.pending.slice(2).flat());
        } else {
            out.push(...s.pending.flat());
        }
        return out;
    }

    buildPartialResult() {
        if (this.payload.mode === 'flat') {
            const items = this.bestEffortSorted();
            return items ? { mode: 'flat', items } : null;
        }
        if (!this.matrixOut) return null;
        const sections = emptySections();
        sections.done = this.payload.sections.done;
        sections.inbox = this.payload.sections.inbox;
        for (const q of QUADRANTS) sections[q.key] = [...this.matrixOut[q.key]];
        // Items not yet fully re-classified (including the one on screen)
        // keep their current quadrant.
        for (let i = this.entryIdx; i < this.entries.length; i++) {
            sections[this.entries[i].from.key].push(this.entries[i].item);
        }
        return { mode: 'matrix', sections };
    }

    askCompare(a, b) {
        return new Promise(resolve => {
            this.comparisonCount++;
            this.renderComparison(a, b, resolve);
        });
    }

    askClassify(item, question, explainer, yesLabel, noLabel) {
        return new Promise(resolve => {
            this.comparisonCount++;
            this.renderClassify(item, question, explainer, yesLabel, noLabel, resolve);
        });
    }

    renderClassify(item, question, explainer, yesLabel, noLabel, resolve) {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createDiv({
            cls: 'ordinal-quadrant-label',
            text: `Item ${this.entryIdx + 1} of ${this.entries.length}`,
        });
        contentEl.createEl('h2', { text: item.text });
        contentEl.createEl('p', { text: `${question} ${explainer}`, cls: 'ordinal-hint' });

        this.renderProgress(contentEl);

        const grid = contentEl.createDiv({ cls: 'ordinal-grid' });
        const yes = grid.createEl('button', { text: yesLabel, cls: 'ordinal-choice' });
        grid.createDiv({ cls: 'ordinal-vs', text: '/' });
        const no  = grid.createEl('button', { text: noLabel, cls: 'ordinal-choice' });
        yes.addEventListener('click', () => resolve(true));
        no .addEventListener('click', () => resolve(false));

        closeHint(contentEl, 'Close anytime — items classified so far are saved.');
    }

    renderProgress(contentEl) {
        const prog = contentEl.createDiv({ cls: 'ordinal-progress' });
        const fill = prog.createDiv({ cls: 'ordinal-progress-fill' });
        const pct = Math.min(100, (this.comparisonCount / this.estimatedTotal) * 100);
        fill.style.width = `${pct}%`;
        prog.createDiv({
            cls: 'ordinal-progress-label',
            text: `${this.comparisonCount} / ~${this.estimatedTotal}`
        });
    }

    renderComparison(a, b, resolve) {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Which matters more to you?' });

        this.renderProgress(contentEl);

        const grid = contentEl.createDiv({ cls: 'ordinal-grid' });
        const btnA = grid.createEl('button', { text: a.text, cls: 'ordinal-choice' });
        grid.createDiv({ cls: 'ordinal-vs', text: 'VS' });
        const btnB = grid.createEl('button', { text: b.text, cls: 'ordinal-choice' });

        btnA.addEventListener('click', () => resolve(true));
        btnB.addEventListener('click', () => resolve(false));

        const skipBtn = contentEl.createEl('button', {
            text: 'Skip (treat as equal)',
            cls: 'ordinal-skip'
        });
        skipBtn.addEventListener('click', () => resolve(true));

        closeHint(contentEl, 'Close anytime — comparisons made so far are saved.');
    }

    renderResults(result) {
        this.finalResult = result;
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', {
            text: result.mode === 'flat' ? '🏆 Ranking Complete' : '🏆 Classification Complete'
        });

        if (result.mode === 'flat') {
            const ol = contentEl.createEl('ol', { cls: 'ordinal-results-list' });
            for (const item of result.items) {
                ol.createEl('li').createSpan({ text: item.text });
            }
        } else {
            for (const q of QUADRANTS) {
                contentEl.createEl('h3', { text: q.heading, cls: 'ordinal-quadrant-header' });
                const items = result.sections[q.key];
                if (items.length === 0) {
                    contentEl.createEl('p', { text: '(empty)', cls: 'ordinal-hint' });
                } else {
                    const ol = contentEl.createEl('ol', { cls: 'ordinal-results-list' });
                    for (const item of items) ol.createEl('li').createSpan({ text: item.text });
                }
            }
        }

        const saveBtn = contentEl.createEl('button', {
            text: '💾 Save to note',
            cls: 'ordinal-save-btn'
        });
        saveBtn.addEventListener('click', () => {
            this.finished = true;
            this.onComplete(result);
            this.close();
        });
    }
}

// ── Add new item modal (binary-search placement) ───────────────────────────

class AddItemModal extends obsidian.Modal {
    constructor(app, payload, onComplete) {
        super(app);
        this.payload = payload;
        this.onComplete = onComplete;
        this.newItem = { text: '', isTask: true };
        this.urgent = null;
        this.targetQuadrant = null;
        this.sorted = [];
        this.lo = 0;
        this.hi = 0;
        this.finished = false;
        this.searchStarted = false;
        this.pendingResult = null;  // final result awaiting the save button
    }

    onOpen() {
        this.modalEl.addClass('ordinal-modal');
        this.renderInput();
    }

    // Closing mid-placement still saves the item as best we can: at the final
    // screen the exact result; mid-search the midpoint of the range the
    // answers so far allow; before classification (matrix) into the Inbox.
    onClose() {
        this.contentEl.empty();
        if (this.finished) return;
        let result = this.pendingResult;
        let partial = false;
        if (!result && this.newItem.text) {
            partial = true;
            if (this.searchStarted) {
                const pos = Math.min(
                    Math.max(Math.floor((this.lo + this.hi + 1) / 2), 0),
                    this.sorted.length
                );
                const items = [...this.sorted];
                items.splice(pos, 0, this.newItem);
                result = this.payload.mode === 'flat'
                    ? { mode: 'flat', items }
                    : { mode: 'matrix', sections: this.sectionsWith(this.targetQuadrant.key, items) };
            } else if (this.payload.mode === 'matrix') {
                const inbox = [...this.payload.sections.inbox, this.newItem];
                result = { mode: 'matrix', sections: this.sectionsWith('inbox', inbox) };
            }
        }
        if (!result) return;
        this.finished = true;
        this.onComplete(result, partial);
    }

    // A copy of the payload's sections with one of them replaced.
    sectionsWith(key, items) {
        const sections = {};
        for (const k of Object.keys(this.payload.sections)) {
            sections[k] = [...this.payload.sections[k]];
        }
        sections[key] = items;
        return sections;
    }

    renderInput() {
        const { contentEl } = this;
        contentEl.empty();

        const input = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'What do you want to do?'
        });
        input.addClass('ordinal-text-input');

        const btn = contentEl.createEl('button', {
            text: this.payload.mode === 'flat' ? 'Start placing →' : 'Next: classify →',
            cls: 'ordinal-save-btn'
        });

        if (this.payload.mode === 'flat') {
            const n = this.payload.items.length;
            const stepCount = Math.ceil(Math.log2(n + 1));
            contentEl.createEl('p', {
                text: `It will be placed in your ranked list of ${n} items using binary search — only ~${stepCount} comparison${stepCount === 1 ? '' : 's'} needed.`,
                cls: 'ordinal-hint'
            });
        } else {
            contentEl.createEl('p', {
                text: 'After naming, you\'ll classify it into an Eisenhower quadrant (urgent? important?) — it lands at the end of that quadrant.',
                cls: 'ordinal-hint'
            });
        }

        input.focus();

        const go = () => {
            const val = input.value.trim();
            if (!val) return;
            this.newItem.text = val;
            if (this.payload.mode === 'flat') this.startFlat();
            else this.askUrgent();
        };

        btn.addEventListener('click', go);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    }

    askUrgent() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: `"${this.newItem.text}"` });
        contentEl.createEl('h2', { text: 'Must it get done this week?' });
        contentEl.createEl('p', {
            text: 'If so, it\'s urgent.',
            cls: 'ordinal-hint'
        });
        closeHint(contentEl, 'Close anytime — the item is captured in the Inbox.');

        const grid = contentEl.createDiv({ cls: 'ordinal-grid' });
        const yes = grid.createEl('button', { text: 'Yes, urgent', cls: 'ordinal-choice' });
        grid.createDiv({ cls: 'ordinal-vs', text: '/' });
        const no  = grid.createEl('button', { text: 'No, not urgent', cls: 'ordinal-choice' });
        yes.addEventListener('click', () => { this.urgent = true;  this.askImportant(); });
        no .addEventListener('click', () => { this.urgent = false; this.askImportant(); });
    }

    askImportant() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: `"${this.newItem.text}"` });
        contentEl.createEl('h2', { text: 'If you never did it, would you die?' });
        contentEl.createEl('p', {
            text: 'If so, it\'s important.',
            cls: 'ordinal-hint'
        });
        closeHint(contentEl, 'Close anytime — the item is captured in the Inbox.');

        const grid = contentEl.createDiv({ cls: 'ordinal-grid' });
        const yes = grid.createEl('button', { text: 'Yes, important', cls: 'ordinal-choice' });
        grid.createDiv({ cls: 'ordinal-vs', text: '/' });
        const no  = grid.createEl('button', { text: 'No, not important', cls: 'ordinal-choice' });
        yes.addEventListener('click', () => this.startMatrix(true));
        no .addEventListener('click', () => this.startMatrix(false));
    }

    startFlat() {
        this.sorted = [...this.payload.items];
        this.searchStarted = true;
        this.lo = 0;
        this.hi = this.sorted.length - 1;
        if (this.sorted.length === 0) this.finish(0);
        else this.renderCompare();
    }

    startMatrix(important) {
        // No within-quadrant comparisons in a matrix — the quadrant is the
        // rank, so the item simply lands at the end of its quadrant.
        const q = findQuadrant(this.urgent, important);
        this.targetQuadrant = q;
        this.sorted = [...this.payload.sections[q.key]];
        this.finish(this.sorted.length);
    }

    renderCompare() {
        if (this.lo > this.hi) { this.finish(this.lo); return; }

        const mid     = Math.floor((this.lo + this.hi) / 2);
        const against = this.sorted[mid];
        const steps   = Math.max(1, Math.ceil(Math.log2(this.sorted.length + 1)));
        const current = steps - Math.ceil(Math.log2(this.hi - this.lo + 2));

        const { contentEl } = this;
        contentEl.empty();

        if (this.targetQuadrant) {
            contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: this.targetQuadrant.heading });
        }
        contentEl.createEl('h2', { text: 'Which matters more?' });

        const prog = contentEl.createDiv({ cls: 'ordinal-progress' });
        const fill = prog.createDiv({ cls: 'ordinal-progress-fill' });
        fill.style.width = `${(current / steps) * 100}%`;
        prog.createDiv({
            cls: 'ordinal-progress-label',
            text: `Comparison ${current + 1} of ~${steps}`
        });

        const grid = contentEl.createDiv({ cls: 'ordinal-grid' });
        const btnNew = grid.createEl('button', { text: this.newItem.text, cls: 'ordinal-choice ordinal-new' });
        grid.createDiv({ cls: 'ordinal-vs', text: 'VS' });
        const btnOld = grid.createEl('button', { text: against.text, cls: 'ordinal-choice' });

        btnNew.addEventListener('click', () => { this.hi = mid - 1; this.renderCompare(); });
        btnOld.addEventListener('click', () => { this.lo = mid + 1; this.renderCompare(); });

        closeHint(contentEl, 'Close anytime — the item is saved at its best-known spot.');
    }

    finish(insertPosition) {
        const placedQuadrant = this.targetQuadrant;
        const sortedWithNew = [...this.sorted];
        sortedWithNew.splice(insertPosition, 0, this.newItem);
        const rank = insertPosition + 1;

        this.pendingResult = this.payload.mode === 'flat'
            ? { mode: 'flat', items: sortedWithNew }
            : { mode: 'matrix', sections: this.sectionsWith(placedQuadrant.key, sortedWithNew) };

        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '✓ Item Placed!' });
        const summary = placedQuadrant
            ? `"${this.newItem.text}" was added to ${placedQuadrant.heading}`
            : `"${this.newItem.text}" is ranked #${rank} out of ${sortedWithNew.length}`;
        contentEl.createEl('p', { text: summary, cls: 'ordinal-hint' });

        const ol = contentEl.createEl('ol', { cls: 'ordinal-results-list' });
        for (const item of sortedWithNew) {
            const li = ol.createEl('li');
            if (item === this.newItem) {
                li.addClass('ordinal-new-highlight');
                li.createSpan({ text: `★ ${item.text}` });
            } else {
                li.createSpan({ text: item.text });
            }
        }

        const saveBtn = contentEl.createEl('button', {
            text: '💾 Save to note',
            cls: 'ordinal-save-btn'
        });
        saveBtn.addEventListener('click', () => {
            this.finished = true;
            this.onComplete(this.pendingResult);
            this.close();
        });
    }
}

// ── Triage inbox: classify & place each unprioritized item ──────────────────

class TriageInboxModal extends obsidian.Modal {
    constructor(app, payload, onComplete) {
        super(app);
        this.payload = payload;
        this.onComplete = onComplete;
        if (payload.mode === 'flat') {
            this.queue = [...payload.inbox];
            this.items = [...payload.items];
        } else {
            this.queue = [...payload.sections.inbox];
            this.sections = {};
            for (const key of Object.keys(payload.sections)) {
                this.sections[key] = [...payload.sections[key]];
            }
            this.sections.inbox = [];
        }
        this.idx = 0;
        this.placed = new Set();
        this.finished = false;
        this.urgent = null;
        this.targetQuadrant = null;
        // Binary-search placement state for the current item.
        this.list = null;
        this.lo = 0;
        this.hi = 0;
        // Progress: a matrix item takes 2 classification answers; a flat item
        // takes ~log2 comparisons against a list that grows as items land.
        this.decisionCount = 0;
        if (payload.mode === 'flat') {
            let total = 0;
            for (let k = 0; k < this.queue.length; k++) {
                total += Math.ceil(Math.log2(this.items.length + k + 1));
            }
            this.estimatedTotal = Math.max(total, 1);
        } else {
            this.estimatedTotal = Math.max(this.queue.length * 2, 1);
        }
    }

    onOpen() {
        this.modalEl.addClass('ordinal-modal');
        this.nextItem();
    }

    // Closing mid-triage keeps every fully placed item; the current item and
    // anything not yet reached stay in the Inbox for a later session.
    onClose() {
        this.contentEl.empty();
        if (this.finished) return;
        if (this.placed.size === 0) return;
        this.finished = true;
        const remaining = this.queue.slice(this.idx);
        if (this.payload.mode === 'flat') {
            this.onComplete({ mode: 'flat', items: this.items, inbox: remaining }, true);
        } else {
            this.onComplete({ mode: 'matrix', sections: { ...this.sections, inbox: remaining } }, true);
        }
    }

    current() { return this.queue[this.idx]; }
    progressLabel() { return `Inbox item ${this.idx + 1} of ${this.queue.length}`; }

    renderProgress(contentEl) {
        const prog = contentEl.createDiv({ cls: 'ordinal-progress' });
        const fill = prog.createDiv({ cls: 'ordinal-progress-fill' });
        const pct = Math.min(100, (this.decisionCount / this.estimatedTotal) * 100);
        fill.style.width = `${pct}%`;
        prog.createDiv({
            cls: 'ordinal-progress-label',
            text: `${this.decisionCount} / ~${this.estimatedTotal}`
        });
    }

    nextItem() {
        if (this.idx >= this.queue.length) { this.renderResults(); return; }
        if (this.payload.mode === 'flat') {
            this.targetQuadrant = null;
            this.startPlacement(this.items);
        } else {
            this.askUrgent();
        }
    }

    askUrgent() {
        const item = this.current();
        const { contentEl } = this;
        contentEl.empty();
        this.decisionCount++;
        contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: this.progressLabel() });
        contentEl.createEl('h2', { text: item.text });
        contentEl.createEl('p', { text: 'Must it get done this week?', cls: 'ordinal-hint' });
        this.renderProgress(contentEl);

        const grid = contentEl.createDiv({ cls: 'ordinal-grid' });
        const yes = grid.createEl('button', { text: 'Yes, urgent', cls: 'ordinal-choice' });
        grid.createDiv({ cls: 'ordinal-vs', text: '/' });
        const no  = grid.createEl('button', { text: 'No, not urgent', cls: 'ordinal-choice' });
        yes.addEventListener('click', () => { this.urgent = true;  this.askImportant(); });
        no .addEventListener('click', () => { this.urgent = false; this.askImportant(); });

        closeHint(contentEl, 'Close anytime — placed items are saved; the rest stay in the Inbox.');
    }

    askImportant() {
        const item = this.current();
        const { contentEl } = this;
        contentEl.empty();
        this.decisionCount++;
        contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: this.progressLabel() });
        contentEl.createEl('h2', { text: item.text });
        contentEl.createEl('p', { text: 'If you never did it, would you die?', cls: 'ordinal-hint' });
        this.renderProgress(contentEl);

        const grid = contentEl.createDiv({ cls: 'ordinal-grid' });
        const yes = grid.createEl('button', { text: 'Yes, important', cls: 'ordinal-choice' });
        grid.createDiv({ cls: 'ordinal-vs', text: '/' });
        const no  = grid.createEl('button', { text: 'No, not important', cls: 'ordinal-choice' });
        yes.addEventListener('click', () => this.classify(true));
        no .addEventListener('click', () => this.classify(false));

        closeHint(contentEl, 'Close anytime — placed items are saved; the rest stay in the Inbox.');
    }

    classify(important) {
        // No within-quadrant comparisons in a matrix — the item lands at the
        // end of its quadrant.
        this.targetQuadrant = findQuadrant(this.urgent, important);
        this.list = this.sections[this.targetQuadrant.key];
        this.place(this.list.length);
    }

    // Binary-search the current item into `list` (mutated in place), so later
    // inbox items are also compared against the ones placed before them.
    startPlacement(list) {
        this.list = list;
        this.lo = 0;
        this.hi = list.length - 1;
        this.renderCompare();
    }

    renderCompare() {
        if (this.lo > this.hi) { this.place(this.lo); return; }

        const mid     = Math.floor((this.lo + this.hi) / 2);
        const against = this.list[mid];
        const item    = this.current();

        const { contentEl } = this;
        contentEl.empty();
        this.decisionCount++;

        contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: this.progressLabel() });
        if (this.targetQuadrant) {
            contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: this.targetQuadrant.heading });
        }
        contentEl.createEl('h2', { text: 'Which matters more?' });
        this.renderProgress(contentEl);

        const grid = contentEl.createDiv({ cls: 'ordinal-grid' });
        const btnNew = grid.createEl('button', { text: item.text, cls: 'ordinal-choice ordinal-new' });
        grid.createDiv({ cls: 'ordinal-vs', text: 'VS' });
        const btnOld = grid.createEl('button', { text: against.text, cls: 'ordinal-choice' });

        btnNew.addEventListener('click', () => { this.hi = mid - 1; this.renderCompare(); });
        btnOld.addEventListener('click', () => { this.lo = mid + 1; this.renderCompare(); });

        closeHint(contentEl, 'Close anytime — placed items are saved; the rest stay in the Inbox.');
    }

    place(insertPosition) {
        const item = this.current();
        this.list.splice(insertPosition, 0, item);
        this.placed.add(item);
        this.idx++;
        this.nextItem();
    }

    renderResults() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '✓ Inbox Triaged' });
        contentEl.createEl('p', {
            text: `${this.queue.length} item${this.queue.length === 1 ? '' : 's'} placed (★). The Inbox will be emptied.`,
            cls: 'ordinal-hint'
        });

        const renderList = (parent, items) => {
            const ol = parent.createEl('ol', { cls: 'ordinal-results-list' });
            for (const item of items) {
                const li = ol.createEl('li');
                if (this.placed.has(item)) {
                    li.addClass('ordinal-new-highlight');
                    li.createSpan({ text: `★ ${item.text}` });
                } else {
                    li.createSpan({ text: item.text });
                }
            }
        };

        if (this.payload.mode === 'flat') {
            renderList(contentEl, this.items);
        } else {
            for (const q of QUADRANTS) {
                contentEl.createEl('h3', { text: q.heading, cls: 'ordinal-quadrant-header' });
                const items = this.sections[q.key];
                if (items.length === 0) {
                    contentEl.createEl('p', { text: '(empty)', cls: 'ordinal-hint' });
                } else {
                    renderList(contentEl, items);
                }
            }
        }

        const saveBtn = contentEl.createEl('button', {
            text: '💾 Save to note',
            cls: 'ordinal-save-btn'
        });
        saveBtn.addEventListener('click', () => {
            this.finished = true;
            if (this.payload.mode === 'flat') {
                this.onComplete({ mode: 'flat', items: this.items, inbox: [] });
            } else {
                this.onComplete({ mode: 'matrix', sections: this.sections });
            }
            this.close();
        });
    }
}

// ── Convert flat list → Eisenhower matrix ───────────────────────────────────

class ConvertModal extends obsidian.Modal {
    constructor(app, flatPayload, onComplete) {
        super(app);
        this.items = flatPayload.items;
        this.doneItems = flatPayload.done;
        this.onComplete = onComplete;
        this.idx = 0;
        this.urgent = null;
        this.finished = false;
        this.classified = emptySections();
        this.classified.done = this.doneItems;
        this.classified.inbox = flatPayload.inbox || [];
    }

    onOpen() {
        this.modalEl.addClass('ordinal-modal');
        if (this.items.length === 0) this.renderResults();
        else this.askUrgent();
    }

    // Closing mid-conversion keeps the classifications made so far; items not
    // yet classified land in the Inbox to be triaged later.
    onClose() {
        this.contentEl.empty();
        if (this.finished) return;
        if (this.idx === 0) return;
        this.finished = true;
        const sections = {
            ...this.classified,
            inbox: [...this.classified.inbox, ...this.items.slice(this.idx)],
        };
        this.onComplete({ mode: 'matrix', sections }, this.idx < this.items.length);
    }

    askUrgent() {
        const item = this.items[this.idx];
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: `Item ${this.idx + 1} of ${this.items.length}` });
        contentEl.createEl('h2', { text: item.text });
        contentEl.createEl('p', { text: 'Must it get done this week?', cls: 'ordinal-hint' });

        const grid = contentEl.createDiv({ cls: 'ordinal-grid' });
        const yes = grid.createEl('button', { text: 'Yes, urgent', cls: 'ordinal-choice' });
        grid.createDiv({ cls: 'ordinal-vs', text: '/' });
        const no  = grid.createEl('button', { text: 'No, not urgent', cls: 'ordinal-choice' });
        yes.addEventListener('click', () => { this.urgent = true;  this.askImportant(); });
        no .addEventListener('click', () => { this.urgent = false; this.askImportant(); });

        closeHint(contentEl, 'Close anytime — classified items are saved; the rest go to the Inbox.');
    }

    askImportant() {
        const item = this.items[this.idx];
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: `Item ${this.idx + 1} of ${this.items.length}` });
        contentEl.createEl('h2', { text: item.text });
        contentEl.createEl('p', { text: 'If you never did it, would you die?', cls: 'ordinal-hint' });

        const grid = contentEl.createDiv({ cls: 'ordinal-grid' });
        const yes = grid.createEl('button', { text: 'Yes, important', cls: 'ordinal-choice' });
        grid.createDiv({ cls: 'ordinal-vs', text: '/' });
        const no  = grid.createEl('button', { text: 'No, not important', cls: 'ordinal-choice' });
        yes.addEventListener('click', () => this.place(true));
        no .addEventListener('click', () => this.place(false));

        closeHint(contentEl, 'Close anytime — classified items are saved; the rest go to the Inbox.');
    }

    place(important) {
        const q = findQuadrant(this.urgent, important);
        this.classified[q.key].push(this.items[this.idx]);
        this.idx++;
        if (this.idx >= this.items.length) this.renderResults();
        else this.askUrgent();
    }

    renderResults() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '✓ Classified!' });
        contentEl.createEl('p', {
            text: 'Note will be rewritten with the four Eisenhower headings. Order within each quadrant is unchanged.',
            cls: 'ordinal-hint'
        });

        for (const q of QUADRANTS) {
            contentEl.createEl('h3', { text: q.heading, cls: 'ordinal-quadrant-header' });
            const items = this.classified[q.key];
            if (items.length === 0) {
                contentEl.createEl('p', { text: '(empty)', cls: 'ordinal-hint' });
            } else {
                const ol = contentEl.createEl('ol', { cls: 'ordinal-results-list' });
                for (const item of items) ol.createEl('li').createSpan({ text: item.text });
            }
        }

        const saveBtn = contentEl.createEl('button', { text: '💾 Save to note', cls: 'ordinal-save-btn' });
        saveBtn.addEventListener('click', () => {
            this.finished = true;
            this.onComplete({ mode: 'matrix', sections: this.classified });
            this.close();
        });
    }
}

// ── Claude prioritization: classify & rank the whole list in one shot ───────

class ClaudePrioritizeModal extends obsidian.Modal {
    constructor(app, payload, anthropic, onComplete) {
        super(app);
        this.payload = payload;
        this.anthropic = anthropic;
        this.onComplete = onComplete;
        this.finished = false;

        // Every active item (quadrants or ranked list, plus the Inbox),
        // numbered so Claude can answer with indices instead of echoing text.
        this.entries = [];
        if (payload.mode === 'flat') {
            for (const item of payload.items) this.entries.push({ item, context: 'ranked list' });
            for (const item of payload.inbox) this.entries.push({ item, context: 'Inbox (unprioritized)' });
            this.doneItems = payload.done;
        } else {
            for (const q of QUADRANTS) {
                for (const item of payload.sections[q.key]) this.entries.push({ item, context: q.heading });
            }
            for (const item of payload.sections.inbox) this.entries.push({ item, context: 'Inbox (unprioritized)' });
            this.doneItems = payload.sections.done;
        }
    }

    onOpen() {
        this.modalEl.addClass('ordinal-modal');
        this.renderLoading();
        this.run();
    }
    // Nothing is written unless the proposal is explicitly saved — closing
    // discards it (unlike the interactive sessions, no user decisions are lost).
    onClose() { this.contentEl.empty(); }

    renderLoading() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '🤖 Asking Claude…' });
        contentEl.createEl('p', {
            text: `Sending ${this.entries.length} items to ${this.anthropic.model} to classify into Eisenhower quadrants and rank by priority.`,
            cls: 'ordinal-hint'
        });
        closeHint(contentEl, 'Close to cancel — nothing is written without your OK.');
    }

    renderError(message) {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Something went wrong' });
        contentEl.createEl('p', { text: message, cls: 'ordinal-hint' });
        const retry = contentEl.createEl('button', { text: 'Retry', cls: 'ordinal-save-btn' });
        retry.addEventListener('click', () => { this.renderLoading(); this.run(); });
    }

    buildPrompt() {
        const system =
            'You are prioritizing a personal TODO list into an Eisenhower matrix. Quadrants: ' +
            'Q1 = Do (urgent & important), Q2 = Schedule (important, not urgent), ' +
            'Q3 = Delegate (urgent, not important), Q4 = Delete (neither urgent nor important). ' +
            'You will receive a numbered list of tasks. Assign EVERY task number to exactly one quadrant ' +
            'and order each quadrant from highest to lowest priority. ' +
            'Each task may note where it currently sits — treat that as a mild prior, not a constraint. ' +
            'If completed tasks are provided (newest first), their #urgent/#important tags show how the user ' +
            'tends to classify similar work (#neither = neither urgent nor important; a completed task ' +
            'with no tags was never classified, so read nothing into it). ' +
            'Respond with ONLY a JSON object of the form {"Q1":[3,0],"Q2":[2],"Q3":[],"Q4":[1]} — ' +
            'no prose, no code fences. Every input number must appear exactly once across the four arrays.';

        const taskLines = this.entries.map((e, i) => {
            let s = `${i}. ${e.item.text} (currently: ${e.context})`;
            for (const child of e.item.children || []) s += `\n${child}`;
            return s;
        });
        let user = `Tasks to prioritize:\n\n${taskLines.join('\n')}`;
        // The whole Done section, newest first — that's the order the note
        // keeps it in, since a freshly checked item lands at the head.
        if (this.doneItems.length > 0) {
            user += `\n\nCompleted tasks, newest first (for calibration only — do not include these numbers):\n` +
                this.doneItems.map(d => `- ${d.text}`).join('\n');
        }
        return { system, user };
    }

    async run() {
        const { system, user } = this.buildPrompt();
        let res;
        try {
            res = await callClaude(this.anthropic.apiKey, this.anthropic.model, system, user);
        } catch (e) {
            console.error('Factotum — Claude request failed', e);
            this.renderError('Claude could not be reached (network error).');
            return;
        }
        if (!res.ok) {
            console.error('Factotum — Claude API error', res.status);
            this.renderError(`Claude API error (HTTP ${res.status}).`);
            return;
        }
        const sections = this.parseAssignment(res.text);
        if (!sections) {
            console.error('Factotum — unparseable Claude response', res.text);
            this.renderError('Claude returned a response that couldn\'t be parsed. Retry?');
            return;
        }
        this.renderProposal(sections);
    }

    parseAssignment(text) {
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) return null;
        let obj;
        try { obj = JSON.parse(m[0]); } catch (e) { return null; }
        const used = new Set();
        const sections = emptySections();
        sections.done = this.doneItems;
        for (const q of QUADRANTS) {
            const arr = Array.isArray(obj[q.key]) ? obj[q.key] : [];
            for (const n of arr) {
                const i = Number(n);
                if (!Number.isInteger(i) || i < 0 || i >= this.entries.length || used.has(i)) continue;
                used.add(i);
                sections[q.key].push(this.entries[i].item);
            }
        }
        // Anything Claude failed to place stays in the Inbox instead of
        // silently vanishing from the note.
        for (let i = 0; i < this.entries.length; i++) {
            if (!used.has(i)) sections.inbox.push(this.entries[i].item);
        }
        return sections;
    }

    renderProposal(sections) {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '🤖 Claude\'s Proposal' });

        for (const q of QUADRANTS) {
            contentEl.createEl('h3', { text: q.heading, cls: 'ordinal-quadrant-header' });
            const items = sections[q.key];
            if (items.length === 0) {
                contentEl.createEl('p', { text: '(empty)', cls: 'ordinal-hint' });
            } else {
                const ol = contentEl.createEl('ol', { cls: 'ordinal-results-list' });
                for (const item of items) ol.createEl('li').createSpan({ text: item.text });
            }
        }
        if (sections.inbox.length > 0) {
            contentEl.createEl('h3', { text: 'Left in Inbox (unassigned by Claude)', cls: 'ordinal-quadrant-header' });
            const ol = contentEl.createEl('ol', { cls: 'ordinal-results-list' });
            for (const item of sections.inbox) ol.createEl('li').createSpan({ text: item.text });
        }

        const saveBtn = contentEl.createEl('button', {
            text: '💾 Save to note',
            cls: 'ordinal-save-btn'
        });
        saveBtn.addEventListener('click', () => {
            this.finished = true;
            this.onComplete({ mode: 'matrix', sections });
            this.close();
        });
        closeHint(contentEl, 'Close without saving to discard the proposal.');
    }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

function computeResult(originalContent, result) {
    if (result.mode === 'flat') {
        return serializeFlat(originalContent, result.items, result.inbox || null);
    }
    return serializeMatrix(originalContent, result.sections);
}

function applyResult(editor, originalContent, result) {
    editor.setValue(computeResult(originalContent, result));
}

function totalActiveItems(parsed) {
    if (parsed.mode === 'flat') return parsed.items.length;
    return QUADRANTS.reduce((sum, q) => sum + parsed.sections[q.key].length, 0);
}

// ── Categorize done items (backfill #urgent/#important tags) ────────────────
// Items checked off inside a quadrant carry their classification into Done
// as tags; items that pre-date the matrix (or were checked off outside one)
// don't. This walks the untagged ones and asks a single four-way question
// per item, so Claude's prioritization has a fuller calibration set.

const DONE_TAG_RE = /(^|\s)#(urgent|important|neither)\b/;

function hasDoneTags(text) {
    return DONE_TAG_RE.test(text);
}

const DONE_CATEGORIES = [
    { key: '1', label: 'Urgent & Important', tags: ' #urgent #important' },
    { key: '2', label: 'Important only',     tags: ' #important' },
    { key: '3', label: 'Urgent only',        tags: ' #urgent' },
    { key: '4', label: 'Neither',            tags: ' #neither' },
];

// Append tags to the `- [x]` lines whose text matches a decided item. Lines
// are rewritten in place — the rest of the note is untouched byte-for-byte —
// so this works the same in flat and matrix notes. Duplicate lines with the
// same text all receive the same tags.
function tagDoneLines(content, decisions) {
    if (decisions.size === 0) return content;
    return content.split('\n').map(line => {
        const m = line.match(/^( {0,3}[-*+] \[[xX]\]\s+)(.*?)(\s*)$/);
        if (!m) return line;
        const text = m[2].trim();
        if (hasDoneTags(text)) return line;
        const tags = decisions.get(text);
        return tags === undefined ? line : `${m[1]}${text}${tags}`;
    }).join('\n');
}

class CategorizeDoneModal extends obsidian.Modal {
    constructor(app, doneItems, onComplete) {
        super(app);
        this.onComplete = onComplete;
        this.finished = false;
        // Done is kept newest-first (a freshly checked item lands at its
        // head), so walking in order asks about recent work first. Each
        // distinct text is asked once.
        const seen = new Set();
        this.texts = [];
        for (const item of doneItems) {
            const text = item.text.trim();
            if (hasDoneTags(text) || seen.has(text)) continue;
            seen.add(text);
            this.texts.push(text);
        }
        this.idx = 0;
        this.decisions = new Map();   // text → tags string
        this.skipped = 0;
    }

    onOpen() {
        this.modalEl.addClass('ordinal-modal');
        const bind = (key, fn) => this.scope.register([], key, () => { fn(); return false; });
        for (const c of DONE_CATEGORIES) bind(c.key, () => this.answer(c.tags));
        bind('s', () => this.answer(null));
        this.render();
    }

    // Closing mid-session saves what's decided so far; the rest stays
    // untagged and shows up again next run.
    onClose() {
        this.contentEl.empty();
        if (this.finished) return;
        this.finished = true;
        this.onComplete(this.decisions, this.idx < this.texts.length);
    }

    answer(tags) {
        if (this.idx >= this.texts.length) return;
        if (tags === null) this.skipped++;
        else this.decisions.set(this.texts[this.idx], tags);
        this.idx++;
        this.render();
    }

    render() {
        const { contentEl } = this;
        contentEl.empty();
        if (this.idx >= this.texts.length) {
            this.finished = true;
            this.onComplete(this.decisions, false);
            this.close();
            return;
        }
        const total = this.texts.length;
        contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: `Done item ${this.idx + 1} of ${total}` });
        contentEl.createEl('h2', { text: this.texts[this.idx] });
        contentEl.createEl('p', {
            cls: 'ordinal-hint',
            text: 'When this was open, did it have to get done that week (urgent)? Would never doing it have mattered (important)?',
        });

        const prog = contentEl.createDiv({ cls: 'ordinal-progress' });
        prog.createDiv({ cls: 'ordinal-progress-fill' }).style.width = `${(this.idx / total) * 100}%`;
        prog.createDiv({ cls: 'ordinal-progress-label', text: `${this.idx} / ${total}` });

        const grid = contentEl.createDiv({ cls: 'ordinal-grid ordinal-grid-2x2' });
        for (const c of DONE_CATEGORIES) {
            const btn = grid.createEl('button', { cls: 'ordinal-choice' });
            btn.createSpan({ cls: 'ordinal-key', text: c.key });
            btn.createSpan({ text: c.label });
            btn.addEventListener('click', () => this.answer(c.tags));
        }

        const skip = contentEl.createEl('button', { text: 'Skip (s)', cls: 'ordinal-skip' });
        skip.addEventListener('click', () => this.answer(null));

        closeHint(contentEl, 'Keys 1–4 answer, s skips. Close anytime — items tagged so far are saved.');
    }
}

// ── Secrets ─────────────────────────────────────────────────────────────────
// API keys live in Obsidian's keychain (app.secretStorage, Obsidian ≥ 1.11.4):
// encrypted with the OS keyring, kept per device in the app's config dir, never
// inside the vault. data.json holds nothing but the settings that reference
// them. On a build without secretStorage the value stays in data.json as it
// always did, so the plugin keeps working on an older phone.
const SECRET_IDS = {
    anthropicApiKey:    'factotum-anthropic-api-key',
    beeminderAuthToken: 'factotum-beeminder-auth-token',
};

function secretStore(app) {
    const ss = app.secretStorage;
    return ss && typeof ss.getSecret === 'function' && typeof ss.setSecret === 'function' ? ss : null;
}

// Where a secret is kept, for the settings description.
function secretHomeDesc(app) {
    return secretStore(app)
        ? 'Kept in Obsidian\'s keychain on this device (Settings → Keychain), not in the vault or data.json. Enter it once per device.'
        : 'This Obsidian build has no keychain, so it is stored in this plugin\'s data.json.';
}

// ── Beeminder daily word count ──────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    todoNotePath: '',               // note that "Add new item" targets; blank = active note
    scrollOff: 10,                  // min lines of context kept above/below the cursor (nvim scrolloff); 0 = off
    reflectionFeed: {
        excludeFolders: '',        // newline/comma-separated folder paths never shown in the feed
        minChars: 40,              // notes whose body (sans frontmatter) is shorter are skipped
        batchSize: 4,              // notes rendered per scroll-triggered load
    },
    beeminder: {
        enabled: false,
        authToken: '',             // legacy plaintext; blank once moved into the keychain
        username: '',
        goalName: '',
        templatePath: '',          // optional override; blank = auto-detect
        lastSubmittedDaystamp: '', // YYYYMMDD of the last successful send
    },
    anthropic: {
        apiKey: '',                // legacy plaintext; blank once moved into the keychain. Shared by all periodic reviews, the daily sweep, and prioritization
        model: 'claude-opus-4-8',
    },
    dailySweep: {
        enabled: false,
        linkSource: true,          // append a wiki link to the daily note each item came from
        lastSweptDaystamp: '',     // YYYYMMDD of the last nightly/catch-up sweep
    },
    weeklyReview: {
        enabled: false,
        folder: 'Weekly Reviews',
        headerEmbed: '![[goals#goals]]', // its section text is copied in above the summary; blank to omit
        goalsSource: '![[goals#goals]]', // section read so Claude can pose a review question per goal; blank to omit
        lastReviewWeekstamp: '',   // GGGG-[W]WW of the last created review
    },
    monthlyReview: {
        enabled: false,
        folder: 'Monthly Reviews',
        headerEmbed: '![[goals#goals]]', // its section text is copied in above the summary; blank to omit
        goalsSource: '![[goals#goals]]', // section read so Claude can pose a review question per goal; blank to omit
        lastReviewMonthstamp: '',  // YYYY-MM of the last created review
    },
    quarterlyReview: {
        enabled: false,
        folder: 'Quarterly Reviews',
        headerEmbed: '![[goals#goals]]', // its section text is copied in above the summary; blank to omit
        goalsSource: '![[goals#goals]]', // section read so Claude can pose a review question per goal; blank to omit
        lastReviewQuarterstamp: '', // YYYY-[Q]Q of the last created review
    },
    yearlyReview: {
        enabled: false,
        folder: 'Yearly Reviews',
        headerEmbed: '![[goals#goals]]', // its section text is copied in above the summary; blank to omit
        goalsSource: '![[goals#goals]]', // section read so Claude can pose a review question per goal; blank to omit
        questionsSource: '',       // note whose questions are copied in as their own section, headed by the note's title; blank to omit
        lastReviewYearstamp: '',   // YYYY of the last created review
    },
    decadeReview: {
        enabled: false,
        folder: 'Decade Reviews',
        headerEmbed: '![[goals#goals]]', // its section text is copied in above the summary; blank to omit
        goalsSource: '![[goals#goals]]', // section read so Claude can pose a review question per goal; blank to omit
        questionsSource: '',       // note whose questions are copied in as their own section, headed by the note's title; blank to omit
        lastReviewDecadestamp: '', // e.g. "2020s" of the last created review
    },
    centuryReview: {
        enabled: false,
        folder: 'Century Reviews',
        headerEmbed: '![[goals#goals]]', // its section text is copied in above the summary; blank to omit
        goalsSource: '![[goals#goals]]', // section read so Claude can pose a review question per goal; blank to omit
        lastReviewCenturystamp: '', // e.g. "21st Century" of the last created review
    },
};

function stripFrontmatter(text) {
    return text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

// Count word-like tokens (letters/numbers), ignoring markdown punctuation like
// bullets and heading markers. Frontmatter is excluded so YAML keys don't count.
function countWords(text) {
    if (!text) return 0;
    const m = stripFrontmatter(text).match(/[\p{L}\p{N}_'’]+/gu);
    return m ? m.length : 0;
}

// Resolve the daily-note folder/format/template from Periodic Notes if present,
// otherwise the core Daily Notes plugin. Returns null if neither is available.
function getDailyNoteConfig(app) {
    const periodic = app.plugins?.getPlugin?.('periodic-notes');
    const daily = periodic?.settings?.daily;
    if (daily && daily.enabled !== false && (daily.format || daily.folder)) {
        return { folder: daily.folder || '', format: daily.format || 'YYYY-MM-DD', template: daily.template || '' };
    }
    const core = app.internalPlugins?.getPluginById?.('daily-notes');
    const opts = core?.instance?.options;
    if (opts) {
        return { folder: opts.folder || '', format: opts.format || 'YYYY-MM-DD', template: opts.template || '' };
    }
    return null;
}

function dailyNotePath(config, m) {
    const filename = (m || obsidian.moment()).format(config.format || 'YYYY-MM-DD') + '.md';
    const folder = (config.folder || '').replace(/\/+$/, '');
    return obsidian.normalizePath(folder ? `${folder}/${filename}` : filename);
}

// Canonical (un-suffixed) path of a period's review note — `stamp` is a
// weekstamp (2026-W23) or monthstamp (2026-06). Mirrors the base name
// writeReviewNote() creates, so callers can detect an already-written review.
function reviewNotePath(folder, stamp) {
    const dir = (folder || '').replace(/\/+$/, '');
    return obsidian.normalizePath(dir ? `${dir}/${stamp}.md` : `${stamp}.md`);
}

function resolveTemplatePath(rawPath) {
    let p = (rawPath || '').trim();
    if (!p) return null;
    if (!p.toLowerCase().endsWith('.md')) p += '.md';
    return obsidian.normalizePath(p);
}

async function readWordCount(app, path) {
    if (!path) return 0;
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof obsidian.TFile) {
        return countWords(await app.vault.cachedRead(file));
    }
    return 0;
}

async function submitToBeeminder(s, authToken, value, daystamp, comment) {
    const url = `https://www.beeminder.com/api/v1/users/${encodeURIComponent(s.username)}/goals/${encodeURIComponent(s.goalName)}/datapoints.json`;
    const body = new URLSearchParams({
        auth_token: authToken,
        value: String(value),
        daystamp: daystamp,
        comment: comment || '',
        // Stable per-day id: re-running the same day updates rather than duplicates.
        requestid: `factotum-wordcount-${daystamp}`,
    }).toString();
    return obsidian.requestUrl({
        url,
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body,
        throw: false,
    });
}

// ── Periodic reviews (weekly / monthly / quarterly / yearly) ───────────────

// Return the body under the markdown heading whose text matches `heading`
// (case-insensitive), up to the next heading of the same or higher level.
function extractSection(content, heading) {
    const lines = content.split('\n');
    const want = heading.toLowerCase();
    let start = -1, level = 0;
    for (let i = 0; i < lines.length; i++) {
        const h = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
        if (h && h[2].trim().toLowerCase() === want) { start = i; level = h[1].length; break; }
    }
    if (start < 0) return '';
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
        const h = lines[i].match(/^(#{1,6})\s+/);
        if (h && h[1].length <= level) break;
        out.push(lines[i]);
    }
    return out.join('\n').trim();
}

// Pull the plain text of the note/section referenced by a wiki embed like
// `![[goals#goals]]`, so Claude can read the goals rather than only embed them
// visually. Returns '' if the link is blank, unparseable, or unresolved.
async function readEmbeddedSection(app, embed) {
    const m = (embed || '').match(/\[\[([^\]]+)\]\]/);
    if (!m) return '';
    const target = m[1].split('|')[0].trim();          // drop any display alias
    const hashIdx = target.indexOf('#');
    const linkpath = (hashIdx >= 0 ? target.slice(0, hashIdx) : target).trim();
    const heading = (hashIdx >= 0 ? target.slice(hashIdx + 1) : '').replace(/^#+/, '').trim();
    if (!linkpath) return '';
    const file = app.metadataCache.getFirstLinkpathDest(linkpath, '');
    if (!(file instanceof obsidian.TFile)) return '';
    const content = await app.vault.cachedRead(file);
    return heading ? extractSection(content, heading) : stripFrontmatter(content).trim();
}

// Heading used when a linked note/section's text is copied into a review
// note: the linked section name (or file name), capitalized — "Goals" for
// ![[goals#goals]].
function embedHeadingLabel(embed, fallback = 'Goals') {
    const m = (embed || '').match(/\[\[([^\]]+)\]\]/);
    if (!m) return fallback;
    const target = m[1].split('|')[0];
    const hashIdx = target.indexOf('#');
    const name = (hashIdx >= 0
        ? target.slice(hashIdx + 1).replace(/^#+/, '')
        : target.split('/').pop().replace(/\.md$/, '')).trim();
    return name ? name[0].toUpperCase() + name.slice(1) : fallback;
}

// Start of the period containing `m`. Kinds with `yearsSpan` (decade/century)
// have no moment unit; floor the year to the span boundary instead.
function periodStart(k, m) {
    if (k.yearsSpan) {
        const y = Math.floor(m.year() / k.yearsSpan) * k.yearsSpan;
        return m.clone().year(y).startOf('year');
    }
    return m.clone().startOf(k.unit);
}

// `m` shifted by `n` periods of kind `k` (n may be negative).
function addPeriods(k, m, n) {
    return m.clone().add(n * (k.yearsSpan || 1), k.yearsSpan ? 'year' : k.addUnit);
}

// The stamp naming the period containing `m` — the review note's filename and
// the data.json done-marker.
function periodStampOf(k, m) {
    return k.stamp ? k.stamp(periodStart(k, m)) : m.format(k.stampFormat);
}

function ordinal(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
    return `${n}${suffix}`;
}

async function callClaude(apiKey, model, system, userContent) {
    const res = await obsidian.requestUrl({
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        contentType: 'application/json',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model,
            max_tokens: 8000,
            system,
            messages: [{ role: 'user', content: userContent }],
        }),
        throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
        return { ok: false, status: res.status, text: '' };
    }
    const block = (res.json?.content || []).find(b => b.type === 'text');
    return { ok: true, status: res.status, text: block ? block.text : '' };
}

// ── Daily to-do sweep ───────────────────────────────────────────────────────
// Once a night — at midnight, when the day closes, same as the Beeminder
// submission and the periodic reviews — read the ended day's daily note, have Claude pull out the to-dos written into it — in
// these journals they're mostly prose ("I need to remember to ask Lauren…",
// "gotta pump up the bike tires"), not checkboxes — and drop them under the
// TODO note's Inbox heading for the usual triage. The whole TODO note goes
// along as context so already-captured items aren't re-added.

const SWEEP_SYSTEM =
    'You extract to-do items from one day\'s journal note in Obsidian. The note is informal, ' +
    'stream-of-consciousness writing; to-dos appear as prose ("I need to remember to ask Lauren about X", ' +
    '"gotta pump up the bike tires before I can ride", "should book the dentist") and only occasionally as ' +
    'checkboxes. It may follow a template with Intentions, Outcomes, and Notes sections.\n\n' +
    'Extract the concrete, actionable tasks the writer means to do — things that could be checked off. ' +
    'Skip: routine daily habits and intentions (exercise, write, shave, work, sleep, laundry) unless framed as ' +
    'a specific one-off errand; vague aspirations, musings, and self-critique ("I should be more assertive"); ' +
    'anything the Outcomes section or later text shows was already done; ideas with no commitment behind them. ' +
    'Skip anything already present in the TODO note, in any wording — it holds an Inbox, the ranked list, and ' +
    'completed items.\n\n' +
    'Phrase each item as a short imperative that stands on its own out of context, keeping the writer\'s ' +
    'specifics (names, objects, places, deadlines): "Ask Lauren what I\'m authorized to spend on hotel rooms", ' +
    '"Buy an air pump for the ebike tires". Respond with ONLY a JSON array of strings, e.g. ' +
    '["Buy an air pump for the ebike tires"], or [] when there is nothing new. No prose, no code fences.';

// Claude's reply is a JSON array of strings; tolerate stray prose around it.
function parseSweepItems(text) {
    const m = (text || '').match(/\[[\s\S]*\]/);
    if (!m) return null;
    let arr;
    try { arr = JSON.parse(m[0]); } catch (e) { return null; }
    if (!Array.isArray(arr)) return null;
    const seen = new Set();
    const out = [];
    for (const v of arr) {
        if (typeof v !== 'string') continue;
        const t = v.replace(/\s+/g, ' ').trim().replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '');
        if (!t) continue;
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
    }
    return out;
}

// Add items to the end of the note's Inbox section, touching nothing else.
// A note without an Inbox heading yet is rewritten in the canonical layout
// (Inbox on top, list under TODO) by the same serializers every save uses.
function appendToInbox(content, items) {
    const lines = content.split('\n');
    let start = -1, end = lines.length;
    for (let i = 0; i < lines.length; i++) {
        const h = lines[i].match(/^#{1,6}\s+(.+)$/);
        if (!h) continue;
        if (start < 0) { if (classifyHeading(h[1]) === 'inbox') start = i; }
        else { end = i; break; }
    }
    if (start < 0) {
        const parsed = parseNote(content);
        if (parsed.mode === 'flat') return serializeFlat(content, parsed.items, [...parsed.inbox, ...items]);
        return serializeMatrix(content, { ...parsed.sections, inbox: [...parsed.sections.inbox, ...items] });
    }
    // Insert after the section's last non-blank line (or right under the
    // heading when it's empty), so a trailing blank line before the next
    // heading stays where it was.
    let at = start + 1;
    for (let i = start + 1; i < end; i++) if (lines[i].trim() !== '') at = i + 1;
    const rendered = items.flatMap(renderItemBlock);
    lines.splice(at, 0, ...rendered);
    return lines.join('\n');
}

// System prompt shared by all the periodic reviews; `k` is a REVIEW_KINDS
// entry and `sourceDesc` names the input granularities ('daily notes', or
// e.g. 'weekly reviews and daily notes' when a long span consolidated its
// oldest days into prior review notes).
function reviewSystem(k, sourceDesc, hasGoals) {
    let s =
        `You are writing a ${k.adjLabel} review from a user's Obsidian ${sourceDesc}. ` +
        'Output GitHub-flavored markdown with the sections described below, in order, and nothing else. ' +
        `First, \`## AI Summary\` — a concise prose recap of the ${k.noun}'s themes, progress, and notable events. `;
    if (hasGoals) {
        s +=
            'Then, `## Review Questions` — under it, write exactly one reflective question per goal ' +
            'provided to you, in the same order as the goals. Render each question as its own `###` heading ' +
            '(the heading text is the question itself), followed by a blank line so the user can write their ' +
            'answer underneath. Each question should prompt the user to assess their progress on that goal ' +
            `this ${k.noun}, grounded in what the notes show. One question per goal, no more, no fewer. `;
    }
    if (sourceDesc !== 'daily notes') {
        s += 'Sections headed as reviews (e.g. "Weekly Review — …") are previously generated periodic review notes standing in for the older part of the span at coarser granularity; ' +
            'synthesize across all the inputs — treat the reviews as equal evidence to the daily notes, and do not let the finer-grained recent days dominate the whole. ';
    }
    s += 'Do not invent events that are not supported by the notes.';
    return s;
}

// Reviews are sent to Claude in one request, so their input must fit the
// model context (~200k tokens) with room left for the system prompt, the
// goals block, and the 8k-token output. Estimated as chars/4.
const REVIEW_INPUT_TOKEN_BUDGET = 150000;
const REVIEW_INPUT_CHAR_BUDGET = REVIEW_INPUT_TOKEN_BUDGET * 4;

// One entry per review period, driving the shared scheduling/generation code.
// `unit` is the moment unit the period spans (startOf(unit) is its first day)
// and `addUnit` steps deadline math one period forward; kinds with `yearsSpan`
// (decade/century) have no moment unit and use floored-year math instead
// (see periodStart/addPeriods). `stampFormat` — or the `stamp` function, for
// spans moment can't format — names the review note and the data.json
// done-marker. `adjLabel` is the adjective for prose ("weekly review",
// "decade review"). `sourceLadder` lists the coarser granularities, finest
// first, that the span's oldest content is consolidated into when the daily
// notes exceed the context budget (see collectLadderSections); kinds without
// it read daily notes only.
const REVIEW_KINDS = {
    week:    { noun: 'week',    adjLabel: 'weekly',    unit: 'isoWeek', addUnit: 'week',    settingsKey: 'weeklyReview',    stampField: 'lastReviewWeekstamp',    stampFormat: 'GGGG-[W]WW', title: 'Weekly Review' },
    month:   { noun: 'month',   adjLabel: 'monthly',   unit: 'month',   addUnit: 'month',   settingsKey: 'monthlyReview',   stampField: 'lastReviewMonthstamp',   stampFormat: 'YYYY-MM',    title: 'Monthly Review' },
    quarter: { noun: 'quarter', adjLabel: 'quarterly', unit: 'quarter', addUnit: 'quarter', settingsKey: 'quarterlyReview', stampField: 'lastReviewQuarterstamp', stampFormat: 'YYYY-[Q]Q',  title: 'Quarterly Review' },
    year:    { noun: 'year',    adjLabel: 'yearly',    unit: 'year',    addUnit: 'year',    settingsKey: 'yearlyReview',    stampField: 'lastReviewYearstamp',    stampFormat: 'YYYY',       title: 'Yearly Review',
               sourceLadder: ['week', 'month', 'quarter'] },
    decade:  { noun: 'decade',  adjLabel: 'decade',    yearsSpan: 10,   settingsKey: 'decadeReview',  stampField: 'lastReviewDecadestamp',  stamp: (s) => `${s.year()}s`, title: 'Decade Review',
               sourceLadder: ['week', 'month', 'quarter', 'year'] },
    century: { noun: 'century', adjLabel: 'century',   yearsSpan: 100,  settingsKey: 'centuryReview', stampField: 'lastReviewCenturystamp', stamp: (s) => `${ordinal(s.year() / 100 + 1)} Century`, title: 'Century Review',
               sourceLadder: ['week', 'month', 'quarter', 'year', 'decade'] },
};

// ── Reflection feed ─────────────────────────────────────────────────────────
//
// An infinite, read-only scroll of random notes — a vault-flavored stand-in for
// doomscrolling. Each card renders one note in reading mode; scrolling near the
// bottom draws the next few. Notes are dealt from a shuffled deck so nothing
// repeats until the whole vault has been shown once.

const REFLECTION_FEED_VIEW = 'factotum-reflection-feed';

function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Folders are matched as path prefixes, so "Templates" also excludes
// "Templates/Daily". Entries may be separated by newlines or commas.
function parseFolderList(text) {
    return (text || '')
        .split(/[\n,]/)
        .map(s => s.trim().replace(/^\/+|\/+$/g, ''))
        .filter(Boolean);
}

class ReflectionFeedView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.deck = [];
        this.loading = false;
        this.generation = 0;       // bumped on restart so an in-flight load drops its stale cards
        this.navigation = false;
        // Created here, not in onOpen: Obsidian pushes view.scope when the leaf
        // becomes active, which can precede onOpen.
        this.scope = new obsidian.Scope(this.app.scope);
        this.setupVimKeys();
    }

    getViewType()    { return REFLECTION_FEED_VIEW; }
    getDisplayText() { return 'Reflection feed'; }
    getIcon()        { return 'shuffle'; }

    async onOpen() {
        const root = this.contentEl;
        root.empty();
        root.addClass('reflection-feed');

        this.addAction('shuffle', 'Reshuffle (start a fresh deck)', () => this.restart());

        this.cardsEl    = root.createDiv('reflection-feed-cards');
        this.statusEl   = root.createDiv('reflection-feed-status');
        this.sentinelEl = root.createDiv('reflection-feed-sentinel');

        // Draw the next batch as soon as the sentinel below the last card comes
        // within a screen or so of view; rootMargin keeps the scroll seamless.
        this.observer = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) this.loadMore();
        }, { root, rootMargin: '800px 0px' });
        this.observer.observe(this.sentinelEl);

        // Rendered markdown inside a custom view doesn't get Obsidian's link
        // handling for free, so route wiki-link clicks ourselves.
        this.registerDomEvent(root, 'click', (evt) => {
            const a = evt.target?.closest?.('a.internal-link');
            if (!a) return;
            evt.preventDefault();
            evt.stopPropagation();
            const href = a.dataset.href || a.getAttribute('href');
            if (!href) return;
            const sourcePath = a.closest('.reflection-feed-card')?.dataset.path ?? '';
            this.app.workspace.openLinkText(href, sourcePath, obsidian.Keymap.isModEvent(evt));
        });

        await this.restart();
    }

    // Vim-style navigation, active whenever the feed is the focused pane (the
    // view's Scope is pushed by Obsidian's keymap, so no element needs focus).
    //   j / k          scroll a few lines          J / K   snap to next / previous card
    //   d / u, ^d / ^u half a page                 gg / G  top / last loaded card
    //   o / Enter      open the card in view       r       reshuffle
    setupVimKeys() {
        const root = this.contentEl;
        const bind = (mods, key, fn) => this.scope.register(mods, key, (evt) => { fn(evt); return false; });
        const scrollBy = (dy, smooth) => root.scrollBy({ top: dy, behavior: smooth ? 'smooth' : 'auto' });
        const lineStep = () => Math.max(40, Math.round(parseFloat(getComputedStyle(root).lineHeight) || 24) * 3);
        const halfPage = () => Math.max(100, Math.floor(root.clientHeight / 2));

        bind([], 'j', () => scrollBy( lineStep(), false));
        bind([], 'k', () => scrollBy(-lineStep(), false));
        for (const mods of [[], ['Ctrl']]) {
            bind(mods, 'd', () => scrollBy( halfPage(), true));
            bind(mods, 'u', () => scrollBy(-halfPage(), true));
        }
        bind(['Shift'], 'j', () => this.snapToCard(+1));
        bind(['Shift'], 'k', () => this.snapToCard(-1));
        bind(['Shift'], 'g', () => root.scrollTo({ top: root.scrollHeight, behavior: 'smooth' }));
        bind([], 'o',     () => this.openCardInView());
        bind([], 'Enter', () => this.openCardInView());
        bind([], 'r',     () => this.restart());

        // gg: two g's within a second jump to the top.
        let lastG = 0;
        bind([], 'g', () => {
            const now = Date.now();
            if (now - lastG < 1000) { root.scrollTo({ top: 0, behavior: 'smooth' }); lastG = 0; }
            else lastG = now;
        });
    }

    cards() {
        return Array.from(this.cardsEl.children);
    }

    // The card whose top is nearest the top of the viewport — what the eye is on.
    cardInView() {
        const rootTop = this.contentEl.getBoundingClientRect().top;
        let best = null, bestDist = Infinity;
        for (const card of this.cards()) {
            const r = card.getBoundingClientRect();
            if (r.bottom <= rootTop + 8) continue;          // scrolled past
            const dist = Math.abs(r.top - rootTop);
            if (dist < bestDist) { best = card; bestDist = dist; }
        }
        return best;
    }

    snapToCard(dir) {
        const cards = this.cards();
        if (cards.length === 0) return;
        const root = this.contentEl;
        const rootTop = root.getBoundingClientRect().top;
        const cardTop = (c) => c.getBoundingClientRect().top - rootTop;   // relative to viewport top
        let target;
        if (dir > 0) target = cards.find(c => cardTop(c) > 12);
        else         target = [...cards].reverse().find(c => cardTop(c) < -12);
        if (!target) {
            if (dir > 0) this.loadMore();
            else root.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
        root.scrollTo({ top: root.scrollTop + cardTop(target) - 8, behavior: 'smooth' });
    }

    openCardInView() {
        const card = this.cardInView();
        if (!card) return;
        const file = this.app.vault.getAbstractFileByPath(card.dataset.path);
        if (file instanceof obsidian.TFile) this.app.workspace.getLeaf('tab').openFile(file);
    }

    async onClose() {
        this.observer?.disconnect();
        this.observer = null;
    }

    // ── Deck ──────────────────────────────────────────────────────────────

    candidates() {
        const s = this.plugin.settings.reflectionFeed;
        const excluded = parseFolderList(s.excludeFolders);
        return this.app.vault.getMarkdownFiles().filter(f =>
            !excluded.some(dir => f.path === dir || f.path.startsWith(dir + '/')));
    }

    reshuffle() {
        this.deck = shuffleInPlace(this.candidates());
        this.dealt = 0;
        this.deckSize = this.deck.length;
    }

    // Returns the next note whose body has something worth reading, or null
    // when the vault has nothing that passes the filters.
    async drawNote() {
        const minChars = Math.max(0, this.plugin.settings.reflectionFeed.minChars | 0);
        for (let tries = 0; tries < 200; tries++) {
            if (this.deck.length === 0) {
                if (this.dealt === 0) return null;       // nothing passed the filters last round
                this.reshuffle();
                if (this.deck.length === 0) return null;
                this.setStatus('Every note has been shown once — reshuffled.');
            }
            const file = this.deck.pop();
            this.dealt++;
            if (!(file instanceof obsidian.TFile)) continue;   // deleted since the deck was built
            const body = this.stripFrontmatter(file, await this.app.vault.cachedRead(file));
            if (body.trim().length < minChars) continue;
            return { file, body };
        }
        return null;
    }

    stripFrontmatter(file, content) {
        const cache = this.app.metadataCache.getFileCache(file);
        const end = cache?.frontmatterPosition?.end?.offset ?? cache?.frontmatter?.position?.end?.offset;
        if (end != null) return content.slice(end);
        const m = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
        return m ? content.slice(m[0].length) : content;
    }

    // ── Rendering ─────────────────────────────────────────────────────────

    async restart() {
        this.generation++;
        this.loading = false;
        this.reshuffle();
        this.cardsEl.empty();
        this.setStatus('');
        this.contentEl.scrollTop = 0;
        await this.loadMore();
    }

    setStatus(text) {
        this.statusEl.setText(text);
        this.statusEl.toggleClass('is-empty', !text);
    }

    async loadMore() {
        if (this.loading) return;
        this.loading = true;
        try {
            const gen = this.generation;
            const batch = Math.max(1, this.plugin.settings.reflectionFeed.batchSize | 0);
            for (let i = 0; i < batch; i++) {
                const note = await this.drawNote();
                if (gen !== this.generation) return;     // restarted meanwhile
                if (!note) {
                    if (this.cardsEl.childElementCount === 0) {
                        this.setStatus('No notes to show — check the excluded folders and minimum length in Settings → Factotum → Reflection feed.');
                    }
                    return;
                }
                await this.renderCard(note.file, note.body, gen);
                if (gen !== this.generation) return;
            }
        } finally {
            this.loading = false;
        }
        // Short notes may leave the sentinel still on screen, and the observer
        // only fires on *changes* — so keep filling until it's out of view.
        requestAnimationFrame(() => this.fillIfNeeded());
    }

    fillIfNeeded() {
        if (!this.sentinelEl?.isConnected) return;
        const root = this.contentEl.getBoundingClientRect();
        if (root.height === 0) return;   // hidden tab: rects are all zero; the observer resumes on reveal
        const sentinel = this.sentinelEl.getBoundingClientRect();
        if (sentinel.top < root.bottom + 800) this.loadMore();
    }

    async renderCard(file, body, gen) {
        const card = this.cardsEl.createDiv('reflection-feed-card');
        card.dataset.path = file.path;

        const head = card.createDiv('reflection-feed-card-head');
        const title = head.createSpan({ cls: 'reflection-feed-card-title', text: file.basename });
        title.setAttr('aria-label', 'Open this note');
        title.setAttr('role', 'link');
        title.addEventListener('click', (evt) => {
            const mode = obsidian.Keymap.isModEvent(evt) || 'tab';
            this.app.workspace.getLeaf(mode).openFile(file);
        });
        if (file.parent && file.parent.path !== '/') {
            head.createSpan({ cls: 'reflection-feed-card-path', text: file.parent.path });
        }
        head.createSpan({ cls: 'reflection-feed-card-date', text: obsidian.moment(file.stat.mtime).fromNow() });

        const bodyEl = card.createDiv('reflection-feed-card-body markdown-rendered is-collapsed');
        await this.renderMarkdown(body, bodyEl, file.path);
        if (gen !== this.generation) { card.remove(); return; }   // restarted while rendering

        // Long notes are clipped with a fade; one tap expands them in place so
        // the feed stays scannable without hiding anything.
        if (bodyEl.scrollHeight > bodyEl.clientHeight + 24) {
            const more = card.createEl('button', { cls: 'reflection-feed-more', text: 'Read more' });
            more.addEventListener('click', () => {
                bodyEl.removeClass('is-collapsed');
                more.remove();
            });
        } else {
            bodyEl.removeClass('is-collapsed');
        }
    }

    async renderMarkdown(markdown, el, sourcePath) {
        const R = obsidian.MarkdownRenderer;
        if (typeof R.render === 'function') {
            await R.render(this.app, markdown, el, sourcePath, this);
        } else {
            await R.renderMarkdown(markdown, el, sourcePath, this);
        }
    }
}

class DrakeFactotumPlugin extends obsidian.Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new FactotumSettingTab(this.app, this));
        this.beeminderTimer = null;
        this.sweepTimer = null;
        this.sweepRunning = false;
        this.reviewTimers = {};
        this.syncSettling = null;
        this.setupScrollOff();
        this.app.workspace.onLayoutReady(() => {
            this.maybeCatchUpBeeminder();
            this.scheduleBeeminderSubmission();
            this.maybeCatchUpDailySweep();
            this.scheduleDailySweep();
            for (const kind of Object.keys(REVIEW_KINDS)) {
                this.maybeCatchUpReview(kind);
                this.scheduleReview(kind);
            }
        });

        this.addCommand({
            id: 'factotum-rank-list',
            name: 'Start ranking session',
            editorCallback: (editor) => {
                const content = editor.getValue();
                const parsed  = parseNote(content);
                // A flat session compares pairs (needs 2); a matrix session
                // re-classifies items one at a time (needs 1).
                const minItems = parsed.mode === 'flat' ? 2 : 1;
                if (totalActiveItems(parsed) < minItems) {
                    new obsidian.Notice(parsed.mode === 'flat'
                        ? 'Factotum: need at least 2 list items to compare.'
                        : 'Factotum: no items to classify.');
                    return;
                }
                new RankSessionModal(this.app, parsed, (result, partial) => {
                    applyResult(editor, content, result);
                    new obsidian.Notice(partial
                        ? 'Factotum: session interrupted — progress saved; run again to finish.'
                        : 'Factotum: rankings saved ✓');
                }).open();
            }
        });

        this.addCommand({
            id: 'factotum-add-item',
            name: 'Add new item to the note',
            // Not an editorCallback: a configured TODO note is targeted no
            // matter which note is active, so this command is always available.
            callback: async () => {
                const path = (this.settings.todoNotePath || '').trim();
                let target;
                if (path) {
                    const file = this.resolveTodoNote();
                    if (!file) {
                        new obsidian.Notice(`Factotum: TODO note not found at "${path}". Check the path in settings.`);
                        return;
                    }
                    target = this.fileTarget(file);
                } else {
                    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
                    if (!view) {
                        new obsidian.Notice('Factotum: open a note, or set a TODO note path in settings.');
                        return;
                    }
                    target = { read: async () => view.editor.getValue(), write: async (c) => view.editor.setValue(c) };
                }
                const content = await target.read();
                const parsed  = parseNote(content);
                new AddItemModal(this.app, parsed, async (result, partial) => {
                    await target.write(computeResult(content, result));
                    new obsidian.Notice(partial
                        ? 'Factotum: interrupted — item saved with best-effort placement ✓'
                        : 'Factotum: item added ✓');
                }).open();
            }
        });

        this.addCommand({
            id: 'factotum-triage-inbox',
            name: 'Triage inbox (prioritize and place each item)',
            editorCallback: (editor) => {
                const content = editor.getValue();
                const parsed  = parseNote(content);
                const inbox = parsed.mode === 'flat' ? parsed.inbox : parsed.sections.inbox;
                if (inbox.length === 0) {
                    new obsidian.Notice('Factotum: no items under an "Inbox" heading in this note.');
                    return;
                }
                new TriageInboxModal(this.app, parsed, (result, partial) => {
                    applyResult(editor, content, result);
                    if (partial) {
                        const left = (result.mode === 'flat' ? result.inbox : result.sections.inbox).length;
                        new obsidian.Notice(`Factotum: triage interrupted — placed items saved, ${left} still in the Inbox.`);
                    } else {
                        new obsidian.Notice('Factotum: inbox triaged ✓');
                    }
                }).open();
            }
        });

        this.addCommand({
            id: 'factotum-claude-prioritize',
            name: 'Prioritize with Claude (whole list → Eisenhower matrix)',
            editorCallback: (editor) => {
                if (!this.anthropicApiKey()) {
                    new obsidian.Notice('Factotum: set an Anthropic API key in settings first.');
                    return;
                }
                const content = editor.getValue();
                const parsed  = parseNote(content);
                const count = totalActiveItems(parsed) +
                    (parsed.mode === 'flat' ? parsed.inbox.length : parsed.sections.inbox.length);
                if (count === 0) {
                    new obsidian.Notice('Factotum: no items to prioritize.');
                    return;
                }
                new ClaudePrioritizeModal(this.app, parsed, { apiKey: this.anthropicApiKey(), model: this.settings.anthropic.model }, (result) => {
                    applyResult(editor, content, result);
                    new obsidian.Notice('Factotum: Claude\'s prioritization saved ✓');
                }).open();
            }
        });

        this.addCommand({
            id: 'factotum-categorize-done',
            name: 'Categorize done items (tag urgent/important for Claude calibration)',
            editorCallback: (editor) => {
                const content = editor.getValue();
                const parsed  = parseNote(content);
                const done = parsed.mode === 'flat' ? parsed.done : parsed.sections.done;
                const untagged = done.filter(d => !hasDoneTags(d.text)).length;
                if (untagged === 0) {
                    new obsidian.Notice('Factotum: every done item is already tagged.');
                    return;
                }
                new CategorizeDoneModal(this.app, done, (decisions, partial) => {
                    if (decisions.size === 0) return;
                    // Re-read: the vault syncs live and the session may have run a while.
                    const latest = editor.getValue();
                    editor.setValue(tagDoneLines(latest, decisions));
                    new obsidian.Notice(partial
                        ? `Factotum: ${decisions.size} done items tagged — run again to finish the rest.`
                        : `Factotum: ${decisions.size} done items tagged ✓`);
                }).open();
            }
        });

        this.addCommand({
            id: 'factotum-convert-matrix',
            name: 'Convert flat list to Eisenhower matrix',
            editorCallback: (editor) => {
                const content = editor.getValue();
                const parsed  = parseNote(content);
                if (parsed.mode === 'matrix') {
                    new obsidian.Notice('Factotum: this note is already in matrix mode.');
                    return;
                }
                if (parsed.items.length === 0) {
                    new obsidian.Notice('Factotum: no items to classify.');
                    return;
                }
                new ConvertModal(this.app, parsed, (result, partial) => {
                    applyResult(editor, content, result);
                    new obsidian.Notice(partial
                        ? 'Factotum: conversion interrupted — classified items placed; the rest are in the Inbox.'
                        : 'Factotum: converted to Eisenhower matrix ✓');
                }).open();
            }
        });

        this.addCommand({
            id: 'factotum-flatten-matrix',
            name: 'Convert Eisenhower matrix back to flat list',
            editorCallback: (editor) => {
                const content = editor.getValue();
                const parsed  = parseNote(content);
                if (parsed.mode !== 'matrix') {
                    new obsidian.Notice('Factotum: this note is not an Eisenhower matrix.');
                    return;
                }
                editor.setValue(serializeFlatFromMatrix(content, parsed.sections));
                new obsidian.Notice('Factotum: matrix flattened to a single prioritized list ✓');
            }
        });

        this.addCommand({
            id: 'factotum-sweep-daily-note',
            name: 'Sweep today\'s daily note for to-dos (into the TODO note\'s Inbox)',
            callback: () => this.runDailySweep('manual sweep', null, true),
        });

        this.registerView(REFLECTION_FEED_VIEW, (leaf) => new ReflectionFeedView(leaf, this));
        this.addRibbonIcon('shuffle', 'Open reflection feed', () => this.openReflectionFeed());
        this.addCommand({
            id: 'factotum-reflection-feed',
            name: 'Open reflection feed (scroll random notes)',
            callback: () => this.openReflectionFeed(),
        });

        console.log('Factotum loaded');
    }

    onunload() {
        this.clearBeeminderTimer();
        this.clearSweepTimer();
        this.clearAllReviewTimers();
        console.log('Factotum unloaded');
    }

    // nvim-style scrolloff: keep `scrollOff` lines of context above and below the
    // cursor so you're never typing against the top or bottom edge of the view.
    // Desktop only — see the mobile bail-out in the scrollMargins callback below.
    //
    // This rides CodeMirror 6's native scroll-into-view, which fires on every
    // cursor move/keystroke and respects the `scrollMargins` facet — so a margin
    // of N line-heights makes CM scroll before the cursor gets within N lines of
    // an edge. There's no build step here, so we can't import EditorView; instead
    // we lift the class off a live editor instance the first time one exists, then
    // call updateOptions() to apply the extension to already-open editors.
    setupScrollOff() {
        let registered = false;
        const tryRegister = () => {
            if (registered) return;
            const cm = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor?.cm;
            const EditorView = cm?.constructor;
            if (!EditorView?.scrollMargins) return;
            this.registerEditorExtension(EditorView.scrollMargins.of((view) => {
                // Skip on mobile: the on-screen keyboard already shrinks the
                // viewport, and a scroll margin on top of that fights the native
                // cursor-into-view, jumping the display around while you type.
                if (obsidian.Platform.isMobile) return null;
                const lines = this.settings.scrollOff;
                if (!lines || lines < 1) return null;
                const margin = view.defaultLineHeight * lines;
                return { top: margin, bottom: margin };
            }));
            this.app.workspace.updateOptions();
            registered = true;
        };
        this.app.workspace.onLayoutReady(tryRegister);
        this.registerEvent(this.app.workspace.on('active-leaf-change', tryRegister));
    }

    // Reuse an open feed if there is one; otherwise open it in a new tab
    // (on mobile that's a new pane in the tab switcher).
    async openReflectionFeed() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(REFLECTION_FEED_VIEW)[0];
        if (!leaf) {
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({ type: REFLECTION_FEED_VIEW, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    async loadSettings() {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
        this.settings.beeminder = Object.assign({}, DEFAULT_SETTINGS.beeminder, data?.beeminder);
        this.settings.reflectionFeed = Object.assign({}, DEFAULT_SETTINGS.reflectionFeed, data?.reflectionFeed);
        this.settings.anthropic = Object.assign({}, DEFAULT_SETTINGS.anthropic, data?.anthropic);
        this.settings.dailySweep = Object.assign({}, DEFAULT_SETTINGS.dailySweep, data?.dailySweep);
        this.settings.weeklyReview = Object.assign({}, DEFAULT_SETTINGS.weeklyReview, data?.weeklyReview);
        this.settings.monthlyReview = Object.assign({}, DEFAULT_SETTINGS.monthlyReview, data?.monthlyReview);
        this.settings.quarterlyReview = Object.assign({}, DEFAULT_SETTINGS.quarterlyReview, data?.quarterlyReview);
        this.settings.yearlyReview = Object.assign({}, DEFAULT_SETTINGS.yearlyReview, data?.yearlyReview);
        this.settings.decadeReview = Object.assign({}, DEFAULT_SETTINGS.decadeReview, data?.decadeReview);
        this.settings.centuryReview = Object.assign({}, DEFAULT_SETTINGS.centuryReview, data?.centuryReview);
        // The API key/model used to live under weeklyReview; they're now shared
        // with the monthly review. Migrate old data forward, then drop the old
        // fields so the next save leaves a single copy of the key.
        if (!this.settings.anthropic.apiKey && data?.weeklyReview?.apiKey) {
            this.settings.anthropic.apiKey = data.weeklyReview.apiKey;
            if (data.weeklyReview.model) this.settings.anthropic.model = data.weeklyReview.model;
        }
        delete this.settings.weeklyReview.apiKey;
        delete this.settings.weeklyReview.model;

        // Move any plaintext secrets into the keychain, then drop them from
        // data.json. Runs once per device; a later load finds the fields blank.
        const ss = secretStore(this.app);
        if (ss) {
            let moved = false;
            const move = (obj, field, id) => {
                if (!obj[field]) return;
                try {
                    ss.setSecret(id, obj[field]);
                    obj[field] = '';
                    moved = true;
                } catch (e) {
                    console.warn('Factotum — could not move a secret into the keychain; leaving it in data.json', e);
                }
            };
            move(this.settings.anthropic, 'apiKey', SECRET_IDS.anthropicApiKey);
            move(this.settings.beeminder, 'authToken', SECRET_IDS.beeminderAuthToken);
            if (moved) await this.saveSettings();
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // Secrets: keychain first, legacy plaintext field as the fallback.
    anthropicApiKey() {
        return this.readSecret(SECRET_IDS.anthropicApiKey, this.settings.anthropic.apiKey);
    }

    beeminderAuthToken() {
        return this.readSecret(SECRET_IDS.beeminderAuthToken, this.settings.beeminder.authToken);
    }

    readSecret(id, legacyValue) {
        const ss = secretStore(this.app);
        if (ss) {
            const v = ss.getSecret(id);
            if (v) return v;
        }
        return legacyValue || '';
    }

    // Store a secret in the keychain when there is one, otherwise in the legacy
    // plaintext field. An empty value clears it from both places.
    async storeSecret(id, value, legacyObj, legacyField) {
        const ss = secretStore(this.app);
        if (ss) {
            if (value) ss.setSecret(id, value);
            else if (typeof ss.deleteSecret === 'function') ss.deleteSecret(id);
            legacyObj[legacyField] = '';
        } else {
            legacyObj[legacyField] = value;
        }
        await this.saveSettings();
    }

    // Resolve the configured TODO note to a TFile, tolerating a missing ".md".
    // Returns null if unset or the path doesn't point at a markdown file.
    resolveTodoNote() {
        const path = (this.settings.todoNotePath || '').trim();
        if (!path) return null;
        let file = this.app.vault.getAbstractFileByPath(path);
        if (!file && !path.toLowerCase().endsWith('.md')) {
            file = this.app.vault.getAbstractFileByPath(path + '.md');
        }
        return file instanceof obsidian.TFile ? file : null;
    }

    // The open editor for a file, if any leaf currently has it loaded.
    findOpenEditor(file) {
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view;
            if (view instanceof obsidian.MarkdownView && view.file === file) return view.editor;
        }
        return null;
    }

    // A read/write handle for a file. If it's open in an editor, go through the
    // editor so unsaved changes aren't clobbered; otherwise touch the file.
    fileTarget(file) {
        const editor = this.findOpenEditor(file);
        if (editor) {
            return { read: async () => editor.getValue(), write: async (c) => editor.setValue(c) };
        }
        return {
            read: () => this.app.vault.read(file),
            write: (c) => this.app.vault.modify(file, c),
        };
    }

    clearBeeminderTimer() {
        if (this.beeminderTimer !== null) {
            window.clearTimeout(this.beeminderTimer);
            this.beeminderTimer = null;
        }
    }

    // The nightly jobs (Beeminder submission, daily to-do sweep) run on the
    // review schedule: a day closes at midnight — the start of the next day —
    // and the job then processes the day that just ended, so anything written
    // late in the evening is included. The boundary is always in the future,
    // at most 24h away, so the delay fits setTimeout's cap.
    nextDayClose() {
        return obsidian.moment().startOf('day').add(1, 'day');
    }

    // The day that most recently closed: yesterday.
    lastClosedDay() {
        return obsidian.moment().startOf('day').subtract(1, 'day');
    }

    // (Re)arm a timer that fires at midnight, submits the day that just ended,
    // then re-arms itself.
    scheduleBeeminderSubmission() {
        this.clearBeeminderTimer();
        if (!this.settings.beeminder.enabled) return;
        const now = obsidian.moment();
        const next = this.nextDayClose();
        const target = next.clone().subtract(1, 'day');
        this.beeminderTimer = window.setTimeout(async () => {
            // Mobile (iOS) suspends timers while the app is backgrounded; on
            // resume a pending setTimeout fires immediately rather than at its
            // intended instant, so it can go off long before the deadline. Trust
            // the wall clock, not the firing: only submit once we've actually
            // reached the deadline, and never re-send a day already stamped.
            // Otherwise just re-arm, which recomputes the correct remaining delay.
            if (obsidian.moment().isSameOrAfter(next) &&
                this.settings.beeminder.lastSubmittedDaystamp !== target.format('YYYYMMDD')) {
                await this.runBeeminderSubmission('scheduled day-close 12AM', target);
            }
            this.scheduleBeeminderSubmission();
        }, next.diff(now));
    }

    // If a midnight submission was missed (Obsidian closed at the time), catch
    // up on open by submitting for the day that most recently closed.
    async maybeCatchUpBeeminder() {
        if (!this.settings.beeminder.enabled) return;
        const mostRecent = this.lastClosedDay();
        // Timers are unreliable on mobile and this runs only once per cold start,
        // so a multi-day absence (phone away for a weekend) would otherwise lose
        // every day but the last. Walk back a week and submit each day whose note
        // exists; runBeeminderSubmission() skips days with no note (no clobber),
        // and the stable per-day requestid makes re-sending an unchanged day a
        // harmless overwrite — so this also self-heals notes that sync in late.
        // Oldest-first so lastSubmittedDaystamp ends at the most recent day.
        for (let i = 6; i >= 0; i--) {
            await this.runBeeminderSubmission('catch-up on open', mostRecent.clone().subtract(i, 'day'));
        }
    }

    async runBeeminderSubmission(reason, targetMoment = null, notify = false) {
        const s = this.settings.beeminder;
        if (!s.enabled) return;
        const authToken = this.beeminderAuthToken();
        if (!authToken || !s.username || !s.goalName) {
            if (notify) new obsidian.Notice('Factotum: Beeminder not configured (token, user, and goal required).');
            return;
        }
        const config = getDailyNoteConfig(this.app);
        if (!config) {
            if (notify) new obsidian.Notice('Factotum: could not find a Daily Notes / Periodic Notes config.');
            return;
        }
        const day = targetMoment || obsidian.moment();
        // On a phone the day's note may not have synced yet (or was never opened
        // on this device). readWordCount() would report a missing file as 0, and
        // because submitToBeeminder() uses a stable per-day requestid, sending 0
        // OVERWRITES a real value another device already submitted for this day —
        // silently destroying the count. Treat an absent note as "data not here
        // yet": skip without stamping, so a later open or midnight timer retries once
        // the note arrives. (Mirrors the weekly review's empty-week guard.) A
        // present-but-empty note is genuine 0 and still submits.
        const notePath = dailyNotePath(config, day);
        const noteFile = this.app.vault.getAbstractFileByPath(notePath);
        if (!(noteFile instanceof obsidian.TFile)) {
            if (notify) new obsidian.Notice(`Factotum: no daily note for ${day.format('YYYY-MM-DD')} yet — nothing sent.`);
            return;
        }
        const noteWords = countWords(await this.app.vault.cachedRead(noteFile));
        const templatePath = resolveTemplatePath(s.templatePath || config.template);
        const templateWords = await readWordCount(this.app, templatePath);
        const value = Math.max(0, noteWords - templateWords);
        const daystamp = day.format('YYYYMMDD');
        const comment = `daily note word count: ${noteWords} − ${templateWords} (template) [${reason}]`;

        try {
            const res = await submitToBeeminder(s, authToken, value, daystamp, comment);
            if (res.status >= 200 && res.status < 300) {
                s.lastSubmittedDaystamp = daystamp;
                await this.saveSettings();
                if (notify) new obsidian.Notice(`Factotum: sent ${value} words to Beeminder ✓`);
            } else {
                // Background runs stay silent (they retry on the next open/timer);
                // the console keeps the record. Manual "Send now" surfaces it.
                if (notify) new obsidian.Notice(`Factotum: Beeminder rejected the submission (HTTP ${res.status}).`);
                console.error('Factotum — Beeminder error', res.status, res.text);
            }
        } catch (e) {
            if (notify) new obsidian.Notice('Factotum: Beeminder submission failed (network error).');
            console.error('Factotum — Beeminder request failed', e);
        }
    }

    clearSweepTimer() {
        if (this.sweepTimer !== null) {
            window.clearTimeout(this.sweepTimer);
            this.sweepTimer = null;
        }
    }

    // (Re)arm a timer that fires at midnight, sweeps the daily note of the day
    // that just ended, then re-arms — the Beeminder schedule, with the same
    // suspended-app guard.
    scheduleDailySweep() {
        this.clearSweepTimer();
        if (!this.settings.dailySweep.enabled) return;
        const now = obsidian.moment();
        const next = this.nextDayClose();
        const target = next.clone().subtract(1, 'day');
        this.sweepTimer = window.setTimeout(async () => {
            if (obsidian.moment().isSameOrAfter(next) &&
                this.settings.dailySweep.lastSweptDaystamp !== target.format('YYYYMMDD')) {
                await this.runDailySweep('scheduled day-close 12AM', target);
            }
            this.scheduleDailySweep();
        }, next.diff(now));
    }

    // If a midnight sweep was missed (Obsidian closed, or a phone whose timers
    // never fired), catch up on open: every day since the last one swept,
    // up to a week back, oldest first. On first enable only the most recent
    // night is swept — nothing older gets dragged in. Days whose note is
    // missing are skipped without a stamp, so a note that syncs in late is
    // picked up by a later open. Each day is one Claude call, so this waits
    // for sync to settle first — another device may have swept already, and
    // the TODO note it wrote to should land before this one writes.
    async maybeCatchUpDailySweep() {
        const s = this.settings.dailySweep;
        if (!s.enabled) return;
        const mostRecent = this.lastClosedDay();
        const back = s.lastSweptDaystamp ? 6 : 0;
        await this.waitForSyncSettled();
        if (!s.enabled) return;
        for (let i = back; i >= 0; i--) {
            const day = mostRecent.clone().subtract(i, 'day');
            if (day.format('YYYYMMDD') <= s.lastSweptDaystamp) continue;
            await this.runDailySweep('catch-up on open', day);
        }
    }

    // Sweep one day's daily note into the TODO note's Inbox. Scheduled and
    // catch-up runs pass the day and stamp it afterwards; a manual run (no
    // day → today) never stamps, so the night's scheduled sweep still picks
    // up anything written later in the day — Claude sees the TODO note and
    // skips what the manual run already captured.
    async runDailySweep(reason, targetMoment = null, notify = false) {
        if (this.sweepRunning) {
            if (notify) new obsidian.Notice('Factotum: a sweep is already running.');
            return;
        }
        this.sweepRunning = true;
        try {
            await this.doDailySweep(reason, targetMoment, notify);
        } finally {
            this.sweepRunning = false;
        }
    }

    async doDailySweep(reason, targetMoment, notify) {
        const s = this.settings.dailySweep;
        const apiKey = this.anthropicApiKey();
        if (!apiKey) {
            if (notify) new obsidian.Notice('Factotum: the daily sweep needs an Anthropic API key.');
            return;
        }
        const todoFile = this.resolveTodoNote();
        if (!todoFile) {
            if (notify) new obsidian.Notice('Factotum: set a TODO note path in settings first.');
            return;
        }
        const config = getDailyNoteConfig(this.app);
        if (!config) {
            if (notify) new obsidian.Notice('Factotum: could not find a Daily Notes / Periodic Notes config.');
            return;
        }
        const day = targetMoment || obsidian.moment();
        const daystamp = day.format('YYYYMMDD');
        const stamp = async () => {
            if (!targetMoment || daystamp <= s.lastSweptDaystamp) return;
            s.lastSweptDaystamp = daystamp;
            await this.saveSettings();
        };
        const noteFile = this.app.vault.getAbstractFileByPath(dailyNotePath(config, day));
        if (!(noteFile instanceof obsidian.TFile)) {
            if (notify) new obsidian.Notice(`Factotum: no daily note for ${day.format('YYYY-MM-DD')} yet — nothing to sweep.`);
            return;
        }
        const noteText = await this.app.vault.cachedRead(noteFile);
        // An untouched template has nothing to extract — don't spend a call.
        const templatePath = resolveTemplatePath(this.settings.beeminder.templatePath || config.template);
        if (countWords(noteText) - await readWordCount(this.app, templatePath) <= 0) {
            if (notify) new obsidian.Notice(`Factotum: nothing written in ${day.format('YYYY-MM-DD')}'s note yet — nothing to sweep.`);
            await stamp();
            return;
        }

        const target = this.fileTarget(todoFile);
        const todoBefore = await target.read();
        const MAX_TODO_CHARS = 60000;
        const todoContext = todoBefore.length > MAX_TODO_CHARS
            ? todoBefore.slice(0, MAX_TODO_CHARS) + '\n…(truncated)'
            : todoBefore;
        const user =
            `Daily note for ${day.format('YYYY-MM-DD')}:\n\n${stripFrontmatter(noteText)}\n\n---\n\n` +
            `Current TODO note (skip anything already captured here, in any wording):\n\n${todoContext}`;

        let res;
        try {
            res = await callClaude(apiKey, this.settings.anthropic.model, SWEEP_SYSTEM, user);
        } catch (e) {
            if (notify) new obsidian.Notice('Factotum: the sweep could not reach Claude (network error).');
            console.error('Factotum — daily sweep request failed', e);
            return;
        }
        if (!res.ok) {
            if (notify) new obsidian.Notice(`Factotum: Claude API error during the sweep (HTTP ${res.status}).`);
            console.error('Factotum — daily sweep API error', res.status);
            return;
        }
        const found = parseSweepItems(res.text);
        if (!found) {
            if (notify) new obsidian.Notice('Factotum: Claude\'s sweep response couldn\'t be parsed.');
            console.error('Factotum — unparseable sweep response', res.text);
            return;
        }

        // The call takes a while; re-read so an edit made meanwhile isn't
        // clobbered, and drop anything now literally present in the note.
        const todoNow = await target.read();
        const haystack = todoNow.toLowerCase();
        const fresh = found.filter(t => !haystack.includes(t.toLowerCase()));
        if (fresh.length === 0) {
            if (notify) new obsidian.Notice(`Factotum: no new to-dos in ${day.format('YYYY-MM-DD')}'s note.`);
            await stamp();
            return;
        }
        const link = s.linkSource ? ` ([[${this.app.metadataCache.fileToLinktext(noteFile, todoFile.path)}]])` : '';
        const items = fresh.map(t => ({ text: t + link, isTask: true, children: [] }));
        await target.write(appendToInbox(todoNow, items));
        await stamp();
        console.log(`Factotum — swept ${fresh.length} to-do(s) from ${noteFile.path} into ${todoFile.path} [${reason}]`);
        if (notify) new obsidian.Notice(`Factotum: added ${fresh.length} to-do${fresh.length === 1 ? '' : 's'} to the Inbox ✓`);
    }

    clearReviewTimer(kind) {
        if (this.reviewTimers[kind] != null) {
            window.clearTimeout(this.reviewTimers[kind]);
            this.reviewTimers[kind] = null;
        }
    }

    clearAllReviewTimers() {
        for (const kind of Object.keys(REVIEW_KINDS)) this.clearReviewTimer(kind);
    }

    // A review generated on another device may still be syncing down when this
    // device opens (or wakes and fires its pending timers), and generating
    // before it lands writes a duplicate. Resolves once the vault looks
    // settled: no vault file event for a quiet window, and — when the official
    // Obsidian Sync plugin is enabled — it no longer reports activity. Vault
    // quiet also covers external sync tools (Syncthing, iCloud, git), whose
    // downloads surface as vault events. Capped so an offline device still
    // reviews eventually. Concurrent callers (the per-kind catch-ups on open)
    // share one wait.
    waitForSyncSettled() {
        if (this.syncSettling) return this.syncSettling;
        const QUIET_MS = 10 * 1000;
        const MAX_WAIT_MS = 3 * 60 * 1000;
        this.syncSettling = new Promise((resolve) => {
            let quietTimer = null;
            let capTimer = null;
            const refs = ['create', 'modify', 'delete', 'rename']
                .map(ev => this.app.vault.on(ev, () => armQuiet()));
            refs.forEach(r => this.registerEvent(r));
            const finish = () => {
                window.clearTimeout(quietTimer);
                window.clearTimeout(capTimer);
                refs.forEach(r => this.app.vault.offref(r));
                this.syncSettling = null;
                resolve();
            };
            // Sync's status API is undocumented internals — read defensively;
            // no readable signal just means it can't hold up the wait.
            const syncBusy = () => {
                try {
                    const p = this.app.internalPlugins?.plugins?.sync;
                    if (!p?.enabled || !p.instance) return false;
                    const status = p.instance.getStatus?.() ?? p.instance.syncStatus;
                    return typeof status === 'string' && status !== '' &&
                        status !== 'Fully synced' && status !== 'Paused';
                } catch (e) {
                    return false;
                }
            };
            const armQuiet = () => {
                window.clearTimeout(quietTimer);
                quietTimer = window.setTimeout(() => syncBusy() ? armQuiet() : finish(), QUIET_MS);
            };
            capTimer = window.setTimeout(finish, MAX_WAIT_MS);
            armQuiet();
        });
        return this.syncSettling;
    }

    // The instant the current period closes: the first day of the next one at
    // 00:00 (Monday for weeks; the 1st for months, quarters, and years).
    // Reviewing at the start of the new period captures everything written late
    // on its last day.
    nextReviewDeadline(kind) {
        const k = REVIEW_KINDS[kind];
        return addPeriods(k, periodStart(k, obsidian.moment()), 1);
    }

    // (Re)arm a timer toward the period-close boundary, review the period that
    // just ended, then re-arm. The delay to a month/quarter/year boundary can
    // exceed setTimeout's 32-bit millisecond cap (~24.8 days) — an overflowed
    // timeout fires immediately — so wake at most every 24 hours and re-arm
    // until the boundary is actually reached; the wall-clock guard below makes
    // early wakes harmless.
    scheduleReview(kind) {
        this.clearReviewTimer(kind);
        const k = REVIEW_KINDS[kind];
        if (!this.settings[k.settingsKey].enabled) return;
        const now = obsidian.moment();
        let next = this.nextReviewDeadline(kind);
        if (next.isSameOrBefore(now)) next = addPeriods(k, next, 1);
        // The period to review is the one that just closed; its last day is the
        // day before the boundary. Capture it so a late-firing timer (e.g.
        // after a sleep/wake) still reviews that period rather than rolling
        // forward into the new one.
        const target = next.clone().subtract(1, 'day');
        const delay = Math.min(next.diff(now), 24 * 60 * 60 * 1000);
        this.reviewTimers[kind] = window.setTimeout(async () => {
            // As with the Beeminder timer: a suspended mobile app fires pending
            // timeouts on resume, before their instant. Only review once the
            // period has actually closed, and never re-review one already
            // stamped. Otherwise just re-arm with the recomputed delay.
            if (obsidian.moment().isSameOrAfter(next) &&
                this.settings[k.settingsKey][k.stampField] !== periodStampOf(k, target)) {
                await this.generateReview(kind, `scheduled ${kind}-close 12AM`, target);
            }
            this.scheduleReview(kind);
        }, delay);
    }

    // If a period-close run was missed (Obsidian closed at the boundary), catch
    // up on open by generating for the most recent period that already closed.
    // For long spans this reaches far back: enabling the decade review in 2026
    // targets the 2010s — same semantics as enabling yearly mid-year. A span
    // with no source notes writes nothing and sets no stamp, so it re-scans
    // (cheaply) each startup until notes exist.
    async maybeCatchUpReview(kind) {
        const k = REVIEW_KINDS[kind];
        if (!this.settings[k.settingsKey].enabled) return;
        const now = obsidian.moment();
        let deadline = this.nextReviewDeadline(kind);
        if (deadline.isAfter(now)) deadline = addPeriods(k, deadline, -1);
        // The just-closed period's last day is the day before that boundary.
        const target = deadline.clone().subtract(1, 'day');
        if (this.settings[k.settingsKey][k.stampField] !== periodStampOf(k, target)) {
            await this.generateReview(kind, 'catch-up on open', target);
        }
    }

    // The review's input: daily notes, with the oldest content consolidated
    // into already-generated review notes when the whole span won't fit the
    // context budget. Rather than switching the entire span to weekly reviews
    // at once, only as much of the past as the budget requires is coarsened —
    // the oldest week of daily notes is replaced by its weekly review, then
    // the next-oldest, and (for long spans) the oldest weeks escalate to
    // monthly, quarterly, … reviews (k.sourceLadder, finest first). The
    // result reads oldest-and-coarsest to newest-and-finest: e.g. a decade as
    // yearly reviews, then recent monthlies, then the last months day by day.
    //
    // Review notes are read from their kinds' configured folders even if the
    // kind is disabled (notes may exist from past or manual runs). Sizes are
    // first estimated from stat metadata (body + frontmatter — a safe
    // overestimate) so planning doesn't read the whole span; the read pass
    // enforces the budget on real sizes and truncates (keeping the
    // chronological head) if even the coarsest mix overflows. A consolidated
    // period whose review note doesn't exist drops out of the input — the
    // finer notes it replaced no longer fit anyway. Boundary periods are
    // included whole (the ISO week holding a decade's Jan 1 reaches a few
    // days into the prior decade — harmless, and simpler than clipping).
    // `sections` is empty if no source notes exist at any granularity.
    async collectLadderSections(kind, config, spanStart, lastDay) {
        const k = REVIEW_KINDS[kind];
        const rungs = ['day', ...(k.sourceLadder || [])];

        // Metadata pass: one entry per existing daily note in the span,
        // oldest first — a century's daily rung is ~36,500 dates, so walk one
        // mutating moment rather than an array of them. `est` approximates
        // the section's size without reading the file.
        const entries = [];
        {
            const d = spanStart.clone().startOf('day');
            const last = lastDay.clone().startOf('day');
            while (d.isSameOrBefore(last)) {
                const file = this.app.vault.getAbstractFileByPath(dailyNotePath(config, d));
                if (file instanceof obsidian.TFile) {
                    entries.push({ rung: 'day', start: d.clone(), file, est: file.stat.size + 40 });
                }
                d.add(1, 'day');
            }
        }

        // Consolidate until the estimated total fits, always taking the
        // oldest entry of the finest granularity still present: every day
        // becomes part of its weekly review before any week escalates to a
        // month, and so on up the ladder. Entries stay sorted by start date,
        // and because each level is consumed from its old end, granularity is
        // monotonic — coarsest at the far end of the span, finest nearest the
        // present.
        let total = entries.reduce((n, e) => n + e.est, 0);
        let missing = 0;
        while (total > REVIEW_INPUT_CHAR_BUDGET && entries.length > 0) {
            let fi = rungs.length - 1, i = -1;
            for (let j = 0; j < entries.length; j++) {
                const r = rungs.indexOf(entries[j].rung);
                if (r < fi) { fi = r; i = j; }
            }
            if (i < 0) break; // everything already coarsest — truncate below
            const head = entries[i];
            const nk = REVIEW_KINDS[rungs[fi + 1]];
            // Don't let the target period reach before the span, or back into
            // territory the previous (coarser) entry already covers.
            let floor = spanStart;
            if (i > 0) {
                const prevEnd = addPeriods(REVIEW_KINDS[entries[i - 1].rung], entries[i - 1].start, 1);
                if (prevEnd.isAfter(floor)) floor = prevEnd;
            }
            const anchor = head.start.isBefore(floor) ? floor : head.start;
            const P = periodStart(nk, anchor);
            const Pend = addPeriods(nk, P, 1);
            while (entries.length > i && entries[i].start.isBefore(Pend)) {
                total -= entries[i].est;
                entries.splice(i, 1);
            }
            const stamp = periodStampOf(nk, P);
            const file = this.app.vault.getAbstractFileByPath(reviewNotePath(this.settings[nk.settingsKey].folder, stamp));
            if (file instanceof obsidian.TFile) {
                const e = { rung: rungs[fi + 1], start: P, stamp, file, est: file.stat.size + 40 };
                entries.splice(i, 0, e);
                total += e.est;
            } else {
                missing++;
            }
        }
        if (missing > 0) {
            console.warn(`Factotum — ${kind} review: ${missing} consolidated period(s) had no review note to stand in for their notes; those parts of the span are omitted.`);
        }

        // Read pass: build the sections in chronological order, enforcing the
        // budget on real (frontmatter-stripped) sizes.
        const sections = [];
        const used = new Set();
        let chars = 0;
        for (const e of entries) {
            const body = stripFrontmatter(await this.app.vault.cachedRead(e.file)).trim();
            if (!body) continue;
            const heading = e.rung === 'day'
                ? `### ${e.start.format('dddd, YYYY-MM-DD')}`
                : `### ${REVIEW_KINDS[e.rung].title} — ${e.stamp}`;
            const section = `${heading}\n${body}`;
            chars += section.length + 2;
            if (chars > REVIEW_INPUT_CHAR_BUDGET) {
                console.warn(`Factotum — ${kind} review input exceeds the context budget even fully consolidated; truncating.`);
                break;
            }
            sections.push(section);
            used.add(e.rung);
        }

        // 'quarterly reviews, weekly reviews, and daily notes' — coarsest
        // first, matching the chronological order of the sections.
        const parts = rungs.slice().reverse().filter(r => used.has(r))
            .map(r => r === 'day' ? 'daily notes' : `${REVIEW_KINDS[r].adjLabel} reviews`);
        const sourceLabel = parts.length > 1
            ? parts.slice(0, -1).join(', ') + (parts.length > 2 ? ', and ' : ' and ') + parts[parts.length - 1]
            : (parts[0] || 'daily notes');
        return { sections, sourceLabel };
    }

    // `recordStamp: false` is for reviews of long-past periods: they must not
    // write their (old) stamp into the done-marker, which tracks the current
    // scheduling cycle.
    async generateReview(kind, reason, lastDayMoment = null, notify = false, recordStamp = true) {
        const k = REVIEW_KINDS[kind];
        const s = this.settings[k.settingsKey];
        if (!s.enabled) return;
        // Automatic runs (scheduled and catch-up) hold off until sync has
        // settled, so a review already written on another device can land
        // before the exists-check below looks for it. Manual runs are the
        // user asking for a review right now — no wait.
        if (!notify) {
            await this.waitForSyncSettled();
            if (!s.enabled) return; // may have been toggled off during the wait
        }
        if (!this.anthropicApiKey()) {
            if (notify) new obsidian.Notice(`Factotum: the ${k.adjLabel} review needs an Anthropic API key.`);
            return;
        }
        const config = getDailyNoteConfig(this.app);
        if (!config) {
            if (notify) new obsidian.Notice('Factotum: could not find a Daily Notes / Periodic Notes config.');
            return;
        }

        // Scheduled/catch-up runs pass the closed period's last day; manual
        // runs anchor at today, reviewing the current period's days so far
        // (collection stops at the anchor day).
        const day = lastDayMoment || obsidian.moment();
        const stamp = periodStampOf(k, day);
        const spanStart = periodStart(k, day);
        const lastDay = day.clone().startOf('day');

        // The review note file is the durable, synced source of truth for
        // "this period is reviewed" — not the stamp field, which lives in
        // data.json and syncs separately. If a note for this period already
        // exists, an automatic (scheduled/catch-up) run must NOT regenerate
        // over it: that note may have been written on another device and
        // synced here before this device's stamp caught up, and it may hold
        // notes the user added. Just record the period as done locally and stop.
        if (!notify && this.app.vault.getAbstractFileByPath(reviewNotePath(s.folder, stamp)) instanceof obsidian.TFile) {
            s[k.stampField] = stamp;
            await this.saveSettings();
            return;
        }

        const { sections, sourceLabel } = await this.collectLadderSections(kind, config, spanStart, lastDay);

        if (sections.length === 0) {
            // Don't stamp the period as done — notes may just not be available
            // yet (vault still indexing, or sync lag from another device).
            // Leaving the stamp unset lets a later open re-scan and review once
            // notes arrive.
            if (notify) new obsidian.Notice(`Factotum: no source notes found for ${stamp}.`);
            return;
        }

        // Read the goals section so Claude can pose a review question per goal.
        const goalsText = await readEmbeddedSection(this.app, s.goalsSource);
        const goalsBlock = goalsText
            ? `\n\nThe user's goals (write exactly one review question for each):\n${goalsText}`
            : '';
        const range = `${spanStart.format('YYYY-MM-DD')} to ${lastDay.format('YYYY-MM-DD')}`;
        // "the week of 2026-W23" reads well; "the decade of 2020s" doesn't.
        const spanPhrase = k.yearsSpan ? `the ${k.noun} ${stamp}` : `the ${k.noun} of ${stamp}`;
        const sourceIntro = sourceLabel[0].toUpperCase() + sourceLabel.slice(1);
        const userContent = `${sourceIntro} for ${spanPhrase} (${range}):\n\n${sections.join('\n\n')}${goalsBlock}`;

        new obsidian.Notice(`Factotum: generating ${k.adjLabel} review for ${stamp}…`);
        let result;
        try {
            result = await callClaude(this.anthropicApiKey(), this.settings.anthropic.model, reviewSystem(k, sourceLabel, !!goalsText), userContent);
        } catch (e) {
            new obsidian.Notice(`Factotum: ${k.adjLabel} review request failed (network error).`);
            console.error('Factotum — Claude request failed', e);
            return;
        }
        if (!result.ok) {
            new obsidian.Notice(`Factotum: Claude API error (HTTP ${result.status}).`);
            console.error('Factotum — Claude API error', result.status);
            return;
        }
        const reviewBody = result.text.trim();
        if (!reviewBody) {
            // Empty/non-text response — don't write a hollow note or stamp the period.
            new obsidian.Notice('Factotum: Claude returned an empty response; no review written.');
            console.error('Factotum — empty Claude response');
            return;
        }

        const generated = obsidian.moment().format('YYYY-MM-DD HH:mm');
        // Copy the linked section's current text into the note rather than
        // writing a live ![[...]] embed: goals drift over time, and each
        // review should preserve what they were when it was written. If the
        // link doesn't resolve, fall back to the literal embed.
        let embed = '';
        if (s.headerEmbed) {
            const headerText = await readEmbeddedSection(this.app, s.headerEmbed);
            embed = headerText
                ? `## ${embedHeadingLabel(s.headerEmbed)}\n\n${headerText}\n\n`
                : `${s.headerEmbed}\n\n`;
        }
        // A configured question list is the user's standing questions, not
        // Claude's — copied in verbatim as its own section, headed by the
        // linked note's title, after the generated review.
        let questionsSection = '';
        if (s.questionsSource) {
            const questionsText = await readEmbeddedSection(this.app, s.questionsSource);
            if (questionsText) {
                questionsSection = `\n\n## ${embedHeadingLabel(s.questionsSource, 'Questions')}\n\n${questionsText}`;
            } else {
                new obsidian.Notice(`Factotum: question list ${s.questionsSource} not found or empty; section omitted.`);
            }
        }
        const note = `---\n${kind}: ${stamp}\nrange: ${range}\nsource: ${sourceLabel}\ngenerated: ${generated}\n---\n\n# ${k.title} — ${stamp}\n\n${embed}${reviewBody}${questionsSection}\n`;

        try {
            const file = await this.writeReviewNote(s.folder, stamp, note);
            if (recordStamp) {
                s[k.stampField] = stamp;
                await this.saveSettings();
            }
            new obsidian.Notice(`Factotum: ${k.adjLabel} review for ${stamp} saved ✓`);
            if (notify && file) {
                this.app.workspace.getLeaf(true).openFile(file)
                    .catch(e => console.error('Factotum — could not open review note', e));
            }
        } catch (e) {
            new obsidian.Notice(`Factotum: could not write the ${k.adjLabel} review note.`);
            console.error(`Factotum — ${k.adjLabel} review write failed`, e);
        }
    }

    async writeReviewNote(folder, stamp, content) {
        const dir = (folder || '').replace(/\/+$/, '');
        if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
            // createFolder throws if it already exists — tolerate the race.
            try { await this.app.vault.createFolder(dir); } catch (e) { /* already exists */ }
        }
        // Never overwrite an existing review note — it may hold notes the user
        // added. Automatic runs are already short-circuited before reaching
        // here; a collision means a manual re-run, so write a numbered sibling
        // and leave the original untouched.
        const base = obsidian.normalizePath(dir ? `${dir}/${stamp}` : stamp);
        for (let n = 0; n < 100; n++) {
            const path = n === 0 ? `${base}.md` : `${base} (${n}).md`;
            if (this.app.vault.getAbstractFileByPath(path)) continue;
            try {
                return await this.app.vault.create(path, content);
            } catch (e) {
                // Lost a create race (file appeared between the check and
                // create) — try the next name rather than clobbering it.
            }
        }
        throw new Error(`No free filename for review ${stamp}`);
    }
}

class FactotumSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new obsidian.Setting(containerEl)
            .setName('TODO list')
            .setHeading();

        new obsidian.Setting(containerEl)
            .setName('TODO note path')
            .setDesc('"Add new item" always targets this note, regardless of which note is active. Leave blank to add to the currently open note instead.')
            .addText(t => t
                .setPlaceholder('TODO.md')
                .setValue(this.plugin.settings.todoNotePath)
                .onChange(async (v) => { this.plugin.settings.todoNotePath = v.trim(); await this.plugin.saveSettings(); }));

        new obsidian.Setting(containerEl)
            .setName('Editing')
            .setHeading();

        new obsidian.Setting(containerEl)
            .setName('Scroll offset')
            .setDesc('Keep this many lines visible above and below the cursor while editing (nvim-style scrolloff), so you never type against the top or bottom edge. Set to 0 to disable. Desktop only — ignored on mobile.')
            .addText(t => {
                t.setPlaceholder('10')
                    .setValue(String(this.plugin.settings.scrollOff))
                    .onChange(async (v) => {
                        const n = Math.max(0, Math.floor(Number(v)));
                        this.plugin.settings.scrollOff = Number.isFinite(n) ? n : 0;
                        await this.plugin.saveSettings();
                    });
                t.inputEl.type = 'number';
                t.inputEl.min = '0';
            });

        const rf = this.plugin.settings.reflectionFeed;

        new obsidian.Setting(containerEl)
            .setName('Reflection feed')
            .setHeading();

        containerEl.createEl('p', {
            text: 'An endless, read-only scroll of random notes from your vault — open it with the shuffle ribbon icon or the "Open reflection feed" command. Scroll to draw more; no note repeats until every note has been shown once.',
            cls: 'ordinal-hint',
        });

        new obsidian.Setting(containerEl)
            .setName('Excluded folders')
            .setDesc('Folders never shown in the feed, one per line (subfolders are excluded too) — e.g. Templates, Attachments.')
            .addTextArea(t => {
                t.setPlaceholder('Templates\nAttachments')
                    .setValue(rf.excludeFolders)
                    .onChange(async (v) => { rf.excludeFolders = v; await this.plugin.saveSettings(); });
                t.inputEl.rows = 3;
            });

        new obsidian.Setting(containerEl)
            .setName('Minimum note length')
            .setDesc('Skip notes whose body (ignoring frontmatter) is shorter than this many characters, so empty stubs don\'t clutter the feed.')
            .addText(t => {
                t.setPlaceholder('40')
                    .setValue(String(rf.minChars))
                    .onChange(async (v) => {
                        const n = Math.floor(Number(v));
                        rf.minChars = Number.isFinite(n) && n >= 0 ? n : 0;
                        await this.plugin.saveSettings();
                    });
                t.inputEl.type = 'number';
                t.inputEl.min = '0';
            });

        new obsidian.Setting(containerEl)
            .setName('Notes per load')
            .setDesc('How many notes are drawn each time you near the bottom of the feed.')
            .addText(t => {
                t.setPlaceholder('4')
                    .setValue(String(rf.batchSize))
                    .onChange(async (v) => {
                        const n = Math.floor(Number(v));
                        rf.batchSize = Number.isFinite(n) && n >= 1 ? n : 4;
                        await this.plugin.saveSettings();
                    });
                t.inputEl.type = 'number';
                t.inputEl.min = '1';
            });

        const b = this.plugin.settings.beeminder;

        new obsidian.Setting(containerEl)
            .setName('Beeminder daily word count')
            .setHeading();

        containerEl.createEl('p', {
            text: 'At midnight each night, send the word count of the day that just ended\'s daily note (minus the daily note template\'s word count) to a Beeminder goal.',
            cls: 'ordinal-hint',
        });

        new obsidian.Setting(containerEl)
            .setName('Enable nightly submission')
            .setDesc('Send the count automatically at midnight, and catch up on startup if the app was closed at midnight.')
            .addToggle(t => t
                .setValue(b.enabled)
                .onChange(async (v) => {
                    b.enabled = v;
                    await this.plugin.saveSettings();
                    this.plugin.scheduleBeeminderSubmission();
                }));

        new obsidian.Setting(containerEl)
            .setName('Beeminder auth token')
            .setDesc(`From beeminder.com/api/v1/auth_token.json (or your account settings). ${secretHomeDesc(this.app)}`)
            .addText(t => {
                t.setPlaceholder(this.plugin.beeminderAuthToken() ? '•••••••• (saved; paste to replace)' : 'auth token')
                    .onChange(async (v) => { await this.plugin.storeSecret(SECRET_IDS.beeminderAuthToken, v.trim(), b, 'authToken'); });
                t.inputEl.type = 'password';
            });

        new obsidian.Setting(containerEl)
            .setName('Beeminder username')
            .addText(t => t
                .setPlaceholder('username')
                .setValue(b.username)
                .onChange(async (v) => { b.username = v.trim(); await this.plugin.saveSettings(); }));

        new obsidian.Setting(containerEl)
            .setName('Beeminder goal name')
            .setDesc('The goal slug, e.g. "writing" from beeminder.com/you/writing.')
            .addText(t => t
                .setPlaceholder('goal')
                .setValue(b.goalName)
                .onChange(async (v) => { b.goalName = v.trim(); await this.plugin.saveSettings(); }));

        new obsidian.Setting(containerEl)
            .setName('Daily note template path (optional)')
            .setDesc('Leave blank to auto-detect from your Daily Notes / Periodic Notes settings. Its word count is subtracted from the daily note before sending.')
            .addText(t => t
                .setPlaceholder('Templates/Daily.md')
                .setValue(b.templatePath)
                .onChange(async (v) => { b.templatePath = v.trim(); await this.plugin.saveSettings(); }));

        new obsidian.Setting(containerEl)
            .setName('Send today\'s count now')
            .setDesc('Submit immediately to test your configuration.')
            .addButton(btn => btn
                .setButtonText('Send now')
                .onClick(() => this.plugin.runBeeminderSubmission('manual send', null, true)));

        const a = this.plugin.settings.anthropic;

        new obsidian.Setting(containerEl)
            .setName('Claude reviews')
            .setHeading();

        containerEl.createEl('p', {
            text: 'The "Prioritize with Claude" command, the daily to-do sweep, and the periodic reviews below (weekly, monthly, quarterly, yearly, decade, century) use Claude via the Anthropic API (a few cents per run) and share this API key and model.',
            cls: 'ordinal-hint',
        });

        new obsidian.Setting(containerEl)
            .setName('Anthropic API key')
            .setDesc(`From console.anthropic.com. ${secretHomeDesc(this.app)}`)
            .addText(t => {
                t.setPlaceholder(this.plugin.anthropicApiKey() ? '•••••••• (saved; paste to replace)' : 'sk-ant-...')
                    .onChange(async (v) => { await this.plugin.storeSecret(SECRET_IDS.anthropicApiKey, v.trim(), a, 'apiKey'); });
                t.inputEl.type = 'password';
            });

        new obsidian.Setting(containerEl)
            .setName('Model')
            .setDesc('Anthropic model id, e.g. claude-opus-4-8 or claude-sonnet-4-6.')
            .addText(t => t
                .setPlaceholder('claude-opus-4-8')
                .setValue(a.model)
                .onChange(async (v) => { a.model = v.trim(); await this.plugin.saveSettings(); }));

        const ds = this.plugin.settings.dailySweep;

        new obsidian.Setting(containerEl)
            .setName('Daily to-do sweep')
            .setHeading();

        containerEl.createEl('p', {
            text: 'At midnight each night, read the daily note of the day that just ended, have Claude pull out the to-dos written into it (prose like "I need to remember to…" counts, not just checkboxes), and add them under the Inbox heading of the TODO note above for triage. Items already in the TODO note are skipped. Each item links back to the daily note it came from.',
            cls: 'ordinal-hint',
        });

        new obsidian.Setting(containerEl)
            .setName('Enable nightly sweep')
            .setDesc('Sweep automatically at midnight, and catch up on startup for nights the app was closed (up to a week back). Needs the TODO note path and the API key above.')
            .addToggle(t => t
                .setValue(ds.enabled)
                .onChange(async (v) => {
                    ds.enabled = v;
                    await this.plugin.saveSettings();
                    this.plugin.scheduleDailySweep();
                }));

        new obsidian.Setting(containerEl)
            .setName('Link each item to its daily note')
            .setDesc('Append a wiki link like ([[2026-09-12]]) so an Inbox item can be traced back to the day it was written.')
            .addToggle(t => t
                .setValue(ds.linkSource)
                .onChange(async (v) => { ds.linkSource = v; await this.plugin.saveSettings(); }));

        new obsidian.Setting(containerEl)
            .setName('Sweep today\'s note now')
            .setDesc('Run immediately on today\'s note to test your configuration. A manual sweep doesn\'t count as the night\'s sweep, so the midnight run still happens.')
            .addButton(btn => btn
                .setButtonText('Sweep now')
                .onClick(() => this.plugin.runDailySweep('manual sweep', null, true)));

        // One settings section per review period, all driven by REVIEW_KINDS.
        const reviewUi = {
            week:    { label: 'Weekly review',    when: 'midnight each Sunday',                                          example: '2026-W23.md' },
            month:   { label: 'Monthly review',   when: 'midnight on the 1st of each month',                             example: '2026-06.md' },
            quarter: { label: 'Quarterly review', when: 'midnight on the first day of each quarter (Jan/Apr/Jul/Oct 1)', example: '2026-Q2.md' },
            year:    { label: 'Yearly review',    when: 'midnight on January 1st',                                       example: '2026.md' },
            decade:  { label: 'Decade review',    when: 'midnight on January 1st of years ending in 0 (2030, 2040, …)',  example: '2020s.md' },
            century: { label: 'Century review',   when: 'midnight on January 1st of years ending in 00 (2100)',          example: '21st Century.md' },
        };
        for (const [kind, ui] of Object.entries(reviewUi)) {
            const k = REVIEW_KINDS[kind];
            const s = this.plugin.settings[k.settingsKey];

            new obsidian.Setting(containerEl)
                .setName(ui.label)
                .setHeading();

            const ladderHint = k.sourceLadder
                ? ` A full ${k.noun} of daily notes usually exceeds Claude's context window, so as many recent daily notes are kept as fit and the older remainder is consolidated into already-written review notes — ${k.sourceLadder.map(r => REVIEW_KINDS[r].adjLabel).join(', then ')} reviews, coarser the farther back they reach — read from those reviews' configured folders.`
                : '';
            containerEl.createEl('p', {
                text: `Just after ${ui.when}, summarize the past ${k.noun}'s daily notes with Claude and write a review note (AI summary, then one review question per goal) to your chosen folder. If the app was closed at the time — including on mobile, where it runs when you next open Obsidian — it catches up on the next open.${ladderHint}`,
                cls: 'ordinal-hint',
            });

            new obsidian.Setting(containerEl)
                .setName(`Enable ${k.adjLabel} review`)
                .setDesc(`Generate automatically when the ${k.noun} closes, with catch-up on startup.`)
                .addToggle(t => t
                    .setValue(s.enabled)
                    .onChange(async (v) => {
                        s.enabled = v;
                        await this.plugin.saveSettings();
                        this.plugin.scheduleReview(kind);
                    }));

            new obsidian.Setting(containerEl)
                .setName('Review folder')
                .setDesc(`Where review notes are saved (e.g. ${ui.example}). Created if missing.`)
                .addText(t => t
                    .setPlaceholder(DEFAULT_SETTINGS[k.settingsKey].folder)
                    .setValue(s.folder)
                    .onChange(async (v) => { s.folder = v.trim(); await this.plugin.saveSettings(); }));

            new obsidian.Setting(containerEl)
                .setName('Header embed (optional)')
                .setDesc('A wiki link like ![[goals#goals]] whose linked section\'s current text is copied to the top of every review, above the AI summary — preserving your goals as they were when the review was written. Leave blank to omit.')
                .addText(t => t
                    .setPlaceholder('![[goals#goals]]')
                    .setValue(s.headerEmbed)
                    .onChange(async (v) => { s.headerEmbed = v.trim(); await this.plugin.saveSettings(); }));

            new obsidian.Setting(containerEl)
                .setName('Goals source (optional)')
                .setDesc('A wiki link like ![[goals#goals]] whose linked section is read so the review ends with one review question per goal. Leave blank to skip the review questions.')
                .addText(t => t
                    .setPlaceholder('![[goals#goals]]')
                    .setValue(s.goalsSource)
                    .onChange(async (v) => { s.goalsSource = v.trim(); await this.plugin.saveSettings(); }));

            // Only kinds whose defaults declare a question list (year, decade)
            // offer one.
            if ('questionsSource' in DEFAULT_SETTINGS[k.settingsKey]) {
                new obsidian.Setting(containerEl)
                    .setName('Question list (optional)')
                    .setDesc('A wiki link like [[Annual Questions]] to a note of questions. Its text is copied to the bottom of every review as its own section, headed by the note\'s title. Leave blank to omit.')
                    .addText(t => t
                        .setPlaceholder('[[Annual Questions]]')
                        .setValue(s.questionsSource)
                        .onChange(async (v) => { s.questionsSource = v.trim(); await this.plugin.saveSettings(); }));
            }

            new obsidian.Setting(containerEl)
                .setName(`Generate this ${k.noun}'s review now`)
                .setDesc(`Build the review immediately (covering the ${k.noun} so far) to test your configuration.`)
                .addButton(btn => btn
                    .setButtonText('Generate now')
                    .onClick(() => this.plugin.generateReview(kind, 'manual', null, true)));

            let pastDate = '';
            new obsidian.Setting(containerEl)
                .setName(`Generate a past ${k.noun}'s review`)
                .setDesc(`Build the review for the ${k.noun} containing the given date — e.g. 2019, 2019-06, or 2019-06-15 — from the notes of that time. Doesn't touch the schedule; an existing note gets a numbered sibling.`)
                .addText(t => t
                    .setPlaceholder('YYYY-MM-DD')
                    .onChange(v => { pastDate = v.trim(); }))
                .addButton(btn => btn
                    .setButtonText('Generate past review')
                    .onClick(() => {
                        const m = obsidian.moment(pastDate, ['YYYY-MM-DD', 'YYYY-MM', 'YYYY'], true);
                        if (!m.isValid()) {
                            new obsidian.Notice('Factotum: enter a date like 2019, 2019-06, or 2019-06-15.');
                            return;
                        }
                        const today = obsidian.moment().startOf('day');
                        const start = periodStart(k, m);
                        if (start.isAfter(today)) {
                            new obsidian.Notice(`Factotum: that ${k.noun} hasn't started yet.`);
                            return;
                        }
                        // Anchor at the period's last day — or today for the
                        // current period, mirroring "Generate now".
                        let lastDay = addPeriods(k, start, 1).subtract(1, 'day');
                        if (lastDay.isAfter(today)) lastDay = today;
                        this.plugin.generateReview(kind, 'manual past', lastDay, true, false);
                    }));
        }
    }
}

module.exports = DrakeFactotumPlugin;
