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

function classifyHeading(text) {
    const t = text.trim().toLowerCase();
    if (/^done\b/.test(t)) return 'done';
    if (/^do\b/.test(t))       return 'Q1';
    if (/^schedule\b/.test(t)) return 'Q2';
    if (/^delegate\b/.test(t)) return 'Q3';
    if (/^delete\b/.test(t))   return 'Q4';
    return null;
}

function emptySections() {
    return { Q1: [], Q2: [], Q3: [], Q4: [], done: [] };
}

function findQuadrant(urgent, important) {
    return QUADRANTS.find(q => q.urgent === urgent && q.important === important);
}

// ── Markdown parsing / serialization ────────────────────────────────────────

function parseNote(content) {
    const lines = content.split('\n');

    // Detect matrix mode: any heading line that classifies as a quadrant or done.
    let matrixMode = false;
    for (const line of lines) {
        const m = line.match(/^#{1,6}\s+(.+)$/);
        if (m && classifyHeading(m[1]) !== null) { matrixMode = true; break; }
    }

    if (!matrixMode) {
        const items = [];
        const done  = [];
        for (const line of lines) {
            const m = line.match(/^[-*+] (.+)$/);
            if (!m) continue;
            let text = m[1].trim();
            const doneMatch = text.match(/^\[[xX]\]\s+(.+)$/);
            if (doneMatch) { done.push({ text: doneMatch[1], isTask: true }); continue; }
            let isTask = false;
            const taskMatch = text.match(/^\[ \]\s+(.+)$/);
            if (taskMatch) { isTask = true; text = taskMatch[1]; }
            items.push({ text, isTask });
        }
        return { mode: 'flat', items, done };
    }

    // Matrix mode: bucket items by surrounding heading. Active bullets above
    // the first quadrant heading default to Q2. Done items always go to done.
    const sections = emptySections();
    let section = 'preamble';
    let sawQuadrant = false;
    const preamble = [];

    for (const line of lines) {
        const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
        if (headingMatch) {
            const cls = classifyHeading(headingMatch[1]);
            if (cls !== null) { section = cls; sawQuadrant = true; continue; }
            if (!sawQuadrant) preamble.push(line);
            continue;
        }

        const bulletMatch = line.match(/^[-*+] (.+)$/);
        if (bulletMatch) {
            let text = bulletMatch[1].trim();
            const doneMatch = text.match(/^\[[xX]\]\s+(.+)$/);
            if (doneMatch) { sections.done.push({ text: doneMatch[1], isTask: true }); continue; }
            let isTask = false;
            const taskMatch = text.match(/^\[ \]\s+(.+)$/);
            if (taskMatch) { isTask = true; text = taskMatch[1]; }
            const bucket = (section === 'preamble' || section === 'done') ? 'Q2' : section;
            sections[bucket].push({ text, isTask });
            continue;
        }

        if (!sawQuadrant) preamble.push(line);
    }

    return { mode: 'matrix', preamble, sections };
}

function renderItemLine(item) {
    return item.isTask ? `- [ ] ${item.text}` : `- ${item.text}`;
}

function serializeFlat(content, sortedItems) {
    const replacements = sortedItems.map(renderItemLine);

    const lines = content.split('\n');
    const newLines = [];
    const doneLines = [];
    let lastSortedIdx = -1;
    let idx = 0;

    for (const line of lines) {
        if (/^[-*+] \[[xX]\]\s/.test(line)) {
            doneLines.push(line);
        } else if (/^[-*+] /.test(line)) {
            if (idx < replacements.length) {
                newLines.push(replacements[idx++]);
                lastSortedIdx = newLines.length - 1;
            }
        } else {
            newLines.push(line);
        }
    }

    const tail = [...replacements.slice(idx), ...doneLines];
    if (tail.length > 0) {
        const insertAt = lastSortedIdx >= 0 ? lastSortedIdx + 1 : newLines.length;
        newLines.splice(insertAt, 0, ...tail);
    }

    return newLines.join('\n');
}

function serializeMatrix(originalContent, sections) {
    // Preserve everything above the first quadrant heading verbatim.
    const lines = originalContent.split('\n');
    const preamble = [];
    for (const line of lines) {
        const m = line.match(/^#{1,6}\s+(.+)$/);
        if (m && classifyHeading(m[1]) !== null) break;
        preamble.push(line);
    }
    while (preamble.length && preamble[preamble.length - 1].trim() === '') preamble.pop();

    const out = [];
    if (preamble.length > 0) { out.push(...preamble); out.push(''); }

    for (const q of QUADRANTS) {
        out.push(`## ${q.heading}`);
        for (const item of sections[q.key]) out.push(renderItemLine(item));
        out.push('');
    }

    out.push(`## ${DONE_HEADING}`);
    for (const item of sections.done) out.push(`- [x] ${item.text}`);

    return out.join('\n');
}

// ── Pairwise ranking session (interactive merge sort) ───────────────────────

class RankSessionModal extends obsidian.Modal {
    constructor(app, payload, onComplete) {
        super(app);
        this.payload = payload;
        this.onComplete = onComplete;
        this.comparisonCount = 0;
        this.currentQuadrantLabel = null;

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
    onClose() { this.contentEl.empty(); }

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
        for (const q of QUADRANTS) {
            this.currentQuadrantLabel = q.heading;
            const items = this.payload.sections[q.key];
            if (items.length < 2) { out[q.key] = items; continue; }
            out[q.key] = await this.mergeSort(items);
        }
        this.renderResults({ mode: 'matrix', sections: out });
    }

    async mergeSort(arr) {
        if (arr.length <= 1) return arr;
        const mid = Math.floor(arr.length / 2);
        const left  = await this.mergeSort(arr.slice(0, mid));
        const right = await this.mergeSort(arr.slice(mid));
        return this.merge(left, right);
    }

    async merge(left, right) {
        const result = [];
        let i = 0, j = 0;
        while (i < left.length && j < right.length) {
            const leftWins = await this.askCompare(left[i], right[j]);
            if (leftWins) result.push(left[i++]);
            else result.push(right[j++]);
        }
        while (i < left.length) result.push(left[i++]);
        while (j < right.length) result.push(right[j++]);
        return result;
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
    }

    renderResults(result) {
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
    }

    onOpen() {
        this.modalEl.addClass('ordinal-modal');
        this.renderInput();
    }
    onClose() { this.contentEl.empty(); }

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

        const grid = contentEl.createDiv({ cls: 'ordinal-grid' });
        const yes = grid.createEl('button', { text: 'Yes, important', cls: 'ordinal-choice' });
        grid.createDiv({ cls: 'ordinal-vs', text: '/' });
        const no  = grid.createEl('button', { text: 'No, not important', cls: 'ordinal-choice' });
        yes.addEventListener('click', () => this.startMatrix(true));
        no .addEventListener('click', () => this.startMatrix(false));
    }

    startFlat() {
        this.sorted = [...this.payload.items];
        this.lo = 0;
        this.hi = this.sorted.length - 1;
        if (this.sorted.length === 0) this.finish(0);
        else this.renderCompare();
    }

    startMatrix(important) {
        const q = findQuadrant(this.urgent, important);
        this.targetQuadrant = q;
        this.sorted = [...this.payload.sections[q.key]];
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
    }

    finish(insertPosition) {
        const placedQuadrant = this.targetQuadrant;
        const sortedWithNew = [...this.sorted];
        sortedWithNew.splice(insertPosition, 0, this.newItem);
        const rank = insertPosition + 1;

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
            if (this.payload.mode === 'flat') {
                this.onComplete({ mode: 'flat', items: sortedWithNew });
            } else {
                const newSections = {
                    Q1: [...this.payload.sections.Q1],
                    Q2: [...this.payload.sections.Q2],
                    Q3: [...this.payload.sections.Q3],
                    Q4: [...this.payload.sections.Q4],
                    done: [...this.payload.sections.done],
                };
                newSections[placedQuadrant.key] = sortedWithNew;
                this.onComplete({ mode: 'matrix', sections: newSections });
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
        this.classified = emptySections();
        this.classified.done = this.doneItems;
    }

    onOpen() {
        this.modalEl.addClass('ordinal-modal');
        if (this.items.length === 0) this.renderResults();
        else this.askUrgent();
    }
    onClose() { this.contentEl.empty(); }

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
            this.onComplete({ mode: 'matrix', sections: this.classified });
            this.close();
        });
    }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

