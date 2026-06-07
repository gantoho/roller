/**
 * InfiniteRoller — 通用无限循环滚动组件
 * ============================================================
 * 基于 requestAnimationFrame + CSS3 transform 硬件加速实现，
 * 支持水平/垂直方向、无缝衔接、多配置项。
 *
 * 核心原理：
 *   1. 将原始内容克隆多份放入轨道，确保轨道总尺寸足够长
 *   2. 滚动偏移量单调递增，通过 `偏移量 % 原始尺寸` 取模映射到 transform
 *   3. 多副本保证取模回绕时视口内内容连续，视觉无跳跃
 *   4. 子项使用独立 margin 替代 CSS gap，避免克隆组边界间距突变
 *
 * 用法：
 *   const roller = new InfiniteRoller(document.getElementById('container'), {
 *       direction: 'horizontal',
 *       gap: 24,
 *       speed: 60,
 *   });
 */
class InfiniteRoller {

    /**
     * @param {HTMLElement} container  滚动容器元素 (overflow 将被设为 hidden)
     * @param {Object}      [options]  配置项
     * @param {string}      [options.direction='horizontal']   滚动方向 'horizontal' | 'vertical'
     * @param {number}      [options.gap=20]                   每项之间的间距(px)
     * @param {number}      [options.speed=50]                 滚动速度(像素/秒)
     * @param {boolean}     [options.autoStart=true]           是否自动开始滚动
     * @param {boolean}     [options.pauseOnHover=true]        鼠标悬停时暂停滚动
     * @param {number}      [options.minCloneMultiplier=3]     最小克隆倍数（轨道总长至少为原始尺寸的 N 倍）
     * @param {string}      [options.contentInsufficient='scroll']
     *                    内容总尺寸小于容器尺寸时的处理策略：
     *                      - 'scroll' : 继续滚动，自动复制内容填满容器
     *                      - 'stop'    : 停止滚动，仅保留原始内容，不做克隆
     * @param {number}      [options.stepMaxRatio=0.5]         单帧最大步长占原始尺寸比例，防止切后台后跳跃
     * @param {number}      [options.resizeDebounceMs=100]     resize 防抖间隔(毫秒)
     * @param {number}      [options.precisionThreshold=1e8]   偏移量超过此值时主动取模，防止浮点精度丢失
     * @param {number}      [options.maxDeltaTime=0.05]        单帧最大时间差(秒)，防止切后台后的超大步长
     * @param {boolean}     [options.cloneIdSuffix=true]       克隆元素时是否自动给 id 添加唯一后缀避免冲突
     * @param {Function}    [options.onReady=null]             实例初始化完成回调（只触发一次）
 * @param {Function}    [options.onPlay=null]              开始滚动回调
 * @param {Function}    [options.onPause=null]             暂停滚动回调
 * @param {Function}    [options.onDestroy=null]           销毁时回调
     */
    constructor(container, options = {}) {
        if (!container || !(container instanceof HTMLElement)) {
            throw new Error('[InfiniteRoller] 需要提供一个有效的 DOM 容器');
        }

        this.container = container;

        // ===== 合并默认配置 =====
        const defaults = {
            direction: 'horizontal',
            gap: 20,
            speed: 50,
            autoStart: true,
            pauseOnHover: true,
            minCloneMultiplier: 3,
            contentInsufficient: 'scroll',   // 'scroll' | 'stop'
            scrollThreshold: 0,        // 提前触发阈值（px）：content >= container - 阈值×2 时滚动，确保内容两侧始终保留阈值间距
            scrollThresholdFromGap: false, // 若为 true，scrollThreshold 自动取 gap 的值，无需手动设置
            gapBreakpoints: null,      // 响应式断点 { 600: 6, 1024: 16, default: 30 }，启用后自动按窗口宽度设置 gap
            infoElements: null,        // 自动更新状态元素 { gap: '#el', status: '#el', origin: '#el', contain: '#el' }
            stepMaxRatio: 0.5,
            resizeDebounceMs: 100,
            precisionThreshold: 1e8,
            maxDeltaTime: 0.05,
            cloneIdSuffix: true,
            onReady: null,       // 初始化完成回调（只触发一次）
            onPlay: null,
            onPause: null,
            onDestroy: null,
            onResize: null,      // resize 触发 refresh 前调用 (this → 实例)
            onRefresh: null,     // refresh 完成后调用 (this → 实例)
        };
        this.options = { ...defaults, ...options };

        // 校验方向
        if (!['horizontal', 'vertical'].includes(this.options.direction)) {
            throw new Error('[InfiniteRoller] direction 必须是 "horizontal" 或 "vertical"');
        }
        // 校验内容不足策略
        if (!['scroll', 'stop'].includes(this.options.contentInsufficient)) {
            throw new Error('[InfiniteRoller] contentInsufficient 必须是 "scroll" 或 "stop"');
        }

        // 若启用 scrollThresholdFromGap 且用户未显式设置 scrollThreshold，自动取 gap 的值
        if (this.options.scrollThresholdFromGap && options.scrollThreshold === undefined) {
            this.options.scrollThreshold = this.options.gap;
        }

        // 若启用 gapBreakpoints，根据当前窗口宽度计算 gap
        if (this.options.gapBreakpoints) {
            this.options.gap = this._resolveGapFromBreakpoints();
        }

        // ===== 内部状态 =====
        this.track = null;                // 滚动轨道 DOM 元素
        this.originalItems = [];          // 原始子元素（非克隆）数组
        this.originalSize = 0;            // 原始一份内容的总尺寸（含 margin，单位 px）
        this.containerSize = 0;           // 容器可视区尺寸（宽/高，单位 px）
        this.totalTrackSize = 0;          // 轨道总尺寸（克隆后，单位 px）
        this.scrollOffset = 0;            // 单调递增偏移量（px），永不重置，渲染时取模
        this.animationId = null;          // requestAnimationFrame ID
        this.lastTimestamp = 0;           // 上一帧时间戳
        this.isPlaying = false;           // 是否正在播放
        this.isHoverPaused = false;       // 是否因悬停而暂停
        this.resizeObserver = null;       // ResizeObserver 实例
        this.resizeTimer = null;          // resize 防抖定时器
        this.destroyed = false;           // 是否已销毁

        // 绑定上下文
        this._animationLoop = this._animationLoop.bind(this);
        this._handleHoverEnter = this._handleHoverEnter.bind(this);
        this._handleHoverLeave = this._handleHoverLeave.bind(this);
        this._handleResize = this._handleResize.bind(this);

        this._init();
    }

