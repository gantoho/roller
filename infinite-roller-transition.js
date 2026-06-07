/**
 * InfiniteRollerTransition — CSS Transition 驱动的无限循环滚动
 * ============================================================
 * 与 InfiniteRoller（rAF 版）API 完全一致，仅核心动画技术不同。
 *
 * 原理：
 *   setTimeout 控制周期 → 设置 transition: transform Ns linear →
 *   一次性滑到 -originalSize → snap 回 0 → 重复。
 *   动画由合成器线程完成，主线程不参与每帧计算。
 *
 * vs rAF：
 *   - 暂停/恢复需手动记录位置 + 剩余时间
 *   - 速度变化需重新计算 duration
 *   - 仅支持 transform 属性（后面可扩展）
 */

class InfiniteRollerTransition {

    constructor(container, options = {}) {
        if (!container || !(container instanceof HTMLElement)) {
            throw new Error('[InfiniteRollerTransition] 需要提供一个有效的 DOM 容器');
        }

        this.container = container;

        const defaults = {
            direction: 'horizontal',
            gap: 20,
            speed: 50,
            autoStart: true,
            pauseOnHover: true,
            minCloneMultiplier: 3,
            contentInsufficient: 'scroll',
            scrollThreshold: 0,
            scrollThresholdFromGap: false,
            gapBreakpoints: null,
            infoElements: null,
            stepMaxRatio: 0.5,
            resizeDebounceMs: 100,
            precisionThreshold: 1e8,
            maxDeltaTime: 0.05,
            cloneIdSuffix: true,
            onPlay: null,
            onPause: null,
            onDestroy: null,
            onResize: null,
            onRefresh: null,
        };
        this.options = { ...defaults, ...options };

        if (!['horizontal', 'vertical'].includes(this.options.direction)) {
            throw new Error('[InfiniteRollerTransition] direction 必须是 "horizontal" 或 "vertical"');
        }
        if (!['scroll', 'stop'].includes(this.options.contentInsufficient)) {
            throw new Error('[InfiniteRollerTransition] contentInsufficient 必须是 "scroll" 或 "stop"');
        }

        if (this.options.scrollThresholdFromGap && options.scrollThreshold === undefined) {
            this.options.scrollThreshold = this.options.gap;
        }
        if (this.options.gapBreakpoints) {
            this.options.gap = this._resolveGapFromBreakpoints();
        }

        this.track = null;
        this.originalItems = [];
        this.originalSize = 0;
        this.containerSize = 0;
        this.totalTrackSize = 0;
        this.isPlaying = false;
        this.isHoverPaused = false;
        this.resizeObserver = null;
        this.resizeTimer = null;
        this.destroyed = false;

        this._cycleTimer = null;
        this._cycleDuration = 0;
        this._targetTranslate = 0;
        this._resumeRemaining = 0;

        this._axis = this.options.direction === 'horizontal' ? 'X' : 'Y';

        this._handleHoverEnter = this._handleHoverEnter.bind(this);
        this._handleHoverLeave = this._handleHoverLeave.bind(this);
        this._handleResize = this._handleResize.bind(this);

        this._init();
    }

    // ============================================================
    //  初始化
    // ============================================================

