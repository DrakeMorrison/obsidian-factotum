'use strict';

var obsidian = require('obsidian');

// ── Eisenhower matrix config ────────────────────────────────────────────────

const QUADRANTS = [
    { key: 'Q1', heading: 'Do — Urgent & Important',          urgent: true,  important: true  },
    { key: 'Q2', heading: 'Schedule — Important, Not Urgent', urgent: false, important: true  },
    { key: 'Q3', heading: 'Delegate — Urgent, Not Important', urgent: true,  important: false },
    { key: 'Q4', heading: 'Delete — Neither',                 urgent: false, important: false },
];
const DONE_HEADING = 'Done';
const INBOX_HEADING = 'Inbox';

function classifyHeading(text) {
    const t = text.trim().toLowerCase();
    if (/^inbox\b/.test(t)) return 'inbox';
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
    return out;
}

// ── Markdown parsing / serialization ────────────────────────────────────────

function parseNote(content) {
    const lines = content.split('\n');

    // Detect matrix mode: any heading line that classifies as a quadrant or
    // done. An Inbox heading alone doesn't make a note a matrix — a flat
    // ranked list can have an inbox too.
    let matrixMode = false;
    for (const line of lines) {
        const m = line.match(/^#{1,6}\s+(.+)$/);
        const cls = m ? classifyHeading(m[1]) : null;
        if (cls !== null && cls !== 'inbox') { matrixMode = true; break; }
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
            const m = lines[i].match(/^[-*+] (.+)$/);
            if (!m) { i++; continue; }
            // A top-level bullet owns the contiguous indented lines below it
            // (nested bullets, sub-tasks, continuation text). They travel with
            // it as a block so sorting preserves nested structure.
            const children = [];
            let j = i + 1;
            while (j < lines.length && /^\s+\S/.test(lines[j])) { children.push(lines[j]); j++; }
            i = j;
            let text = m[1].trim();
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

        // Indented lines below a bullet are its nested block — keep them with it.
        if (lastItem && /^\s+\S/.test(line)) { lastItem.children.push(line); continue; }

        const bulletMatch = line.match(/^[-*+] (.+)$/);
        if (bulletMatch) {
            let text = bulletMatch[1].trim();
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
            const bucket = (section === 'preamble' || section === 'done') ? 'Q2' : section;
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
function serializeFlat(content, sortedItems, inboxItems = null) {
    const replacements = sortedItems.map(renderItemBlock);

    const lines = content.split('\n');
    const newLines = [];
    const doneBlocks = [];
    let lastSortedIdx = -1;
    let inboxHeadingIdx = -1;
    let inboxRewritten = false;
    let inInbox = false;
    let idx = 0;
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const h = line.match(/^#{1,6}\s+(.+)$/);
        if (h) {
            inInbox = classifyHeading(h[1]) === 'inbox';
            if (inInbox && inboxHeadingIdx < 0) inboxHeadingIdx = newLines.length;
            newLines.push(line);
            if (inInbox && inboxItems && !inboxRewritten) {
                inboxRewritten = true;
                for (const item of inboxItems) newLines.push(...renderItemBlock(item));
            }
            i++;
        } else if (/^[-*+] \[[xX]\]\s/.test(line)) {
            // Done item: keep its block verbatim and stash it for the tail.
            const block = [line];
            i++;
            while (i < lines.length && /^\s+\S/.test(lines[i])) { block.push(lines[i]); i++; }
            doneBlocks.push(block);
        } else if (inInbox && /^[-*+] /.test(line)) {
            // Inbox bullets are unranked and don't participate in sorting:
            // leave them where they are — unless the caller is rewriting the
            // Inbox, in which case the originals were rendered above.
            const block = [line];
            i++;
            while (i < lines.length && /^\s+\S/.test(lines[i])) { block.push(lines[i]); i++; }
            if (!inboxItems) newLines.push(...block);
        } else if (/^[-*+] /.test(line)) {
            // Active bullet: swap in the next ranked block, dropping the original
            // nested lines (they ride along inside the replacement block).
            i++;
            while (i < lines.length && /^\s+\S/.test(lines[i])) i++;
            if (idx < replacements.length) {
                newLines.push(...replacements[idx++]);
                lastSortedIdx = newLines.length - 1;
            }
        } else {
            newLines.push(line);
            i++;
        }
    }

    const tail = [...replacements.slice(idx), ...doneBlocks].flat();
    if (tail.length > 0) {
        // Prefer right after the last ranked item; with no ranked items at all
        // (e.g. a note whose only bullets were in the Inbox), land above the
        // Inbox heading so placed items don't end up back inside it.
        const insertAt = lastSortedIdx >= 0 ? lastSortedIdx + 1
            : inboxHeadingIdx >= 0 ? inboxHeadingIdx
            : newLines.length;
        newLines.splice(insertAt, 0, ...tail);
    }

    return newLines.join('\n');
}

function serializeMatrix(originalContent, sections) {
    // Preserve everything above the first recognized heading verbatim, and
    // note whether the note keeps its Inbox above the quadrants or below Done
    // so the rewrite leaves it where the user put it.
    const lines = originalContent.split('\n');
    const preamble = [];
    let hadInbox = false;
    let inboxAtTop = false;
    let sawOtherHeading = false;
    for (const line of lines) {
        const m = line.match(/^#{1,6}\s+(.+)$/);
        const cls = m ? classifyHeading(m[1]) : null;
        if (cls === 'inbox') { hadInbox = true; if (!sawOtherHeading) inboxAtTop = true; }
        else if (cls !== null) sawOtherHeading = true;
    }
    // Bullets above the first recognized heading were parsed into sections
    // (Q2, done, …) and will be re-rendered there — skip them (and their
    // nested blocks) here so they aren't duplicated in the preamble.
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^#{1,6}\s+(.+)$/);
        if (m && classifyHeading(m[1]) !== null) break;
        if (/^[-*+] /.test(lines[i])) {
            while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) i++;
            continue;
        }
        preamble.push(lines[i]);
    }
    while (preamble.length && preamble[preamble.length - 1].trim() === '') preamble.pop();

    const out = [];
    if (preamble.length > 0) { out.push(...preamble); out.push(''); }

    const inboxItems = sections.inbox || [];
    const renderInbox = () => {
        out.push(`## ${INBOX_HEADING}`);
        for (const item of inboxItems) out.push(...renderItemBlock(item));
        out.push('');
    };
    // Keep the (possibly emptied) Inbox heading around as a capture spot.
    if ((hadInbox || inboxItems.length > 0) && inboxAtTop) renderInbox();

    for (const q of QUADRANTS) {
        out.push(`## ${q.heading}`);
        for (const item of sections[q.key]) out.push(...renderItemBlock(item));
        out.push('');
    }

    out.push(`## ${DONE_HEADING}`);
    for (const item of sections.done) {
        out.push(`- [x] ${item.text}`);
        if (item.children && item.children.length) out.push(...item.children);
    }

    if ((hadInbox || inboxItems.length > 0) && !inboxAtTop) {
        out.push('');
        renderInbox();
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
        this.currentQuadrantLabel = null;
        // Partial-progress state, so closing mid-session saves what's decided.
        this.finished = false;      // a result was already handed to onComplete
        this.finalResult = null;    // full result shown on the results screen
        this.sortState = null;      // live view into the in-progress merge sort
        this.matrixOut = null;      // matrix mode: quadrants finished so far
        this.currentQuadrantKey = null;

        if (payload.mode === 'flat') {
            const n = Math.max(payload.items.length, 2);
            this.estimatedTotal = n * Math.ceil(Math.log2(n));
        } else {
            let total = 0;
            for (const q of QUADRANTS) {
                const n = payload.sections[q.key].length;
                if (n >= 2) total += n * Math.ceil(Math.log2(n));
            }
            this.estimatedTotal = Math.max(total, 1);
        }
    }

    onOpen() {
        this.modalEl.addClass('ordinal-modal');
        this.run();
    }

    // Closing mid-session keeps every decision made so far: completed merges
    // (and completed quadrants) stay ordered, and whatever wasn't compared yet
    // keeps its current relative order. Zero comparisons → nothing to save.
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

        const out = emptySections();
        out.done = this.payload.sections.done;
        out.inbox = this.payload.sections.inbox;
        this.matrixOut = out;
        for (const q of QUADRANTS) {
            this.currentQuadrantLabel = q.heading;
            this.currentQuadrantKey = q.key;
            const items = this.payload.sections[q.key];
            if (items.length < 2) { out[q.key] = items; continue; }
            out[q.key] = await this.mergeSort(items);
        }
        this.currentQuadrantKey = null;
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
        let reached = false;
        for (const q of QUADRANTS) {
            if (q.key === this.currentQuadrantKey) {
                reached = true;
                sections[q.key] = this.bestEffortSorted() || this.payload.sections[q.key];
            } else {
                // Quadrants before the current one are fully sorted in
                // matrixOut; the ones after haven't been touched.
                sections[q.key] = reached ? this.payload.sections[q.key] : this.matrixOut[q.key];
            }
        }
        return { mode: 'matrix', sections };
    }

    askCompare(a, b) {
        return new Promise(resolve => {
            this.comparisonCount++;
            this.renderComparison(a, b, resolve);
        });
    }

    renderComparison(a, b, resolve) {
        const { contentEl } = this;
        contentEl.empty();

        if (this.currentQuadrantLabel) {
            contentEl.createDiv({
                cls: 'ordinal-quadrant-label',
                text: this.currentQuadrantLabel,
            });
        }
        contentEl.createEl('h2', { text: 'Which matters more to you?' });

        const prog = contentEl.createDiv({ cls: 'ordinal-progress' });
        const fill = prog.createDiv({ cls: 'ordinal-progress-fill' });
        const pct = Math.min(100, (this.comparisonCount / this.estimatedTotal) * 100);
        fill.style.width = `${pct}%`;
        prog.createDiv({
            cls: 'ordinal-progress-label',
            text: `${this.comparisonCount} / ~${this.estimatedTotal}`
        });

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
        contentEl.createEl('h2', { text: '🏆 Ranking Complete' });

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
                text: 'After naming, you\'ll classify it into an Eisenhower quadrant, then binary-search-place it within that quadrant.',
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
        contentEl.createEl('h2', { text: 'Is this urgent?' });
        contentEl.createEl('p', {
            text: 'Urgent things have a hard deadline or consequence if delayed.',
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
        contentEl.createEl('h2', { text: 'Is this important?' });
        contentEl.createEl('p', {
            text: 'Important things move you toward your goals or values.',
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
        const q = findQuadrant(this.urgent, important);
        this.targetQuadrant = q;
        this.sorted = [...this.payload.sections[q.key]];
        this.searchStarted = true;
        this.lo = 0;
        this.hi = this.sorted.length - 1;
        if (this.sorted.length === 0) this.finish(0);
        else this.renderCompare();
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
            ? `"${this.newItem.text}" is ranked #${rank} of ${sortedWithNew.length} in ${placedQuadrant.heading}`
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
        contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: this.progressLabel() });
        contentEl.createEl('h2', { text: item.text });
        contentEl.createEl('p', { text: 'Is this urgent?', cls: 'ordinal-hint' });

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
        contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: this.progressLabel() });
        contentEl.createEl('h2', { text: item.text });
        contentEl.createEl('p', { text: 'Is this important?', cls: 'ordinal-hint' });

        const grid = contentEl.createDiv({ cls: 'ordinal-grid' });
        const yes = grid.createEl('button', { text: 'Yes, important', cls: 'ordinal-choice' });
        grid.createDiv({ cls: 'ordinal-vs', text: '/' });
        const no  = grid.createEl('button', { text: 'No, not important', cls: 'ordinal-choice' });
        yes.addEventListener('click', () => this.classify(true));
        no .addEventListener('click', () => this.classify(false));

        closeHint(contentEl, 'Close anytime — placed items are saved; the rest stay in the Inbox.');
    }

    classify(important) {
        this.targetQuadrant = findQuadrant(this.urgent, important);
        this.startPlacement(this.sections[this.targetQuadrant.key]);
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

        contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: this.progressLabel() });
        if (this.targetQuadrant) {
            contentEl.createDiv({ cls: 'ordinal-quadrant-label', text: this.targetQuadrant.heading });
        }
        contentEl.createEl('h2', { text: 'Which matters more?' });

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
        contentEl.createEl('p', { text: 'Is this urgent?', cls: 'ordinal-hint' });

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
        contentEl.createEl('p', { text: 'Is this important?', cls: 'ordinal-hint' });

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
            text: 'Note will be rewritten with the four Eisenhower headings. Order within each quadrant is unchanged — run a ranking session next to sort each bucket.',
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
            'If recently completed tasks are provided, their #urgent/#important tags show how the user ' +
            'tends to classify similar work. ' +
            'Respond with ONLY a JSON object of the form {"Q1":[3,0],"Q2":[2],"Q3":[],"Q4":[1]} — ' +
            'no prose, no code fences. Every input number must appear exactly once across the four arrays.';

        const taskLines = this.entries.map((e, i) => {
            let s = `${i}. ${e.item.text} (currently: ${e.context})`;
            for (const child of e.item.children || []) s += `\n${child}`;
            return s;
        });
        let user = `Tasks to prioritize:\n\n${taskLines.join('\n')}`;
        const recentDone = this.doneItems.slice(-30);
        if (recentDone.length > 0) {
            user += `\n\nRecently completed (for calibration only — do not include these numbers):\n` +
                recentDone.map(d => `- ${d.text}`).join('\n');
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

// ── Beeminder daily word count ──────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    todoNotePath: '',               // note that "Add new item" targets; blank = active note
    scrollOff: 10,                  // min lines of context kept above/below the cursor (nvim scrolloff); 0 = off
    beeminder: {
        enabled: false,
        authToken: '',
        username: '',
        goalName: '',
        templatePath: '',          // optional override; blank = auto-detect
        lastSubmittedDaystamp: '', // YYYYMMDD of the last successful send
    },
    anthropic: {
        apiKey: '',                // shared by the weekly and monthly reviews
        model: 'claude-opus-4-8',
    },
    weeklyReview: {
        enabled: false,
        folder: 'Weekly Reviews',
        headerEmbed: '![[goals#goals]]', // inserted above the summary; blank to omit
        goalsSource: '![[goals#goals]]', // section read so Claude can pose a review question per goal; blank to omit
        lastReviewWeekstamp: '',   // GGGG-[W]WW of the last created review
    },
    monthlyReview: {
        enabled: false,
        folder: 'Monthly Reviews',
        headerEmbed: '![[goals#goals]]', // inserted above the summary; blank to omit
        goalsSource: '![[goals#goals]]', // section read so Claude can pose a review question per goal; blank to omit
        lastReviewMonthstamp: '',  // YYYY-MM of the last created review
    },
    quarterlyReview: {
        enabled: false,
        folder: 'Quarterly Reviews',
        headerEmbed: '![[goals#goals]]', // inserted above the summary; blank to omit
        goalsSource: '![[goals#goals]]', // section read so Claude can pose a review question per goal; blank to omit
        lastReviewQuarterstamp: '', // YYYY-[Q]Q of the last created review
    },
    yearlyReview: {
        enabled: false,
        folder: 'Yearly Reviews',
        headerEmbed: '![[goals#goals]]', // inserted above the summary; blank to omit
        goalsSource: '![[goals#goals]]', // section read so Claude can pose a review question per goal; blank to omit
        lastReviewYearstamp: '',   // YYYY of the last created review
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

async function submitToBeeminder(s, value, daystamp, comment) {
    const url = `https://www.beeminder.com/api/v1/users/${encodeURIComponent(s.username)}/goals/${encodeURIComponent(s.goalName)}/datapoints.json`;
    const body = new URLSearchParams({
        auth_token: s.authToken,
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

// Every date of the period (a moment unit: 'isoWeek', 'month', 'quarter',
// 'year') containing `lastDayMoment`, from its first day through
// `lastDayMoment` itself — the period's last day for scheduled runs; a
// mid-period manual run just gets the days so far.
function periodDates(lastDayMoment, unit) {
    const dates = [];
    const d = lastDayMoment.clone().startOf(unit);
    const last = lastDayMoment.clone().startOf('day');
    while (d.isSameOrBefore(last)) {
        dates.push(d.clone());
        d.add(1, 'day');
    }
    return dates;
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

// System prompt shared by the weekly and monthly reviews; `period` is the word
// for the span being reviewed ('week' or 'month').
function reviewSystem(period, hasGoals) {
    let s =
        `You are writing a ${period}ly review from a user's Obsidian daily notes. ` +
        'Output GitHub-flavored markdown with the sections described below, in order, and nothing else. ' +
        `First, \`## AI Summary\` — a concise prose recap of the ${period}'s themes, progress, and notable events. `;
    if (hasGoals) {
        s +=
            'Then, `## Review Questions` — under it, write exactly one reflective question per goal ' +
            'provided to you, in the same order as the goals. Render each question as its own `###` heading ' +
            '(the heading text is the question itself), followed by a blank line so the user can write their ' +
            'answer underneath. Each question should prompt the user to assess their progress on that goal ' +
            `this ${period}, grounded in what the notes show. One question per goal, no more, no fewer. `;
    }
    s += 'Do not invent events that are not supported by the notes.';
    return s;
}

// One entry per review period, driving the shared scheduling/generation code.
// `unit` is the moment unit the period spans (startOf(unit) is its first day);
// `addUnit` steps deadline math one period forward; `stampFormat` names the
// review note and the data.json done-marker.
const REVIEW_KINDS = {
    week:    { noun: 'week',    unit: 'isoWeek', addUnit: 'week',    settingsKey: 'weeklyReview',    stampField: 'lastReviewWeekstamp',    stampFormat: 'GGGG-[W]WW', title: 'Weekly Review' },
    month:   { noun: 'month',   unit: 'month',   addUnit: 'month',   settingsKey: 'monthlyReview',   stampField: 'lastReviewMonthstamp',   stampFormat: 'YYYY-MM',    title: 'Monthly Review' },
    quarter: { noun: 'quarter', unit: 'quarter', addUnit: 'quarter', settingsKey: 'quarterlyReview', stampField: 'lastReviewQuarterstamp', stampFormat: 'YYYY-[Q]Q',  title: 'Quarterly Review' },
    year:    { noun: 'year',    unit: 'year',    addUnit: 'year',    settingsKey: 'yearlyReview',    stampField: 'lastReviewYearstamp',    stampFormat: 'YYYY',       title: 'Yearly Review' },
};

class DrakeFactotumPlugin extends obsidian.Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new FactotumSettingTab(this.app, this));
        this.beeminderTimer = null;
        this.reviewTimers = {};
        this.setupScrollOff();
        this.app.workspace.onLayoutReady(() => {
            this.maybeCatchUpBeeminder();
            this.scheduleBeeminderSubmission();
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
                if (totalActiveItems(parsed) < 2) {
                    new obsidian.Notice('Factotum: need at least 2 list items to compare.');
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
            name: 'Add new item (binary-search placement)',
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
                if (!this.settings.anthropic.apiKey) {
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
                new ClaudePrioritizeModal(this.app, parsed, this.settings.anthropic, (result) => {
                    applyResult(editor, content, result);
                    new obsidian.Notice('Factotum: Claude\'s prioritization saved ✓');
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

        console.log('Factotum loaded');
    }

    onunload() {
        this.clearBeeminderTimer();
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

    async loadSettings() {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
        this.settings.beeminder = Object.assign({}, DEFAULT_SETTINGS.beeminder, data?.beeminder);
        this.settings.anthropic = Object.assign({}, DEFAULT_SETTINGS.anthropic, data?.anthropic);
        this.settings.weeklyReview = Object.assign({}, DEFAULT_SETTINGS.weeklyReview, data?.weeklyReview);
        this.settings.monthlyReview = Object.assign({}, DEFAULT_SETTINGS.monthlyReview, data?.monthlyReview);
        this.settings.quarterlyReview = Object.assign({}, DEFAULT_SETTINGS.quarterlyReview, data?.quarterlyReview);
        this.settings.yearlyReview = Object.assign({}, DEFAULT_SETTINGS.yearlyReview, data?.yearlyReview);
        // The API key/model used to live under weeklyReview; they're now shared
        // with the monthly review. Migrate old data forward, then drop the old
        // fields so the next save leaves a single copy of the key.
        if (!this.settings.anthropic.apiKey && data?.weeklyReview?.apiKey) {
            this.settings.anthropic.apiKey = data.weeklyReview.apiKey;
            if (data.weeklyReview.model) this.settings.anthropic.model = data.weeklyReview.model;
        }
        delete this.settings.weeklyReview.apiKey;
        delete this.settings.weeklyReview.model;
    }

    async saveSettings() {
        await this.saveData(this.settings);
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

    // The next 11PM (today's, before it passes; otherwise still today's instant).
    nextBeeminderDeadline() {
        return obsidian.moment().hour(23).minute(0).second(0).millisecond(0);
    }

    // (Re)arm a timer that fires at the next 11PM, submits, then re-arms itself.
    scheduleBeeminderSubmission() {
        this.clearBeeminderTimer();
        if (!this.settings.beeminder.enabled) return;
        const now = obsidian.moment();
        const next = this.nextBeeminderDeadline();
        if (next.isSameOrBefore(now)) next.add(1, 'day');
        const deadline = next.clone();
        this.beeminderTimer = window.setTimeout(async () => {
            // Mobile (iOS) suspends timers while the app is backgrounded; on
            // resume a pending setTimeout fires immediately rather than at its
            // intended instant, so it can go off long before the deadline. Trust
            // the wall clock, not the firing: only submit once we've actually
            // reached the deadline, and never re-send a day already stamped.
            // Otherwise just re-arm, which recomputes the correct remaining delay.
            if (obsidian.moment().isSameOrAfter(deadline) &&
                this.settings.beeminder.lastSubmittedDaystamp !== deadline.format('YYYYMMDD')) {
                await this.runBeeminderSubmission('scheduled 11PM', deadline);
            }
            this.scheduleBeeminderSubmission();
        }, next.diff(now));
    }

    // If a scheduled 11PM submission was missed (Obsidian closed at the time),
    // catch up on open by submitting for the most recent 11PM deadline that has
    // already passed — which is yesterday if it's currently before 11PM today.
    async maybeCatchUpBeeminder() {
        if (!this.settings.beeminder.enabled) return;
        const now = obsidian.moment();
        // Most recent 11PM deadline that has already passed (yesterday's if it's
        // currently before 11PM today).
        const mostRecent = this.nextBeeminderDeadline();
        if (mostRecent.isAfter(now)) mostRecent.subtract(1, 'day');
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
        if (!s.authToken || !s.username || !s.goalName) {
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
        // yet": skip without stamping, so a later open or 11PM timer retries once
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
            const res = await submitToBeeminder(s, value, daystamp, comment);
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

    clearReviewTimer(kind) {
        if (this.reviewTimers[kind] != null) {
            window.clearTimeout(this.reviewTimers[kind]);
            this.reviewTimers[kind] = null;
        }
    }

    clearAllReviewTimers() {
        for (const kind of Object.keys(REVIEW_KINDS)) this.clearReviewTimer(kind);
    }

    // The instant the current period closes: the first day of the next one at
    // 00:00 (Monday for weeks; the 1st for months, quarters, and years).
    // Reviewing at the start of the new period captures everything written late
    // on its last day.
    nextReviewDeadline(kind) {
        const k = REVIEW_KINDS[kind];
        return obsidian.moment().startOf(k.unit).add(1, k.addUnit);
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
        const next = this.nextReviewDeadline(kind);
        if (next.isSameOrBefore(now)) next.add(1, k.addUnit);
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
                this.settings[k.settingsKey][k.stampField] !== target.format(k.stampFormat)) {
                await this.generateReview(kind, `scheduled ${kind}-close 12AM`, target);
            }
            this.scheduleReview(kind);
        }, delay);
    }

    // If a period-close run was missed (Obsidian closed at the boundary), catch
    // up on open by generating for the most recent period that already closed.
    async maybeCatchUpReview(kind) {
        const k = REVIEW_KINDS[kind];
        if (!this.settings[k.settingsKey].enabled) return;
        const now = obsidian.moment();
        const deadline = this.nextReviewDeadline(kind);
        if (deadline.isAfter(now)) deadline.subtract(1, k.addUnit);
        // The just-closed period's last day is the day before that boundary.
        const target = deadline.clone().subtract(1, 'day');
        if (this.settings[k.settingsKey][k.stampField] !== target.format(k.stampFormat)) {
            await this.generateReview(kind, 'catch-up on open', target);
        }
    }

    // The `### <day>` sections Claude reads: one per existing, non-empty daily
    // note among `dates`. Shared by the weekly and monthly reviews.
    async collectDailySections(config, dates) {
        const sections = [];
        for (const d of dates) {
            const file = this.app.vault.getAbstractFileByPath(dailyNotePath(config, d));
            if (!(file instanceof obsidian.TFile)) continue;
            const body = stripFrontmatter(await this.app.vault.cachedRead(file)).trim();
            if (!body) continue;
            sections.push(`### ${d.format('dddd, YYYY-MM-DD')}\n${body}`);
        }
        return sections;
    }

    async generateReview(kind, reason, lastDayMoment = null, notify = false) {
        const k = REVIEW_KINDS[kind];
        const s = this.settings[k.settingsKey];
        if (!s.enabled) return;
        if (!this.settings.anthropic.apiKey) {
            if (notify) new obsidian.Notice(`Factotum: the ${k.noun}ly review needs an Anthropic API key.`);
            return;
        }
        const config = getDailyNoteConfig(this.app);
        if (!config) {
            if (notify) new obsidian.Notice('Factotum: could not find a Daily Notes / Periodic Notes config.');
            return;
        }

        // Scheduled/catch-up runs pass the closed period's last day; manual
        // runs anchor at today, reviewing the current period's days so far
        // (periodDates() stops at the anchor day).
        const day = lastDayMoment || obsidian.moment();
        const stamp = day.format(k.stampFormat);
        const dates = periodDates(day, k.unit);

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

        const sections = await this.collectDailySections(config, dates);

        if (sections.length === 0) {
            // Don't stamp the period as done — notes may just not be available
            // yet (vault still indexing, or sync lag from another device).
            // Leaving the stamp unset lets a later open re-scan and review once
            // notes arrive.
            if (notify) new obsidian.Notice(`Factotum: no daily notes found for ${stamp}.`);
            return;
        }

        // Read the goals section so Claude can pose a review question per goal.
        const goalsText = await readEmbeddedSection(this.app, s.goalsSource);
        const goalsBlock = goalsText
            ? `\n\nThe user's goals (write exactly one review question for each):\n${goalsText}`
            : '';
        const range = `${dates[0].format('YYYY-MM-DD')} to ${dates[dates.length - 1].format('YYYY-MM-DD')}`;
        const userContent = `Daily notes for the ${k.noun} of ${stamp} (${range}):\n\n${sections.join('\n\n')}${goalsBlock}`;

        new obsidian.Notice(`Factotum: generating ${k.noun}ly review for ${stamp}…`);
        let result;
        try {
            result = await callClaude(this.settings.anthropic.apiKey, this.settings.anthropic.model, reviewSystem(k.noun, !!goalsText), userContent);
        } catch (e) {
            new obsidian.Notice(`Factotum: ${k.noun}ly review request failed (network error).`);
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
        const embed = s.headerEmbed ? `${s.headerEmbed}\n\n` : '';
        const note = `---\n${kind}: ${stamp}\nrange: ${range}\ngenerated: ${generated}\n---\n\n# ${k.title} — ${stamp}\n\n${embed}${reviewBody}\n`;

        try {
            const file = await this.writeReviewNote(s.folder, stamp, note);
            s[k.stampField] = stamp;
            await this.saveSettings();
            new obsidian.Notice(`Factotum: ${k.noun}ly review for ${stamp} saved ✓`);
            if (notify && file) {
                this.app.workspace.getLeaf(true).openFile(file)
                    .catch(e => console.error('Factotum — could not open review note', e));
            }
        } catch (e) {
            new obsidian.Notice(`Factotum: could not write the ${k.noun}ly review note.`);
            console.error(`Factotum — ${k.noun}ly review write failed`, e);
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

        const b = this.plugin.settings.beeminder;

        new obsidian.Setting(containerEl)
            .setName('Beeminder daily word count')
            .setHeading();

        containerEl.createEl('p', {
            text: 'At 11PM each night, send the word count of today\'s daily note (minus the daily note template\'s word count) to a Beeminder goal.',
            cls: 'ordinal-hint',
        });

        new obsidian.Setting(containerEl)
            .setName('Enable nightly submission')
            .setDesc('Send the count automatically at 11PM, and catch up on startup if the app was closed at 11PM.')
            .addToggle(t => t
                .setValue(b.enabled)
                .onChange(async (v) => {
                    b.enabled = v;
                    await this.plugin.saveSettings();
                    this.plugin.scheduleBeeminderSubmission();
                }));

        new obsidian.Setting(containerEl)
            .setName('Beeminder auth token')
            .setDesc('From beeminder.com/api/v1/auth_token.json (or your account settings).')
            .addText(t => {
                t.setPlaceholder('auth token')
                    .setValue(b.authToken)
                    .onChange(async (v) => { b.authToken = v.trim(); await this.plugin.saveSettings(); });
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
            text: 'The "Prioritize with Claude" command and the periodic reviews below (weekly, monthly, quarterly, yearly) use Claude via the Anthropic API (a few cents per run) and share this API key and model.',
            cls: 'ordinal-hint',
        });

        new obsidian.Setting(containerEl)
            .setName('Anthropic API key')
            .setDesc('From console.anthropic.com. Stored locally in this plugin\'s data.json.')
            .addText(t => {
                t.setPlaceholder('sk-ant-...')
                    .setValue(a.apiKey)
                    .onChange(async (v) => { a.apiKey = v.trim(); await this.plugin.saveSettings(); });
                t.inputEl.type = 'password';
            });

        new obsidian.Setting(containerEl)
            .setName('Model')
            .setDesc('Anthropic model id, e.g. claude-opus-4-8 or claude-sonnet-4-6.')
            .addText(t => t
                .setPlaceholder('claude-opus-4-8')
                .setValue(a.model)
                .onChange(async (v) => { a.model = v.trim(); await this.plugin.saveSettings(); }));

        // One settings section per review period, all driven by REVIEW_KINDS.
        const reviewUi = {
            week:    { label: 'Weekly review',    when: 'midnight each Sunday',                                          example: '2026-W23.md' },
            month:   { label: 'Monthly review',   when: 'midnight on the 1st of each month',                             example: '2026-06.md' },
            quarter: { label: 'Quarterly review', when: 'midnight on the first day of each quarter (Jan/Apr/Jul/Oct 1)', example: '2026-Q2.md' },
            year:    { label: 'Yearly review',    when: 'midnight on January 1st',                                       example: '2026.md' },
        };
        for (const [kind, ui] of Object.entries(reviewUi)) {
            const k = REVIEW_KINDS[kind];
            const s = this.plugin.settings[k.settingsKey];

            new obsidian.Setting(containerEl)
                .setName(ui.label)
                .setHeading();

            containerEl.createEl('p', {
                text: `Just after ${ui.when}, summarize the past ${k.noun}'s daily notes with Claude and write a review note (AI summary, then one review question per goal) to your chosen folder. If the app was closed at the time — including on mobile, where it runs when you next open Obsidian — it catches up on the next open.`,
                cls: 'ordinal-hint',
            });

            new obsidian.Setting(containerEl)
                .setName(`Enable ${k.noun}ly review`)
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
                .setDesc('Inserted at the top of every review, above the AI summary. Defaults to an embed of your goals note. Leave blank to omit.')
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

            new obsidian.Setting(containerEl)
                .setName(`Generate this ${k.noun}'s review now`)
                .setDesc(`Build the review immediately (covering the ${k.noun} so far) to test your configuration.`)
                .addButton(btn => btn
                    .setButtonText('Generate now')
                    .onClick(() => this.plugin.generateReview(kind, 'manual', null, true)));
        }
    }
}

module.exports = DrakeFactotumPlugin;
