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

function computeResult(originalContent, result) {
    if (result.mode === 'flat') {
        return serializeFlat(originalContent, result.items);
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
    weeklyReview: {
        enabled: false,
        apiKey: '',
        model: 'claude-opus-4-8',
        folder: 'Weekly Reviews',
        headerEmbed: '![[goals#goals]]', // inserted above the summary; blank to omit
        goalsSource: '![[goals#goals]]', // section read so Claude can pose a review question per goal; blank to omit
        lastReviewWeekstamp: '',   // GGGG-[W]WW of the last created review
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

// Canonical (un-suffixed) path of a week's review note. Mirrors the base name
// writeReviewNote() creates, so callers can detect an already-written review.
function reviewNotePath(folder, weekstamp) {
    const dir = (folder || '').replace(/\/+$/, '');
    return obsidian.normalizePath(dir ? `${dir}/${weekstamp}.md` : `${weekstamp}.md`);
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

// ── Weekly review ───────────────────────────────────────────────────────────

// Collect the text of unchecked `- [ ]` tasks from a note, including indented /
// nested tasks (leading whitespace and a tab or space after the bullet).
function extractOpenTasks(text) {
    const tasks = [];
    for (const line of (text || '').split('\n')) {
        const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
        if (!bullet) continue;
        const open = bullet[1].trim().match(/^\[ \]\s+(.+)$/);
        if (open) tasks.push(open[1].trim());
    }
    return tasks;
}

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

// The 7 dates (Mon→Sun) of the ISO week whose Sunday is `sundayMoment`.
function weekDates(sundayMoment) {
    const dates = [];
    for (let i = 6; i >= 0; i--) dates.push(sundayMoment.clone().subtract(i, 'day'));
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

function weeklyReviewSystem(hasGoals) {
    let s =
        'You are writing a weekly review from a user\'s Obsidian daily notes. ' +
        'Output GitHub-flavored markdown with the sections described below, in order, and nothing else. ' +
        'First, `## AI Summary` — a concise prose recap of the week\'s themes, progress, and notable events. ' +
        'Then, `## Potential TODOs` — a `- [ ]` checkbox list. ' +
        'The TODO list must include every still-open task provided to you, plus any additional action items ' +
        'you can reasonably infer from the notes. De-duplicate overlapping items. ';
    if (hasGoals) {
        s +=
            'Finally, `## Review Questions` — a `-` bullet list with exactly one reflective question per goal ' +
            'provided to you, in the same order as the goals. Each question should prompt the user to assess ' +
            'their progress on that goal this week, grounded in what the notes show. One question per goal, ' +
            'no more, no fewer. ';
    }
    s += 'Do not invent events that are not supported by the notes.';
    return s;
}

class DrakeFactotumPlugin extends obsidian.Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new FactotumSettingTab(this.app, this));
        this.beeminderTimer = null;
        this.weeklyTimer = null;
        this.setupScrollOff();
        this.app.workspace.onLayoutReady(() => {
            this.maybeCatchUpBeeminder();
            this.scheduleBeeminderSubmission();
            this.maybeCatchUpWeeklyReview();
            this.scheduleWeeklyReview();
        });

        this.addCommand({
            id: 'factotum-rank-list',
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
                        new obsidian.Notice(`Drake's Factotum: TODO note not found at "${path}". Check the path in settings.`);
                        return;
                    }
                    target = this.fileTarget(file);
                } else {
                    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
                    if (!view) {
                        new obsidian.Notice('Drake\'s Factotum: open a note, or set a TODO note path in settings.');
                        return;
                    }
                    target = { read: async () => view.editor.getValue(), write: async (c) => view.editor.setValue(c) };
                }
                const content = await target.read();
                const parsed  = parseNote(content);
                new AddItemModal(this.app, parsed, async (result) => {
                    await target.write(computeResult(content, result));
                    new obsidian.Notice('Drake\'s Factotum: item added ✓');
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
        this.clearBeeminderTimer();
        this.clearWeeklyTimer();
        console.log('Drake\'s Factotum unloaded');
    }

    // nvim-style scrolloff: keep `scrollOff` lines of context above and below the
    // cursor so you're never typing against the top or bottom edge of the view.
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
        this.settings.weeklyReview = Object.assign({}, DEFAULT_SETTINGS.weeklyReview, data?.weeklyReview);
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
            if (notify) new obsidian.Notice('Drake\'s Factotum: Beeminder not configured (token, user, and goal required).');
            return;
        }
        const config = getDailyNoteConfig(this.app);
        if (!config) {
            if (notify) new obsidian.Notice('Drake\'s Factotum: could not find a Daily Notes / Periodic Notes config.');
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
            if (notify) new obsidian.Notice(`Drake's Factotum: no daily note for ${day.format('YYYY-MM-DD')} yet — nothing sent.`);
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
                if (notify) new obsidian.Notice(`Drake's Factotum: sent ${value} words to Beeminder ✓`);
            } else {
                // Background runs stay silent (they retry on the next open/timer);
                // the console keeps the record. Manual "Send now" surfaces it.
                if (notify) new obsidian.Notice(`Drake's Factotum: Beeminder rejected the submission (HTTP ${res.status}).`);
                console.error('Drake\'s Factotum — Beeminder error', res.status, res.text);
            }
        } catch (e) {
            if (notify) new obsidian.Notice('Drake\'s Factotum: Beeminder submission failed (network error).');
            console.error('Drake\'s Factotum — Beeminder request failed', e);
        }
    }

    clearWeeklyTimer() {
        if (this.weeklyTimer !== null) {
            window.clearTimeout(this.weeklyTimer);
            this.weeklyTimer = null;
        }
    }

    // The instant the current ISO week closes: next Monday at 00:00. Reviewing at
    // the start of the new week (rather than Sunday night) captures everything
    // written late on Sunday.
    nextWeeklyDeadline() {
        return obsidian.moment().startOf('isoWeek').add(1, 'week');
    }

    // (Re)arm a timer that fires when the week closes (Monday 00:00), reviews the
    // week that just ended, then re-arms.
    scheduleWeeklyReview() {
        this.clearWeeklyTimer();
        if (!this.settings.weeklyReview.enabled) return;
        const now = obsidian.moment();
        const next = this.nextWeeklyDeadline();
        if (next.isSameOrBefore(now)) next.add(1, 'week');
        // The week to review is the one that just closed; its Sunday is the day
        // before this Monday-00:00 boundary. Capture it so a late-firing timer
        // (e.g. after a sleep/wake) still reviews that week rather than rolling
        // forward into the new one.
        const target = next.clone().subtract(1, 'day');
        this.weeklyTimer = window.setTimeout(async () => {
            // As with the Beeminder timer: a suspended mobile app fires pending
            // timeouts on resume, before their instant. Only review once the week
            // has actually closed (we've reached the Monday-00:00 boundary), and
            // never re-review a week already stamped. Otherwise just re-arm.
            if (obsidian.moment().isSameOrAfter(next) &&
                this.settings.weeklyReview.lastReviewWeekstamp !== target.format('GGGG-[W]WW')) {
                await this.generateWeeklyReview('scheduled Monday 12AM', target);
            }
            this.scheduleWeeklyReview();
        }, next.diff(now));
    }

    // If a week-close run was missed (Obsidian closed at the boundary), catch up
    // on open by generating for the most recent week that has already closed.
    async maybeCatchUpWeeklyReview() {
        if (!this.settings.weeklyReview.enabled) return;
        const now = obsidian.moment();
        const deadline = this.nextWeeklyDeadline();
        if (deadline.isAfter(now)) deadline.subtract(1, 'week');
        // The just-closed week's Sunday is the day before that Monday-00:00 boundary.
        const target = deadline.clone().subtract(1, 'day');
        if (this.settings.weeklyReview.lastReviewWeekstamp !== target.format('GGGG-[W]WW')) {
            await this.generateWeeklyReview('catch-up on open', target);
        }
    }

    async generateWeeklyReview(reason, sundayMoment = null, notify = false) {
        const s = this.settings.weeklyReview;
        if (!s.enabled) return;
        if (!s.apiKey) {
            if (notify) new obsidian.Notice('Drake\'s Factotum: weekly review needs an Anthropic API key.');
            return;
        }
        const config = getDailyNoteConfig(this.app);
        if (!config) {
            if (notify) new obsidian.Notice('Drake\'s Factotum: could not find a Daily Notes / Periodic Notes config.');
            return;
        }

        // Anchor to the ISO week's Sunday (its last day) so weekDates() and the
        // weekstamp stay aligned. Scheduled/catch-up runs pass a Sunday already;
        // manual runs fall back to the current week's Sunday.
        const day = sundayMoment || obsidian.moment().isoWeekday(7);
        const weekstamp = day.format('GGGG-[W]WW');
        const dates = weekDates(day);

        // The review note file is the durable, synced source of truth for
        // "this week is reviewed" — not lastReviewWeekstamp, which lives in
        // data.json and syncs separately. If a note for this week already
        // exists, an automatic (scheduled/catch-up) run must NOT regenerate
        // over it: that note may have been written on another device and
        // synced here before this device's stamp caught up, and it may hold
        // notes the user added. Just record the week as done locally and stop.
        if (!notify && this.app.vault.getAbstractFileByPath(reviewNotePath(s.folder, weekstamp)) instanceof obsidian.TFile) {
            s.lastReviewWeekstamp = weekstamp;
            await this.saveSettings();
            return;
        }

        const sections = [];
        const openTasks = [];
        for (const d of dates) {
            const file = this.app.vault.getAbstractFileByPath(dailyNotePath(config, d));
            if (!(file instanceof obsidian.TFile)) continue;
            const body = stripFrontmatter(await this.app.vault.cachedRead(file)).trim();
            if (!body) continue;
            sections.push(`### ${d.format('dddd, YYYY-MM-DD')}\n${body}`);
            openTasks.push(...extractOpenTasks(body));
        }

        if (sections.length === 0) {
            // Don't stamp the week as done — notes may just not be available yet
            // (vault still indexing, or sync lag from another device). Leaving the
            // stamp unset lets a later open re-scan and review once notes arrive.
            if (notify) new obsidian.Notice(`Drake's Factotum: no daily notes found for ${weekstamp}.`);
            return;
        }

        const taskBlock = openTasks.length
            ? `Still-open tasks (include all of these):\n${openTasks.map(t => `- [ ] ${t}`).join('\n')}`
            : 'Still-open tasks: (none found)';
        // Read the goals section so Claude can pose a review question per goal.
        const goalsText = await readEmbeddedSection(this.app, s.goalsSource);
        const goalsBlock = goalsText
            ? `\n\nThe user's goals (write exactly one review question for each):\n${goalsText}`
            : '';
        const userContent = `Daily notes for the week of ${weekstamp} (${dates[0].format('YYYY-MM-DD')} to ${dates[6].format('YYYY-MM-DD')}):\n\n${sections.join('\n\n')}\n\n${taskBlock}${goalsBlock}`;

        new obsidian.Notice(`Drake's Factotum: generating weekly review for ${weekstamp}…`);
        let result;
        try {
            result = await callClaude(s.apiKey, s.model, weeklyReviewSystem(!!goalsText), userContent);
        } catch (e) {
            new obsidian.Notice('Drake\'s Factotum: weekly review request failed (network error).');
            console.error('Drake\'s Factotum — Claude request failed', e);
            return;
        }
        if (!result.ok) {
            new obsidian.Notice(`Drake's Factotum: Claude API error (HTTP ${result.status}).`);
            console.error('Drake\'s Factotum — Claude API error', result.status);
            return;
        }
        const reviewBody = result.text.trim();
        if (!reviewBody) {
            // Empty/non-text response — don't write a hollow note or stamp the week.
            new obsidian.Notice('Drake\'s Factotum: Claude returned an empty response; no review written.');
            console.error('Drake\'s Factotum — empty Claude response');
            return;
        }

        const generated = obsidian.moment().format('YYYY-MM-DD HH:mm');
        const embed = s.headerEmbed ? `${s.headerEmbed}\n\n` : '';
        const note = `---\nweek: ${weekstamp}\nrange: ${dates[0].format('YYYY-MM-DD')} to ${dates[6].format('YYYY-MM-DD')}\ngenerated: ${generated}\n---\n\n# Weekly Review — ${weekstamp}\n\n${embed}${reviewBody}\n`;

        try {
            const file = await this.writeReviewNote(s.folder, weekstamp, note);
            s.lastReviewWeekstamp = weekstamp;
            await this.saveSettings();
            new obsidian.Notice(`Drake's Factotum: weekly review for ${weekstamp} saved ✓`);
            if (notify && file) {
                this.app.workspace.getLeaf(true).openFile(file)
                    .catch(e => console.error('Drake\'s Factotum — could not open review note', e));
            }
        } catch (e) {
            new obsidian.Notice('Drake\'s Factotum: could not write the weekly review note.');
            console.error('Drake\'s Factotum — weekly review write failed', e);
        }
    }

    async writeReviewNote(folder, weekstamp, content) {
        const dir = (folder || '').replace(/\/+$/, '');
        if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
            // createFolder throws if it already exists — tolerate the race.
            try { await this.app.vault.createFolder(dir); } catch (e) { /* already exists */ }
        }
        // Never overwrite an existing review note — it may hold notes the user
        // added. Automatic runs are already short-circuited before reaching
        // here; a collision means a manual re-run, so write a numbered sibling
        // and leave the original untouched.
        const base = obsidian.normalizePath(dir ? `${dir}/${weekstamp}` : weekstamp);
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
        throw new Error(`No free filename for weekly review ${weekstamp}`);
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
            .setDesc('Keep this many lines visible above and below the cursor while editing (nvim-style scrolloff), so you never type against the top or bottom edge. Set to 0 to disable.')
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

        const w = this.plugin.settings.weeklyReview;

        new obsidian.Setting(containerEl)
            .setName('Weekly review')
            .setHeading();

        containerEl.createEl('p', {
            text: 'Just before midnight each Sunday, summarize the past week\'s daily notes with Claude and write a review note (with a list of potential TODOs) to your chosen folder. If the app was closed at the time — including on mobile, where it runs when you next open Obsidian — it catches up on the next open. The summary uses the Anthropic API (a few cents per week).',
            cls: 'ordinal-hint',
        });

        new obsidian.Setting(containerEl)
            .setName('Enable weekly review')
            .setDesc('Generate automatically at the start of each week (just after Sunday midnight), with catch-up on startup.')
            .addToggle(t => t
                .setValue(w.enabled)
                .onChange(async (v) => {
                    w.enabled = v;
                    await this.plugin.saveSettings();
                    this.plugin.scheduleWeeklyReview();
                }));

        new obsidian.Setting(containerEl)
            .setName('Anthropic API key')
            .setDesc('From console.anthropic.com. Stored locally in this plugin\'s data.json.')
            .addText(t => {
                t.setPlaceholder('sk-ant-...')
                    .setValue(w.apiKey)
                    .onChange(async (v) => { w.apiKey = v.trim(); await this.plugin.saveSettings(); });
                t.inputEl.type = 'password';
            });

        new obsidian.Setting(containerEl)
            .setName('Model')
            .setDesc('Anthropic model id, e.g. claude-opus-4-8 or claude-sonnet-4-6.')
            .addText(t => t
                .setPlaceholder('claude-opus-4-8')
                .setValue(w.model)
                .onChange(async (v) => { w.model = v.trim(); await this.plugin.saveSettings(); }));

        new obsidian.Setting(containerEl)
            .setName('Review folder')
            .setDesc('Where review notes are saved (named by ISO week, e.g. 2026-W23.md). Created if missing.')
            .addText(t => t
                .setPlaceholder('Weekly Reviews')
                .setValue(w.folder)
                .onChange(async (v) => { w.folder = v.trim(); await this.plugin.saveSettings(); }));

        new obsidian.Setting(containerEl)
            .setName('Header embed (optional)')
            .setDesc('Inserted at the top of every review, above the AI summary. Defaults to an embed of your goals note. Leave blank to omit.')
            .addText(t => t
                .setPlaceholder('![[goals#goals]]')
                .setValue(w.headerEmbed)
                .onChange(async (v) => { w.headerEmbed = v.trim(); await this.plugin.saveSettings(); }));

        new obsidian.Setting(containerEl)
            .setName('Goals source (optional)')
            .setDesc('A wiki link like ![[goals#goals]] whose linked section is read so the review ends with one review question per goal. Leave blank to skip the review questions.')
            .addText(t => t
                .setPlaceholder('![[goals#goals]]')
                .setValue(w.goalsSource)
                .onChange(async (v) => { w.goalsSource = v.trim(); await this.plugin.saveSettings(); }));

        new obsidian.Setting(containerEl)
            .setName('Generate this week\'s review now')
            .setDesc('Build the review immediately to test your configuration.')
            .addButton(btn => btn
                .setButtonText('Generate now')
                .onClick(() => this.plugin.generateWeeklyReview('manual', null, true)));
    }
}

module.exports = DrakeFactotumPlugin;
