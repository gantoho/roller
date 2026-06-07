/**
 * InfiniteRollerAnimation — CSS Animation @keyframes 驱动的无限循环滚动
 * ============================================================
 * 与 InfiniteRoller（rAF 版）API 完全一致，仅核心动画技术不同。
 *
 * 原理：
 *   动态创建 @keyframes（0%→100% = translate(0)→translate(-originalSize)），
 *   设置 animation: NAME Ds linear infinite，由浏览器合成器线程负责循环。
 *   暂停/恢复直接切换 animationPlayState，天然支持冻结。
 *
 * vs rAF：
 *   - 完全声明式，合成器线程处理，主线程几乎不参与
 *   - 暂停/恢复只需切换 animationPlayState，无需手动计算
 *   - 速度变化需替换 @keyframes（移除旧 <style> 创建新的）
 */

class InfiniteRollerAnimation {

    constructor(container, options = {}) {
        if (!container || !(container instanceof HTMLElement)) {
            throw new Error('[InfiniteRollerAnimation] 需要提供一个有效的 DOM 容器');
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
            cloneIdSuffix: true,
            resizeDebounceMs: 100,
            onReady: null,       // 初始化完成回调（只触发一次）
            onPlay: null,
            onPause: null,
            onDestroy: null,
            onResize: null,
            onRefresh: null,
        };
        this.options = { ...defaults, ...options };

        if (!['horizontal', 'vertical'].includes(this.options.direction)) {
            throw new Error('[InfiniteRollerAnimation] direction 必须是 "horizontal" 或 "vertical"');
        }
        if (!['scroll', 'stop'].includes(this.options.contentInsufficient)) {
            throw new Error('[InfiniteRollerAnimation] contentInsufficient 必须是 "scroll" 或 "stop"');
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

        this._styleEl = null;
        this._animName = '';

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
            console.warn('[InfiniteRollerAnimation] 容器内没有子元素');
            return;
        }
        this.originalItems = [...children];

        this.container.innerHTML = '';
        this.container.style.overflow = 'hidden';
        this.container.style.position = 'relative';

        this.track = document.createElement('div');
        this.track.className = 'infinite-track-animation';

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

        this._updateAnimation();

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

        // ---- 初始化完成钩子 ----
        if (typeof this.options.onReady === 'function') {
            this.options.onReady.call(this);
        }
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
            }
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
    //  CSS Animation 管理
    // ============================================================

    _updateAnimation() {
        if (this.originalSize <= 0) return;

        if (this._styleEl) {
            this._styleEl.remove();
            this._styleEl = null;
        }

        const duration = this.originalSize / this.options.speed;
        if (duration <= 0 || !isFinite(duration)) return;

        this._animName = `roller-anim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        this._styleEl = document.createElement('style');
        this._styleEl.textContent = `@keyframes ${this._animName} { 0% { transform: translate3d(0,0,0); } 100% { transform: translate3d(${this._axis === 'X' ? '-' + this.originalSize + 'px,0,0' : '0,-' + this.originalSize + 'px,0'}); } }`;
        document.head.appendChild(this._styleEl);

        this.track.style.animation = `${this._animName} ${duration}s linear infinite`;

        if (!this.isPlaying || this.isHoverPaused) {
            this.track.style.animationPlayState = 'paused';
        }
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

        if (this.track) {
            this.track.style.animationPlayState = 'running';
        }

        if (typeof this.options.onPlay === 'function') {
            this.options.onPlay.call(this);
        }
    }

    pause() {
        if (this.destroyed) return;
        this.isPlaying = false;

        if (this.track) {
            this.track.style.animationPlayState = 'paused';
        }

        if (typeof this.options.onPause === 'function') {
            this.options.onPause.call(this);
        }
    }

    stop() {
        this.pause();
        // 重新创建 animation 以重置位置
        if (this.track) {
            this.track.style.animation = 'none';
            void this.track.offsetHeight;
            this._updateAnimation();
        }
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

        // 保存当前滚动位置比例（避免 resize 时闪回起点）
        let currentPos = 0;
        const m = getComputedStyle(this.track).transform;
        if (m && m !== 'none') {
            const m3d = m.match(/matrix3d\(([^)]+)\)/);
            const m2d = m.match(/matrix\(([^)]+)\)/);
            if (m3d) {
                const p = m3d[1].split(',').map(Number);
                currentPos = this._axis === 'X' ? p[12] : p[13];
            } else if (m2d) {
                const p = m2d[1].split(',').map(Number);
                currentPos = this._axis === 'X' ? (p[4] || 0) : (p[5] || 0);
            }
        }
        const ratio = this.originalSize > 0 ? Math.abs(currentPos) / this.originalSize : 0;

        this._updateOriginalSize();
        this._cloneToAchieveSeamless();
        this._updateContainerSize();
        this._updateTrackSize();

        // 重新创建 animation（旧的 @keyframes 基于旧的 originalSize）
        this.track.style.animation = 'none';
        void this.track.offsetHeight;
        this._updateAnimation();
        // 按比例恢复动画位置（负 delay 让动画从对应位置开始）
        if (ratio > 0) {
            this.track.style.animationDelay = -(ratio * (this.originalSize / this.options.speed)) + 's';
        }
        if (!this.isPlaying) {
            this.track.style.animationPlayState = 'paused';
        }

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

        if (this._styleEl) {
            this._styleEl.remove();
            this._styleEl = null;
        }

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
            if (this.track) {
                this.track.style.animationPlayState = 'paused';
            }
        }
    }

    _handleHoverLeave() {
        if (this.options.pauseOnHover && this.isHoverPaused) {
            this.isHoverPaused = false;
            if (this.isPlaying && !this.destroyed && this.track) {
                this.track.style.animationPlayState = 'running';
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