    _init() {
        if (this.destroyed) return;

        const children = Array.from(this.container.children).filter(c => c.nodeType === 1);
        if (children.length === 0) {
            console.warn('[InfiniteRollerTransition] 容器内没有子元素');
            return;
        }
        this.originalItems = [...children];

        this.container.innerHTML = '';
        this.container.style.overflow = 'hidden';
        this.container.style.position = 'relative';

        this.track = document.createElement('div');
        this.track.className = 'infinite-track-transition';
        this.track.style.display = 'flex';
        this.track.style.willChange = 'transform';
        this.track.style.backfaceVisibility = 'hidden';
        this.track.style.flexShrink = '0';

        if (this.options.direction === 'horizontal') {
            this.track.style.flexDirection = 'row';
            this.track.style.alignItems = 'center';
            this.track.style.width = 'max-content';
        } else {
            this.track.style.flexDirection = 'column';
            this.track.style.alignItems = 'stretch';
            this.track.style.height = 'max-content';
        }

        this._applyMarginToItems(this.originalItems);
        this.originalItems.forEach(item => this.track.appendChild(item));
        this.container.appendChild(this.track);

        this._updateOriginalSize();
        this._cloneToAchieveSeamless();
        this._updateContainerSize();
        this._updateTrackSize();

        this._applyTransform(0);

        this._updateCenterMode();

        if (typeof this.options.onRefresh === 'function') {
            this.options.onRefresh.call(this);
        }
        this._updateInfoElements();

        if (this.options.pauseOnHover) {
            this.container.addEventListener('mouseenter', this._handleHoverEnter);
            this.container.addEventListener('mouseleave', this._handleHoverLeave);
        }

        if (window.ResizeObserver) {
            this.resizeObserver = new ResizeObserver(() => this._handleResize());
            this.resizeObserver.observe(this.container);
        }
        window.addEventListener('resize', this._handleResize);

        if (this.options.autoStart) this.play();
    }

    // ============================================================
    //  间距
    // ============================================================

    _applyMarginToItems(items) {
        const gap = this.options.gap;
        const dir = this.options.direction;
        if (dir === 'horizontal') {
            items.forEach(item => {
                item.style.marginRight = gap + 'px';
                item.style.marginBottom = '';
                item.style.marginLeft = '0px';
                item.style.marginTop = '0px';
            });
        } else {
            items.forEach(item => {
                item.style.marginBottom = gap + 'px';
                item.style.marginRight = '';
                item.style.marginLeft = '0px';
                item.style.marginTop = '0px';
            });
        }
    }

    _clearMarginFromItems(items) {
        items.forEach(item => {
            item.style.marginRight = '';
            item.style.marginBottom = '';
            item.style.marginLeft = '';
            item.style.marginTop = '';
        });
    }

    // ============================================================
    //  尺寸
    // ============================================================

    _updateOriginalSize() {
        if (!this.track || this.originalItems.length === 0) {
            this.originalSize = 0;
            return;
        }
        if (this.options.direction === 'horizontal') {
            this.originalSize = this.track.scrollWidth;
        } else {
            this.originalSize = this.track.scrollHeight;
        }
        if (this.originalSize <= 0) {
            let sum = 0;
            const lastIdx = this.originalItems.length - 1;
            if (this.options.direction === 'horizontal') {
                for (let i = 0; i <= lastIdx; i++) {
                    sum += this.originalItems[i].offsetWidth;
                    if (i < lastIdx) sum += this.options.gap;
                }
            } else {
                for (let i = 0; i <= lastIdx; i++) {
                    sum += this.originalItems[i].offsetHeight;
                    if (i < lastIdx) sum += this.options.gap;
                }
            }
            this.originalSize = sum;
        }
    }

    _updateContainerSize() {
        const rect = this.container.getBoundingClientRect();
        this.containerSize = this.options.direction === 'horizontal' ? rect.width : rect.height;
    }

    _updateTrackSize() {
        if (!this.track) return;
        if (this.options.direction === 'horizontal') {
            this.totalTrackSize = this.track.scrollWidth;
        } else {
            this.totalTrackSize = this.track.scrollHeight;
        }
    }

    _getContentWidth() {
        return Math.max(0, this.originalSize - this.options.gap);
    }

    // ============================================================
    //  克隆
    // ============================================================

