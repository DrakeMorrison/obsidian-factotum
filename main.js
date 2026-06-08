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

// ── Beeminder daily word count ──────────────────────────────────────────────

const DEFAULT_SETTINGS = {
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

// Collect the text of unchecked `- [ ]` tasks from a note (same bullet/task
// shapes parseNote recognises).
function extractOpenTasks(text) {
    const tasks = [];
    for (const line of (text || '').split('\n')) {
        const bullet = line.match(/^[-*+] (.+)$/);
        if (!bullet) continue;
        const open = bullet[1].trim().match(/^\[ \]\s+(.+)$/);
        if (open) tasks.push(open[1].trim());
    }
    return tasks;
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

const WEEKLY_REVIEW_SYSTEM =
    'You are writing a weekly review from a user\'s Obsidian daily notes. ' +
    'Output GitHub-flavored markdown with exactly two sections and nothing else. ' +
    'First, `## Summary` — a concise prose recap of the week\'s themes, progress, and notable events. ' +
    'Then, `## Potential TODOs` — a `- [ ]` checkbox list. ' +
    'The TODO list must include every still-open task provided to you, plus any additional action items ' +
    'you can reasonably infer from the notes. De-duplicate overlapping items. ' +
    'Do not invent events that are not supported by the notes.';

class DrakeFactotumPlugin extends obsidian.Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new FactotumSettingTab(this.app, this));
        this.beeminderTimer = null;
        this.weeklyTimer = null;
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

    async loadSettings() {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
        this.settings.beeminder = Object.assign({}, DEFAULT_SETTINGS.beeminder, data?.beeminder);
        this.settings.weeklyReview = Object.assign({}, DEFAULT_SETTINGS.weeklyReview, data?.weeklyReview);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    clearBeeminderTimer() {
        if (this.beeminderTimer !== null) {
            window.clearTimeout(this.beeminderTimer);
            this.beeminderTimer = null;
        }
    }

    // (Re)arm a timer that fires at the next 11PM, submits, then re-arms itself.
    scheduleBeeminderSubmission() {
        this.clearBeeminderTimer();
        if (!this.settings.beeminder.enabled) return;
        const now = obsidian.moment();
        const next = obsidian.moment().hour(23).minute(0).second(0).millisecond(0);
        if (next.isSameOrBefore(now)) next.add(1, 'day');
        this.beeminderTimer = window.setTimeout(async () => {
            await this.runBeeminderSubmission('scheduled 11PM');
            this.scheduleBeeminderSubmission();
        }, next.diff(now));
    }

    // If a scheduled 11PM submission was missed (Obsidian closed at the time),
    // catch up on open by submitting for the most recent 11PM deadline that has
    // already passed — which is yesterday if it's currently before 11PM today.
    async maybeCatchUpBeeminder() {
        if (!this.settings.beeminder.enabled) return;
        const now = obsidian.moment();
        const deadline = obsidian.moment().hour(23).minute(0).second(0).millisecond(0);
        if (deadline.isAfter(now)) deadline.subtract(1, 'day');
        if (this.settings.beeminder.lastSubmittedDaystamp !== deadline.format('YYYYMMDD')) {
            await this.runBeeminderSubmission('catch-up on open', deadline);
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
            new obsidian.Notice('Drake\'s Factotum: could not find a Daily Notes / Periodic Notes config.');
            return;
        }
        const day = targetMoment || obsidian.moment();
        const noteWords = await readWordCount(this.app, dailyNotePath(config, day));
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
                new obsidian.Notice(`Drake's Factotum: sent ${value} words to Beeminder ✓`);
            } else {
                new obsidian.Notice(`Drake's Factotum: Beeminder rejected the submission (HTTP ${res.status}).`);
                console.error('Drake\'s Factotum — Beeminder error', res.status, res.text);
            }
        } catch (e) {
            new obsidian.Notice('Drake\'s Factotum: Beeminder submission failed (network error).');
            console.error('Drake\'s Factotum — Beeminder request failed', e);
        }
    }

    clearWeeklyTimer() {
        if (this.weeklyTimer !== null) {
            window.clearTimeout(this.weeklyTimer);
            this.weeklyTimer = null;
        }
    }

    // The next Sunday 23:55 (just before midnight).
    nextWeeklyDeadline() {
        return obsidian.moment().isoWeekday(7).hour(23).minute(55).second(0).millisecond(0);
    }

    // (Re)arm a timer that fires at the next Sunday 23:55, generates, then re-arms.
    scheduleWeeklyReview() {
        this.clearWeeklyTimer();
        if (!this.settings.weeklyReview.enabled) return;
        const now = obsidian.moment();
        const next = this.nextWeeklyDeadline();
        if (next.isSameOrBefore(now)) next.add(1, 'week');
        this.weeklyTimer = window.setTimeout(async () => {
            await this.generateWeeklyReview('scheduled Sunday 11:55PM');
            this.scheduleWeeklyReview();
        }, next.diff(now));
    }

    // If a Sunday-night run was missed (Obsidian closed at the time), catch up on
    // open by generating for the most recent Sunday deadline that has passed —
    // which is last Sunday if it's currently before this Sunday's 11:55PM.
    async maybeCatchUpWeeklyReview() {
        if (!this.settings.weeklyReview.enabled) return;
        const now = obsidian.moment();
        const deadline = this.nextWeeklyDeadline();
        if (deadline.isAfter(now)) deadline.subtract(1, 'week');
        if (this.settings.weeklyReview.lastReviewWeekstamp !== deadline.format('GGGG-[W]WW')) {
            await this.generateWeeklyReview('catch-up on open', deadline);
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
            new obsidian.Notice('Drake\'s Factotum: could not find a Daily Notes / Periodic Notes config.');
            return;
        }

        const day = sundayMoment || obsidian.moment();
        const weekstamp = day.format('GGGG-[W]WW');
        const dates = weekDates(day);

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
            if (notify) new obsidian.Notice(`Drake's Factotum: no daily notes found for ${weekstamp}.`);
            s.lastReviewWeekstamp = weekstamp;
            await this.saveSettings();
            return;
        }

        const taskBlock = openTasks.length
            ? `Still-open tasks (include all of these):\n${openTasks.map(t => `- [ ] ${t}`).join('\n')}`
            : 'Still-open tasks: (none found)';
        const userContent = `Daily notes for the week of ${weekstamp} (${dates[0].format('YYYY-MM-DD')} to ${dates[6].format('YYYY-MM-DD')}):\n\n${sections.join('\n\n')}\n\n${taskBlock}`;

        new obsidian.Notice(`Drake's Factotum: generating weekly review for ${weekstamp}…`);
        let result;
        try {
            result = await callClaude(s.apiKey, s.model, WEEKLY_REVIEW_SYSTEM, userContent);
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

        const generated = obsidian.moment().format('YYYY-MM-DD HH:mm');
        const note = `---\nweek: ${weekstamp}\nrange: ${dates[0].format('YYYY-MM-DD')} to ${dates[6].format('YYYY-MM-DD')}\ngenerated: ${generated}\n---\n\n# Weekly Review — ${weekstamp}\n\n${result.text.trim()}\n`;

        try {
            const file = await this.writeReviewNote(s.folder, weekstamp, note);
            s.lastReviewWeekstamp = weekstamp;
            await this.saveSettings();
            new obsidian.Notice(`Drake's Factotum: weekly review for ${weekstamp} saved ✓`);
            if (notify && file) this.app.workspace.getLeaf(true).openFile(file);
        } catch (e) {
            new obsidian.Notice('Drake\'s Factotum: could not write the weekly review note.');
            console.error('Drake\'s Factotum — weekly review write failed', e);
        }
    }

    async writeReviewNote(folder, weekstamp, content) {
        const dir = (folder || '').replace(/\/+$/, '');
        if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
            await this.app.vault.createFolder(dir);
        }
        const path = obsidian.normalizePath(dir ? `${dir}/${weekstamp}.md` : `${weekstamp}.md`);
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof obsidian.TFile) {
            await this.app.vault.modify(existing, content);
            return existing;
        }
        return this.app.vault.create(path, content);
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
            text: 'Just before midnight each Sunday, summarize the past week\'s daily notes with Claude and write a review note (with a list of potential TODOs) to your chosen folder. Catches up on next open if the app was closed at the time. The summary uses the Anthropic API (a few cents per week).',
            cls: 'ordinal-hint',
        });

        new obsidian.Setting(containerEl)
            .setName('Enable weekly review')
            .setDesc('Generate automatically Sunday at 11:55PM, with catch-up on startup.')
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
            .setName('Generate this week\'s review now')
            .setDesc('Build the review immediately to test your configuration.')
            .addButton(btn => btn
                .setButtonText('Generate now')
                .onClick(() => this.plugin.generateWeeklyReview('manual', null, true)));
    }
}

module.exports = DrakeFactotumPlugin;