    // ============================================================
    //  初始化
    // ============================================================

    /** 初始化：构建轨道、测量尺寸、克隆内容、启动滚动 */
    _init() {
        if (this.destroyed) return;

        // 获取直接子元素（忽略文本节点）
        const children = Array.from(this.container.children).filter(c => c.nodeType === 1);
        if (children.length === 0) {
            console.warn('[InfiniteRoller] 容器内没有子元素，无法滚动');
            return;
        }
        this.originalItems = [...children];

        // ---- 构建轨道 DOM ----
        this.container.innerHTML = '';
        this.container.style.overflow = 'hidden';
        this.container.style.position = 'relative';

        this.track = document.createElement('div');
        this.track.className = 'infinite-track';

        if (this.options.direction === 'horizontal') {
            this.track.style.flexDirection = 'row';
            this.track.style.alignItems = 'center';
            this.track.style.width = 'max-content';
        } else {
            this.track.style.flexDirection = 'column';
            this.track.style.alignItems = 'stretch';
            this.track.style.height = 'max-content';
        }

        // 给原始项设置间距 margin
        this._applyMarginToItems(this.originalItems);
        this.originalItems.forEach(item => this.track.appendChild(item));
        this.container.appendChild(this.track);

        // ---- 测量原始尺寸 ----
        this._updateOriginalSize();

        // ---- 克隆副本 ----
        this._cloneToAchieveSeamless();

        // ---- 更新完整轨道尺寸 ----
        this._updateContainerSize();
        this._updateTrackSize();

        // ---- 初始偏移归零 ----
        this.scrollOffset = 0;
        this._applyTransformFromOffset();

        // ---- 居中状态更新（基于最终尺寸） ----
        this._updateCenterMode();

        // ---- 触发 onRefresh 钩子（初始状态通知） ----
        if (typeof this.options.onRefresh === 'function') {
            this.options.onRefresh.call(this);
        }

        // 自动更新 infoElements
        this._updateInfoElements();

        // ---- 事件绑定 ----
        if (this.options.pauseOnHover) {
            this.container.addEventListener('mouseenter', this._handleHoverEnter);
            this.container.addEventListener('mouseleave', this._handleHoverLeave);
        }

        if (window.ResizeObserver) {
            this.resizeObserver = new ResizeObserver(() => this._handleResize());
            this.resizeObserver.observe(this.container);
        }
        window.addEventListener('resize', this._handleResize);

        // ---- 自动启动 ----
        if (this.options.autoStart) {
            this.play();
        }

        // ---- 初始化完成钩子 ----
        if (typeof this.options.onReady === 'function') {
            this.options.onReady.call(this);
        }
    }

