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
            stepMaxRatio: 0.5,
            resizeDebounceMs: 100,
            precisionThreshold: 1e8,
            maxDeltaTime: 0.05,
            cloneIdSuffix: true,
            onPlay: null,
            onPause: null,
            onDestroy: null,
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

    /** 测量原始一份内容的总尺寸（含 margin） */
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
        const needStop = (this.originalSize < this.containerSize)
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
            return;
        }

        // ---- 计算目标轨道总长度 ----
        let targetTotalSize = this.originalSize * Math.max(1, this.options.minCloneMultiplier);

        // 当内容不足容器且策略为 'scroll' 时，确保轨道足够覆盖容器
        if (this.originalSize < this.containerSize) {
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
        if (this.originalSize < this.containerSize && this.options.contentInsufficient === 'stop') {
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

        // 重新测量 + 克隆
        this._updateOriginalSize();
        this._cloneToAchieveSeamless();
        this._updateContainerSize();
        this._updateTrackSize();

        // 重置偏移
        this.scrollOffset = 0;
        this._applyTransformFromOffset();

        // 恢复播放
        if (wasPlaying) {
            const canPlay = !(this.originalSize < this.containerSize && this.options.contentInsufficient === 'stop');
            if (canPlay) {
                this.play();
            }
        }
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

    /** resize 事件防抖处理 */
    _handleResize() {
        if (this.destroyed) return;
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
            this.refresh();
            this.resizeTimer = null;
        }, this.options.resizeDebounceMs);
    }
}