    _cloneToAchieveSeamless() {
        if (this.originalSize <= 0 || this.originalItems.length === 0) return;

        this._updateContainerSize();
        const needStop = (this._getContentWidth() < this.containerSize - this.options.scrollThreshold * 2)
                         && (this.options.contentInsufficient === 'stop');

        if (needStop) {
            this._clearAllClones();
            if (this.isPlaying) {
                this.isPlaying = false;
                clearTimeout(this._cycleTimer);
                this._cycleTimer = null;
            }
            this._applyTransform(0);
            this._updateCenterMode();
            return;
        }

        this._updateCenterMode();

        let targetTotalSize = this.originalSize * Math.max(1, this.options.minCloneMultiplier);
        if (this._getContentWidth() < this.containerSize) {
            const required = this.originalSize + this.containerSize * 1.8;
            if (targetTotalSize < required) targetTotalSize = required;
        }

        const requiredCopies = Math.max(2, Math.ceil(targetTotalSize / this.originalSize));
        const existingChildren = Array.from(this.track.children);
        const cloneItems = existingChildren.filter(c => !this.originalItems.includes(c));
        const currentClonedSets = cloneItems.length / this.originalItems.length;
        const targetCloneSets = requiredCopies - 1;

        if (currentClonedSets < targetCloneSets) {
            const needAddSets = Math.ceil(targetCloneSets - currentClonedSets);
            for (let i = 0; i < needAddSets; i++) {
                this.originalItems.forEach(item => {
                    const clone = item.cloneNode(true);
                    if (this.options.cloneIdSuffix && clone.id) {
                        clone.id = `${clone.id}_clone_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                    }
                    this.track.appendChild(clone);
                });
            }
        } else if (currentClonedSets > targetCloneSets) {
            const removeSets = Math.ceil(currentClonedSets - targetCloneSets);
            const totalToRemove = removeSets * this.originalItems.length;
            const toRemove = cloneItems.slice(-totalToRemove);
            toRemove.forEach(cl => cl.remove());
        }

        this._updateTrackSize();
    }

    _clearAllClones() {
        if (!this.track) return;
        Array.from(this.track.children).forEach(child => {
            if (!this.originalItems.includes(child)) child.remove();
        });
        this._updateTrackSize();
    }

    // ============================================================
    //  居中模式
    // ============================================================

    _updateCenterMode() {
        if (!this.track || this.originalItems.length === 0) return;

        const isStopMode = this.options.contentInsufficient === 'stop';
        const isInsufficient = (this.originalSize > 0 && this.containerSize > 0)
                               && (this._getContentWidth() < this.containerSize - this.options.scrollThreshold * 2);
        const shouldCenter = isStopMode && isInsufficient;

        const lastItem = this.originalItems[this.originalItems.length - 1];
        const isHorizontal = this.options.direction === 'horizontal';

        if (shouldCenter) {
            this.track.style.justifyContent = 'center';
            if (isHorizontal) {
                this.track.style.width = '100%';
            } else {
                this.track.style.height = '100%';
            }
            if (lastItem) {
                if (isHorizontal) lastItem.style.marginRight = '0px';
                else lastItem.style.marginBottom = '0px';
            }
        } else {
            this.track.style.justifyContent = '';
            if (isHorizontal) {
                this.track.style.width = 'max-content';
                this.track.style.height = '';
            } else {
                this.track.style.width = '';
                this.track.style.height = 'max-content';
            }
            if (lastItem) {
                if (isHorizontal) lastItem.style.marginRight = this.options.gap + 'px';
                else lastItem.style.marginBottom = this.options.gap + 'px';
            }
        }
    }

    // ============================================================
    //  Transform 工具
    // ============================================================

    _applyTransform(value) {
        if (this._axis === 'X') {
            this.track.style.transform = `translate3d(${value}px, 0, 0)`;
        } else {
            this.track.style.transform = `translate3d(0, ${value}px, 0)`;
        }
    }

    _getComputedTranslate() {
        const m = getComputedStyle(this.track).transform;
        if (!m || m === 'none') return 0;
        const match = m.match(/matrix\(([^)]+)\)/);
        if (match) {
            const parts = match[1].split(',').map(Number);
            return this._axis === 'X' ? (parts[4] || 0) : (parts[5] || 0);
        }
        const match3d = m.match(/matrix3d\(([^)]+)\)/);
        if (match3d) {
            const parts = match3d[1].split(',').map(Number);
            return this._axis === 'X' ? (parts[12] || 0) : (parts[13] || 0);
        }
        return 0;
    }

    // ============================================================
    //  核心动画：CSS Transition 循环
    // ============================================================

    _startCycle(fromPosition, duration) {
        if (!this.isPlaying || this.isHoverPaused || this.destroyed) return;
        if (this.originalSize <= 0) return;

        const dur = (duration != null) ? duration : (this.originalSize / this.options.speed);
        if (dur <= 0 || !isFinite(dur)) return;

        this._cycleDuration = dur;
        this._targetTranslate = -this.originalSize;

        this.track.style.transition = `transform ${dur}s linear`;
        this._applyTransform(this._targetTranslate);

        clearTimeout(this._cycleTimer);
        this._cycleTimer = setTimeout(() => {
            if (!this.isPlaying || this.isHoverPaused || this.destroyed) return;
            this.track.style.transition = 'none';
            this._applyTransform(0);
            void this.track.offsetHeight;
            this._startCycle(0);
        }, dur * 1000);
    }

    // ============================================================
    //  公共 API
    // ============================================================

    play() {
        if (this.destroyed) return;
        if (this.isPlaying) return;

        if (this._getContentWidth() < this.containerSize - this.options.scrollThreshold * 2
            && this.options.contentInsufficient === 'stop') {
            return;
        }

        this.isPlaying = true;
        this.isHoverPaused = false;

        if (this._resumeRemaining > 0) {
            const pos = this._getComputedTranslate();
            this._startCycle(pos, this._resumeRemaining);
            this._resumeRemaining = 0;
        } else {
            this._startCycle(0);
        }

        if (typeof this.options.onPlay === 'function') {
            this.options.onPlay.call(this);
        }
    }

    pause() {
        if (this.destroyed) return;
        this.isPlaying = false;
        clearTimeout(this._cycleTimer);

        const pos = this._getComputedTranslate();
        this.track.style.transition = 'none';
        this._applyTransform(pos);

        const remaining = this._targetTranslate - pos;
        if (this._cycleDuration > 0 && this._targetTranslate !== 0) {
            const ratio = Math.abs(remaining) / this.originalSize;
            this._resumeRemaining = Math.max(0, ratio * this._cycleDuration);
        }

        if (typeof this.options.onPause === 'function') {
            this.options.onPause.call(this);
        }
    }

    stop() {
        this.pause();
        this._applyTransform(0);
        clearTimeout(this._cycleTimer);
    }

    refresh() {
        if (this.destroyed) return;

        const wasPlaying = this.isPlaying;
        const wasStopMode = this.options.contentInsufficient === 'stop'
            && this.originalSize > 0
            && this._getContentWidth() < this.containerSize - this.options.scrollThreshold * 2;
        this.pause();

        let stillExisting = this.originalItems.filter(el => el.isConnected && this.track && this.track.contains(el));
        if (stillExisting.length === 0) {
            const all = this.track ? Array.from(this.track.children) : [];
            if (all.length > 0) stillExisting = all;
            else return;
        }
        this.originalItems = stillExisting;
        if (this.originalItems.length === 0) return;

        if (this.track) {
            Array.from(this.track.children).filter(ch => !this.originalItems.includes(ch)).forEach(cl => cl.remove());
        }

        this._applyMarginToItems(this.originalItems);

        if (this.options.direction === 'horizontal') {
            this.track.style.width = 'max-content';
        } else {
            this.track.style.height = 'max-content';
        }

        this._updateOriginalSize();
        this._cloneToAchieveSeamless();
        this._updateContainerSize();
        this._updateTrackSize();

        this._applyTransform(0);
        this._updateCenterMode();

        const canPlay = !(this._getContentWidth() < this.containerSize - this.options.scrollThreshold * 2
            && this.options.contentInsufficient === 'stop');
        if (canPlay && (wasPlaying || wasStopMode)) this.play();

        if (typeof this.options.onRefresh === 'function') {
            this.options.onRefresh.call(this);
        }
        this._updateInfoElements();
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.pause();

        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        window.removeEventListener('resize', this._handleResize);

        if (this.container) {
            this.container.removeEventListener('mouseenter', this._handleHoverEnter);
            this.container.removeEventListener('mouseleave', this._handleHoverLeave);
        }

        if (this.track && this.container) {
            while (this.container.firstChild) this.container.removeChild(this.container.firstChild);
            this._clearMarginFromItems(this.originalItems);
            this.originalItems.forEach(item => this.container.appendChild(item));
        }

        this.track = null;
        this.originalItems = [];
        this.originalSize = 0;

        if (typeof this.options.onDestroy === 'function') {
            this.options.onDestroy.call(this);
        }
    }

    // ============================================================
    //  事件
    // ============================================================

    _handleHoverEnter() {
        if (this.options.pauseOnHover && this.isPlaying) {
            this.isHoverPaused = true;
            clearTimeout(this._cycleTimer);
            const pos = this._getComputedTranslate();
            this.track.style.transition = 'none';
            this._applyTransform(pos);
        }
    }

    _handleHoverLeave() {
        if (this.options.pauseOnHover && this.isHoverPaused) {
            this.isHoverPaused = false;
            if (this.isPlaying && !this.destroyed) {
                const pos = this._getComputedTranslate();
                const remaining = this._targetTranslate - pos;
                if (this._cycleDuration > 0 && this._targetTranslate !== 0) {
                    const ratio = Math.abs(remaining) / this.originalSize;
                    this._startCycle(pos, Math.max(0, ratio * this._cycleDuration));
                } else {
                    this._startCycle(0);
                }
            }
        }
    }

    _handleResize() {
        if (this.destroyed) return;
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
            if (this.options.gapBreakpoints) {
                this.options.gap = this._resolveGapFromBreakpoints();
            }
            if (typeof this.options.onResize === 'function') {
                this.options.onResize.call(this);
            }
            this.refresh();
            this.resizeTimer = null;
        }, this.options.resizeDebounceMs);
    }

    // ============================================================
    //  响应式 & 状态
    // ============================================================

    _resolveGapFromBreakpoints() {
        const bps = this.options.gapBreakpoints;
        if (!bps) return this.options.gap;
        const w = window.innerWidth;
        const thresholds = Object.keys(bps).filter(k => k !== 'default').map(Number).sort((a, b) => a - b);
        for (const t of thresholds) { if (w <= t) return bps[t]; }
        return bps.default !== undefined ? bps.default : this.options.gap;
    }

    _updateInfoElements() {
        const els = this.options.infoElements;
        if (!els) return;
        for (const [key, selector] of Object.entries(els)) {
            const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
            if (!el) continue;
            switch (key) {
                case 'gap':     el.textContent = this.options.gap + 'px'; break;
                case 'status':
                    el.textContent = (this.originalSize <= 0 || this.containerSize <= 0)
                        ? '⏳ 测量中…'
                        : (this.options.contentInsufficient === 'stop'
                            && this._getContentWidth() < this.containerSize - this.options.scrollThreshold * 2)
                            ? '⏸ 已停止，内容居中（自动）' : '▶ 正常滚动';
                    break;
                case 'origin':  el.textContent = (this.originalSize > 0 ? this.originalSize : '?') + 'px'; break;
                case 'contain': el.textContent = (this.containerSize > 0 ? this.containerSize : '?') + 'px'; break;
            }
        }
    }
}