    // ============================================================
    //  间距管理
    // ============================================================

    /** 为给定的元素列表设置 margin 间距（取决于方向） */
    _applyMarginToItems(items) {
        const gap = this.options.gap;
        const direction = this.options.direction;

        if (direction === 'horizontal') {
            items.forEach(item => {
                item.style.marginRight = `${gap}px`;
                item.style.marginBottom = '';
                item.style.marginLeft = '0px';
                item.style.marginTop = '0px';
            });
        } else {
            items.forEach(item => {
                item.style.marginBottom = `${gap}px`;
                item.style.marginRight = '';
                item.style.marginLeft = '0px';
                item.style.marginTop = '0px';
            });
        }
    }

    /** 清除原始项的 margin 样式 */
    _clearMarginFromItems(items) {
        items.forEach(item => {
            item.style.marginRight = '';
            item.style.marginBottom = '';
            item.style.marginLeft = '';
            item.style.marginTop = '';
        });
    }

    // ============================================================
    //  尺寸测量
    // ============================================================

    /** 测量原始一份内容的总尺寸（含 item 间 margin，含末项 trailing margin） */
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

        // 注意：末项的 trailing margin 是视觉布局的一部分，取模回绕时需要该间距
        // 才能让最后一项与第一项之间的过渡平滑无闪烁，因此不减去末项的 margin。

        // 兜底：若 scrollWidth/Height 不准确，手动累加
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

    /** 获取视觉内容宽度（不含末项 trailing margin），用于判断内容是否不足 */
    _getContentWidth() {
        return Math.max(0, this.originalSize - this.options.gap);
    }

    /** 更新容器可视区尺寸 */
    _updateContainerSize() {
        const rect = this.container.getBoundingClientRect();
        if (this.options.direction === 'horizontal') {
            this.containerSize = rect.width;
        } else {
            this.containerSize = rect.height;
        }
    }

    /** 更新轨道总尺寸（克隆完成后） */
    _updateTrackSize() {
        if (!this.track) return;
        if (this.options.direction === 'horizontal') {
            this.totalTrackSize = this.track.scrollWidth;
        } else {
            this.totalTrackSize = this.track.scrollHeight;
        }
    }

    // ============================================================
    //  克隆策略
    // ============================================================

    /**
     * 克隆策略：
     *  - 若 contentInsufficient === 'stop' 且内容尺寸 < 容器尺寸，则不清除克隆只保留原始，不进行滚动
     *  - 否则按 minCloneMultiplier 倍数克隆，确保轨道足够长
     */
    _cloneToAchieveSeamless() {
        if (this.originalSize <= 0 || this.originalItems.length === 0) return;

        // ---- 判断是否需要停止 ----
        this._updateContainerSize();
        const needStop = (this._getContentWidth() < this.containerSize - this.options.scrollThreshold * 2)
                         && (this.options.contentInsufficient === 'stop');

        if (needStop) {
            // 策略为 'stop'：清除所有克隆，仅保留原始内容
            this._clearAllClones();
            if (this.isPlaying) {
                this.isPlaying = false;
                if (this.animationId) {
                    cancelAnimationFrame(this.animationId);
                    this.animationId = null;
                }
            }
            this._applyTransformFromOffset();
            this._updateCenterMode();
            return;
        }

        // ---- 非 stop 模式：确保不处于居中状态 ----
        // 当内容从不足变为充足时（如窗口缩小），恢复轨道为滚动布局
        this._updateCenterMode();

        // ---- 计算目标轨道总长度 ----
        let targetTotalSize = this.originalSize * Math.max(1, this.options.minCloneMultiplier);

        // 当内容不足容器且策略为 'scroll' 时，确保轨道足够覆盖容器
        if (this._getContentWidth() < this.containerSize) {
            const required = this.originalSize + this.containerSize * 1.8;
            if (targetTotalSize < required) {
                targetTotalSize = required;
            }
        }

        const requiredCopies = Math.max(2, Math.ceil(targetTotalSize / this.originalSize));

        // ---- 计算需要增删的克隆份数 ----
        const existingChildren = Array.from(this.track.children);
        const cloneItems = existingChildren.filter(child => !this.originalItems.includes(child));
        const currentClonedSets = cloneItems.length / this.originalItems.length;
        const targetCloneSets = requiredCopies - 1;

        if (currentClonedSets < targetCloneSets) {
            // 需要增加克隆
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
            // 需要移除多余的克隆
            const removeSets = Math.ceil(currentClonedSets - targetCloneSets);
            const totalToRemove = removeSets * this.originalItems.length;
            const toRemove = cloneItems.slice(-totalToRemove);
            toRemove.forEach(cl => cl.remove());
        }

        // 更新轨道尺寸
        this._updateTrackSize();
    }