function applyResult(editor, originalContent, result) {
    if (result.mode === 'flat') {
        editor.setValue(serializeFlat(originalContent, result.items));
    } else {
        editor.setValue(serializeMatrix(originalContent, result.sections));
    }
}

function totalActiveItems(parsed) {
    if (parsed.mode === 'flat') return parsed.items.length;
    return QUADRANTS.reduce((sum, q) => sum + parsed.sections[q.key].length, 0);
}

class DrakeFactotumPlugin extends obsidian.Plugin {
    async onload() {
        this.addCommand({
            id: 'ordinal-rank-list',
            name: 'Start ranking session',
            editorCallback: (editor) => {
                const content = editor.getValue();
                const parsed  = parseNote(content);
                if (totalActiveItems(parsed) < 2) {
                    new obsidian.Notice('Drake\'s Factotum: need at least 2 list items to compare.');
                    return;
                }
                new RankSessionModal(this.app, parsed, (result) => {
                    applyResult(editor, content, result);
                    new obsidian.Notice('Drake\'s Factotum: rankings saved ✓');
                }).open();
            }
        });

        this.addCommand({
            id: 'ordinal-add-item',
            name: 'Add new item (binary-search placement)',
            editorCallback: (editor) => {
                const content = editor.getValue();
                const parsed  = parseNote(content);
                new AddItemModal(this.app, parsed, (result) => {
                    applyResult(editor, content, result);
                    new obsidian.Notice('Drake\'s Factotum: item added ✓');
                }).open();
            }
        });

        this.addCommand({
            id: 'ordinal-convert-matrix',
            name: 'Convert flat list to Eisenhower matrix',
            editorCallback: (editor) => {
                const content = editor.getValue();
                const parsed  = parseNote(content);
                if (parsed.mode === 'matrix') {
                    new obsidian.Notice('Drake\'s Factotum: this note is already in matrix mode.');
                    return;
                }
                if (parsed.items.length === 0) {
                    new obsidian.Notice('Drake\'s Factotum: no items to classify.');
                    return;
                }
                new ConvertModal(this.app, parsed, (result) => {
                    applyResult(editor, content, result);
                    new obsidian.Notice('Drake\'s Factotum: converted to Eisenhower matrix ✓');
                }).open();
            }
        });

        console.log('Drake\'s Factotum loaded');
    }

    onunload() {
        console.log('Drake\'s Factotum unloaded');
    }
}

module.exports = DrakeFactotumPlugin;
