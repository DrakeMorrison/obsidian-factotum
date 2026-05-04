'use strict';

var obsidian = require('obsidian');

// ── Markdown parsing / serialization ────────────────────────────────────────

function parseItems(content) {
    const items = [];
    for (const line of content.split('\n')) {
        const m = line.match(/^[-*+] (.+)$/);
        if (m) {
            const text = m[1].trim();
            if (/^\[[xX]\]\s/.test(text)) continue;
            items.push({ text });
        }
    }
    return items;
}

function serializeBack(content, sortedItems) {
    const replacements = sortedItems.map(i => `- ${i.text}`);
    let idx = 0;
    return content.replace(/^[-*+] (?!\[[xX]\]\s).+$/gm, () =>
        idx < replacements.length ? replacements[idx++] : ''
    );
}

// ── Pairwise ranking session (interactive merge sort) ───────────────────────

class RankSessionModal extends obsidian.Modal {
    constructor(app, items, onComplete) {
        super(app);
        this.items = items;
        this.onComplete = onComplete;
        this.comparisonCount = 0;
        const n = Math.max(items.length, 2);
        this.estimatedTotal = n * Math.ceil(Math.log2(n));
    }

    onOpen() {
        this.modalEl.addClass('ordinal-modal');
        this.run();
    }
    onClose() { this.contentEl.empty(); }

    async run() {
        if (this.items.length < 2) {
            this.renderResults(this.items);
            return;
        }
        const sorted = await this.mergeSort(this.items);
        this.renderResults(sorted);
    }

    async mergeSort(arr) {
        if (arr.length <= 1) return arr;
        const mid = Math.floor(arr.length / 2);
        const left = await this.mergeSort(arr.slice(0, mid));
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
        // On skip, preserve current relative order: take the left item first.
        skipBtn.addEventListener('click', () => resolve(true));
    }

    renderResults(sorted) {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '🏆 Ranking Complete' });

        const ol = contentEl.createEl('ol', { cls: 'ordinal-results-list' });
        for (const item of sorted) {
            const li = ol.createEl('li');
            li.createSpan({ text: item.text });
        }

        const saveBtn = contentEl.createEl('button', {
            text: '💾 Save to note',
            cls: 'ordinal-save-btn'
        });
        saveBtn.addEventListener('click', () => {
            this.onComplete(sorted);
            this.close();
        });
    }
}

// ── Add new item modal (binary-search placement) ───────────────────────────

class AddItemModal extends obsidian.Modal {
    constructor(app, sortedItems, onComplete) {
        super(app);
        this.sorted = [...sortedItems];
        this.onComplete = onComplete;
        this.newItem = { text: '' };
        this.lo = 0;
        this.hi = this.sorted.length - 1;
    }

    onOpen() {
        this.modalEl.addClass('ordinal-modal');
        this.renderInput();
    }
    onClose() { this.contentEl.empty(); }

    renderInput() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Add New Item' });
        const stepCount = Math.ceil(Math.log2(this.sorted.length + 1));
        contentEl.createEl('p', {
            text: `It will be placed in your ranked list of ${this.sorted.length} items using binary search — only ~${stepCount} comparison${stepCount === 1 ? '' : 's'} needed.`,
            cls: 'ordinal-hint'
        });

        const input = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'What do you want to do?'
        });
        input.addClass('ordinal-text-input');
        input.focus();

        const btn = contentEl.createEl('button', {
            text: 'Start placing →',
            cls: 'ordinal-save-btn'
        });

        const go = () => {
            const val = input.value.trim();
            if (!val) return;
            this.newItem.text = val;
            if (this.sorted.length === 0) {
                this.finish(0);
            } else {
                this.renderCompare();
            }
        };

        btn.addEventListener('click', go);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    }

    renderCompare() {
        if (this.lo > this.hi) {
            this.finish(this.lo);
            return;
        }

        const mid     = Math.floor((this.lo + this.hi) / 2);
        const against = this.sorted[mid];
        const steps   = Math.ceil(Math.log2(this.sorted.length + 1));
        const current = steps - Math.ceil(Math.log2(this.hi - this.lo + 2));

        const { contentEl } = this;
        contentEl.empty();
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

        btnNew.addEventListener('click', () => {
            // New item wins → place it in upper half
            this.hi = mid - 1;
            this.renderCompare();
        });

        btnOld.addEventListener('click', () => {
            // Existing item wins → push new item to lower half
            this.lo = mid + 1;
            this.renderCompare();
        });
    }

    finish(insertPosition) {
        const allItems = [...this.sorted];
        allItems.splice(insertPosition, 0, this.newItem);
        const rank = insertPosition + 1;

        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '✓ Item Placed!' });
        contentEl.createEl('p', {
            text: `"${this.newItem.text}" is ranked #${rank} out of ${allItems.length}`,
            cls: 'ordinal-hint'
        });

        const ol = contentEl.createEl('ol', { cls: 'ordinal-results-list' });
        for (const item of allItems) {
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
            this.onComplete(allItems);
            this.close();
        });
    }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

class OrdinalRankingPlugin extends obsidian.Plugin {
    async onload() {
        this.addCommand({
            id: 'ordinal-rank-list',
            name: 'Start ranking session',
            editorCallback: (editor) => {
                const content = editor.getValue();
                const items   = parseItems(content);
                if (items.length < 2) {
                    new obsidian.Notice('Ordinal Ranking: need at least 2 list items to compare.');
                    return;
                }
                new RankSessionModal(this.app, items, (sorted) => {
                    editor.setValue(serializeBack(content, sorted));
                    new obsidian.Notice('Ordinal Ranking: rankings saved ✓');
                }).open();
            }
        });

        this.addCommand({
            id: 'ordinal-add-item',
            name: 'Add new item (binary-search placement)',
            editorCallback: (editor) => {
                const content = editor.getValue();
                const items   = parseItems(content);
                new AddItemModal(this.app, items, (sorted) => {
                    editor.setValue(serializeBack(content, sorted));
                    new obsidian.Notice('Ordinal Ranking: item added ✓');
                }).open();
            }
        });

        console.log('Ordinal Ranking loaded');
    }

    onunload() {
        console.log('Ordinal Ranking unloaded');
    }
}

module.exports = OrdinalRankingPlugin;