    /** 清除所有克隆内容（仅保留原始项） */
    _clearAllClones() {
        if (!this.track) return;
        const children = Array.from(this.track.children);
        children.forEach(child => {
            if (!this.originalItems.includes(child)) {
                child.remove();
            }
        });
        this._updateTrackSize();
    }

    // ============================================================
    //  居中模式（contentInsufficient: 'stop' + 内容不足时）
    // ============================================================

    /**
     * 当 contentInsufficient === 'stop' 且内容尺寸 < 容器尺寸时：
     *   1. 清除轨道中所有克隆（由 _cloneToAchieveSeamless 处理）
     *   2. 将轨道宽度设为 100%，justifyContent 设为 center，使内容整体居中
     *   3. 最后一项的 margin 置零，避免尾部多余间距破坏视觉居中
     *
     * 当内容充足或非 stop 模式时，恢复轨道和 margin 到正常滚动状态。
     * 此方法在 _cloneToAchieveSeamless 和 refresh 末尾自动调用。
     */
    _updateCenterMode() {
        if (!this.track || this.originalItems.length === 0) return;

        const isStopMode = this.options.contentInsufficient === 'stop';
        const isInsufficient = (this.originalSize > 0 && this.containerSize > 0)
                               && (this._getContentWidth() < this.containerSize - this.options.scrollThreshold * 2);
        const shouldCenter = isStopMode && isInsufficient;

        const lastItem = this.originalItems[this.originalItems.length - 1];
        const isHorizontal = this.options.direction === 'horizontal';

        if (shouldCenter) {
            // ── 居中模式 ──
            this.track.style.justifyContent = 'center';
            if (isHorizontal) {
                this.track.style.width = '100%';
            } else {
                this.track.style.height = '100%';
            }
            // 最后一项 margin 置零
            if (lastItem) {
                if (isHorizontal) {
                    lastItem.style.marginRight = '0px';
                } else {
                    lastItem.style.marginBottom = '0px';
                }
            }
        } else {
            // ── 恢复滚动模式 ──
            this.track.style.justifyContent = '';
            // 恢复轨道为内容宽度（max-content），而非清除到 auto
            // 若清空为 ''，轨道将回退到块级默认 width: auto ≈ 容器宽度，
            // 导致 scrollWidth 测量错误
            if (isHorizontal) {
                this.track.style.width = 'max-content';
                this.track.style.height = '';
            } else {
                this.track.style.width = '';
                this.track.style.height = 'max-content';
            }
            // 恢复最后一项 margin
            if (lastItem) {
                if (isHorizontal) {
                    lastItem.style.marginRight = this.options.gap + 'px';
                } else {
                    lastItem.style.marginBottom = this.options.gap + 'px';
                }
            }
        }
    }

    // ============================================================
    //  变换应用
    // ============================================================

    /** 根据 scrollOffset 取模后应用 transform */
    _applyTransformFromOffset() {
        if (!this.track || this.originalSize <= 0) return;

        // 取模映射到 [0, originalSize)
        let effectiveOffset = this.scrollOffset % this.originalSize;
        if (effectiveOffset < 0) effectiveOffset += this.originalSize;

        const translateValue = -effectiveOffset;
        if (this.options.direction === 'horizontal') {
            this.track.style.transform = `translate3d(${translateValue}px, 0, 0)`;
        } else {
            this.track.style.transform = `translate3d(0, ${translateValue}px, 0)`;
        }
    }

    // ============================================================
    //  动画循环
    // ============================================================

    /** 核心动画循环：基于时间差累加偏移量 */
    _animationLoop(now) {
        if (this.destroyed) return;

        // 暂停状态不驱动动画
        if (!this.isPlaying || this.isHoverPaused) {
            this.animationId = null;
            return;
        }

        // 初始化上一帧时间戳
        if (!this.lastTimestamp) {
            this.lastTimestamp = now;
            this.animationId = requestAnimationFrame(this._animationLoop);
            return;
        }

        // 计算时间差（限制最大值，防止切后台后跳跃）
        let delta = Math.min(this.options.maxDeltaTime, (now - this.lastTimestamp) / 1000);
        if (delta <= 0) {
            this.lastTimestamp = now;
            this.animationId = requestAnimationFrame(this._animationLoop);
            return;
        }

        // 计算本帧步长
        let step = this.options.speed * delta;

        // 限制单帧最大步长
        if (this.originalSize > 0 && step > this.originalSize * this.options.stepMaxRatio) {
            step = this.originalSize * this.options.stepMaxRatio;
        }

        // 偏移量递增
        this.scrollOffset += step;

        // 防止数值过大失去浮点精度
        if (this.scrollOffset > this.options.precisionThreshold && this.originalSize > 0) {
            this.scrollOffset = this.scrollOffset % this.originalSize;
        }

        this._applyTransformFromOffset();
        this.lastTimestamp = now;
        this.animationId = requestAnimationFrame(this._animationLoop);
    }

    // ============================================================
    //  公共 API
    // ============================================================

    /** 开始滚动 */
    play() {
        if (this.destroyed) return;
        if (this.isPlaying) return;

        // 内容不足且策略为 stop 时禁止播放
        if (this._getContentWidth() < this.containerSize - this.options.scrollThreshold * 2 && this.options.contentInsufficient === 'stop') {
            console.log('[InfiniteRoller] 内容不足容器且 contentInsufficient 为 "stop"，禁止滚动');
            return;
        }

        this.isPlaying = true;
        this.isHoverPaused = false;
        this.lastTimestamp = 0;

        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
        this.animationId = requestAnimationFrame(this._animationLoop);

        if (typeof this.options.onPlay === 'function') {
            this.options.onPlay.call(this);
        }
    }

    /** 暂停滚动 */
    pause() {
        if (this.destroyed) return;

        this.isPlaying = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        if (typeof this.options.onPause === 'function') {
            this.options.onPause.call(this);
        }
    }

    /** 停止滚动并重置位置到起点 */
    stop() {
        this.pause();
        this.scrollOffset = 0;
        this._applyTransformFromOffset();
    }

    /**
     * 刷新组件：重新读取内容布局、重新判断克隆份数
     * 适用于窗口 resize 或动态增删内容后调用
     */
    refresh() {
        if (this.destroyed) return;

        const wasPlaying = this.isPlaying;
        // 记录之前是否处于"stop 模式"（内容不足停止不滚动），
        // 用于后续 resize 后内容充足时自动恢复播放
        const wasStopMode = this.options.contentInsufficient === 'stop' &&
                            this.originalSize > 0 &&
                            this._getContentWidth() < this.containerSize - this.options.scrollThreshold * 2;
        this.pause();

        // 重新捕获仍然存在于轨道中的原始项
        let stillExisting = this.originalItems.filter(el => el.isConnected && this.track && this.track.contains(el));
        if (stillExisting.length === 0) {
            // 原始项全部被替换，以轨道当前所有子项作为新原始项
            const allChildren = this.track ? Array.from(this.track.children) : [];
            if (allChildren.length > 0) {
                stillExisting = allChildren;
            } else {
                return;
            }
        }
        this.originalItems = stillExisting;

        if (this.originalItems.length === 0) return;

        // 清除所有克隆
        if (this.track) {
            const clones = Array.from(this.track.children).filter(ch => !this.originalItems.includes(ch));
            clones.forEach(cl => cl.remove());
        }

        // 重新应用 margin（配置可能变化）
        this._applyMarginToItems(this.originalItems);

        // 测量前先确保轨道宽度基于内容（max-content），
        // 避免之前居中模式残留的 width: 100% 导致 scrollWidth 测量偏小
        if (this.options.direction === 'horizontal') {
            this.track.style.width = 'max-content';
        } else {
            this.track.style.height = 'max-content';
        }

        // 重新测量 + 克隆
        this._updateOriginalSize();
        this._cloneToAchieveSeamless();
        this._updateContainerSize();
        this._updateTrackSize();

        // 重置偏移
        this.scrollOffset = 0;
        this._applyTransformFromOffset();

        // 更新居中状态（基于最新尺寸）
        this._updateCenterMode();

        // 恢复 / 启动播放
        const canPlay = !(this._getContentWidth() < this.containerSize - this.options.scrollThreshold * 2 && this.options.contentInsufficient === 'stop');
        if (canPlay && (wasPlaying || wasStopMode)) {
            this.play();
        }

        // onRefresh 钩子：通知外部刷新完成
        if (typeof this.options.onRefresh === 'function') {
            this.options.onRefresh.call(this);
        }

        // 自动更新 infoElements
        this._updateInfoElements();
    }

    /** 销毁组件，释放所有资源和事件监听 */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;

        this.pause();

        // 断开 ResizeObserver
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        window.removeEventListener('resize', this._handleResize);

        // 移除事件监听
        if (this.container) {
            this.container.removeEventListener('mouseenter', this._handleHoverEnter);
            this.container.removeEventListener('mouseleave', this._handleHoverLeave);
        }

        // 还原 DOM：移除轨道，将原始项直接放回容器
        if (this.track && this.container) {
            while (this.container.firstChild) {
                this.container.removeChild(this.container.firstChild);
            }
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
    //  事件处理
    // ============================================================

    _handleHoverEnter() {
        if (this.options.pauseOnHover && this.isPlaying) {
            this.isHoverPaused = true;
            if (this.animationId) {
                cancelAnimationFrame(this.animationId);
                this.animationId = null;
            }
        }
    }

    _handleHoverLeave() {
        if (this.options.pauseOnHover && this.isHoverPaused) {
            this.isHoverPaused = false;
            if (this.isPlaying && !this.destroyed) {
                this.lastTimestamp = 0;
                this.animationId = requestAnimationFrame(this._animationLoop);
            }
        }
    }

    // ============================================================
    //  响应式断点
    // ============================================================

    /**
     * 根据 gapBreakpoints 配置和当前窗口宽度计算 gap 值
     * gapBreakpoints 格式: { 600: 6, 1024: 16, default: 30 }
     * key 为最大宽度阈值（px），default 键为兜底值
     */
    _resolveGapFromBreakpoints() {
        const bps = this.options.gapBreakpoints;
        if (!bps) return this.options.gap;

        const w = window.innerWidth;
        // 收集阈值并排序（升序）
        const thresholds = Object.keys(bps)
            .filter(k => k !== 'default')
            .map(Number)
            .sort((a, b) => a - b);

        // 找到第一个满足 w <= threshold 的断点
        for (const t of thresholds) {
            if (w <= t) return bps[t];
        }
        // 没有匹配则返回 default
        return bps.default !== undefined ? bps.default : this.options.gap;
    }

    // ============================================================
    //  状态元素更新
    // ============================================================

    /**
     * 根据 infoElements 配置自动更新 DOM 元素文本
     * infoElements 格式: { gap: '#sel', status: '#sel', origin: '#sel', contain: '#sel', cssGap: '#sel' }
     */
    _updateInfoElements() {
        const els = this.options.infoElements;
        if (!els) return;

        for (const [key, selector] of Object.entries(els)) {
            const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
            if (!el) continue;

            switch (key) {
                case 'gap':
                    el.textContent = this.options.gap + 'px';
                    break;
                case 'status':
                    if (this.originalSize <= 0 || this.containerSize <= 0) {
                        el.textContent = '⏳ 测量中…';
                    } else if (this.options.contentInsufficient === 'stop' && this._getContentWidth() < this.containerSize - this.options.scrollThreshold * 2) {
                        el.textContent = '⏸ 已停止，内容居中（自动）';
                    } else {
                        el.textContent = '▶ 正常滚动';
                    }
                    break;
                case 'origin':
                    el.textContent = (this.originalSize > 0 ? this.originalSize : '?') + 'px';
                    break;
                case 'contain':
                    el.textContent = (this.containerSize > 0 ? this.containerSize : '?') + 'px';
                    break;
                case 'cssGap':
                    if (this.track) {
                        el.textContent = getComputedStyle(this.track).gap;
                    }
                    break;
            }
        }
    }

    /** resize 事件防抖处理 */
    _handleResize() {
        if (this.destroyed) return;
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
            // 若配置了 gapBreakpoints，自动按窗口宽度更新 gap
            if (this.options.gapBreakpoints) {
                this.options.gap = this._resolveGapFromBreakpoints();
            }
            // onResize 钩子：允许在 refresh 前调整配置（如响应式 gap）
            if (typeof this.options.onResize === 'function') {
                this.options.onResize.call(this);
            }
            this.refresh();
            this.resizeTimer = null;
        }, this.options.resizeDebounceMs);
    }
}