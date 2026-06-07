/**
 * SimpleRoller — 轻量 rAF 无限滚动库
 *
 * 无外部依赖，纯原生 JavaScript + requestAnimationFrame 驱动。
 * 从手写 demo 中抽离，适用于品牌轮播、图标墙、合作伙伴展示等场景。
 *
 * ── 核心原理 ──
 *   将原始内容的子元素复制多份追加到同一个轨道末尾，然后通过
 *   requestAnimationFrame 持续移动轨道的 transform 属性。当累计
 *   滚动距离达到一组完整内容的宽度时归零偏移量，实现视觉上
 *   无缝循环滚动的效果。
 *
 * ── 用法示例 ──
 *   new SimpleRoller('#container', {
 *       track: '.scroll-box',             // 轨道选择器（容器内直接子元素）
 *       speed: 1.1,                       // 每帧移动像素数
 *       direction: 'left',                // left | right | up | down
 *       pauseOnHover: true,               // 鼠标悬停时暂停
 *       clones: 2,                        // 内容克隆份数
 *       responsive: { 430: 0.55 },        // { 窗口宽度断点: 对应速度, … }
 *       contentInsufficient: 'center',    // 内容不足时：'stop'(默认) | 'center'(居中)
 *       onReady: function () {},          // 初始化完成回调
 *   });
 *
 * ── 为什么不用克隆整个轨道的方案？ ──
 *   如果克隆整个 <ul> 元素再并排摆放，需要在容器上额外设置 gap 来保证
 *   各组之间的间距与组内项目间距一致，且响应式断点变化时要在两处 CSS
 *   规则中同步修改 gap，增加心智负担。改为克隆子元素到同一个轨道内，
 *   间距完全由 CSS gap 一处控制，简洁可靠。
 */
(function (global) {
    'use strict';

    /**
     * 构造函数
     *
     * @param {string|Element} container - 外层容器，设置 overflow: hidden
     * @param {Object} options - 配置项（见文件头注释）
     */
    function SimpleRoller(container, options) {
        if (!container) throw new Error('[SimpleRoller] 缺少 container 参数');

        // 支持传入选择器字符串或 DOM 元素
        this.container = typeof container === 'string'
            ? document.querySelector(container)
            : container;

        if (!this.container) throw new Error('[SimpleRoller] 未找到容器元素');

        // 合并默认配置与用户配置
        this.opts = Object.assign({
            track: null,               // 轨道选择器，默认取容器的第一个子元素
            speed: 1.1,                // 基准速度（px/帧）
            direction: 'left',         // 滚动方向
            pauseOnHover: true,        // 鼠标悬停暂停
            clones: 2,                 // 克隆份数
            responsive: null,          // 响应式速度映射
            contentInsufficient: 'stop', // 内容不足策略：'stop' 仅停止 | 'center' 居中显示
            onReady: null,             // 就绪回调
        }, options);

        // ── 内部状态 ──
        this._scrollOffset = 0;           // 累计滚动偏移量（始终为正）
        this._animationFrameId = null;    // requestAnimationFrame 句柄
        this._isPaused = false;           // 是否暂停
        this._isScrollable = false;       // 内容宽度是否超出容器（不足时停止滚动）
        this._hasClones = false;          // 轨道内是否已包含克隆内容
        this._trackElement = null;        // 轨道 DOM 元素
        this._contentGroupWidth = 0;      // 一组完整内容的像素宽度
        this._originalItemCount = 0;      // 原始子元素数量（克隆前记录）
        this._originalHTML = '';          // 原始 HTML 快照（克隆模板）
        this._onResize = null;            // resize 事件回调引用（用于销毁时移除监听）
        this._onMouseEnter = null;        // mouseenter 事件回调引用
        this._onMouseLeave = null;        // mouseleave 事件回调引用

        // 方向映射表：方向 → [translate 坐标轴, 正负号前缀]
        this._directionMap = {
            left:  ['X', '-'],
            right: ['X', ''],
            up:    ['Y', '-'],
            down:  ['Y', ''],
        };

        this._init();
    }

    /**
     * 初始化：
     *   定位轨道 → 记录原始数据 → 解析方向 → 测量并决定是否克隆 → 绑定事件
     */
    SimpleRoller.prototype._init = function () {
        // ── 1. 定位轨道元素 ──
        var trackElement = this.opts.track
            ? this.container.querySelector(this.opts.track)
            : this.container.firstElementChild;

        if (!trackElement) {
            console.warn('[SimpleRoller] 未找到轨道元素');
            return;
        }

        this._trackElement = trackElement;

        // ── 2. 克隆前保存原始数据 ──
        this._originalItemCount = trackElement.children.length;
        this._originalHTML = trackElement.innerHTML;

        // ── 3. 解析方向 ──
        var dir = this._directionMap[this.opts.direction] || this._directionMap.left;
        this._translateAxis = dir[0];  // 'X' 或 'Y'
        this._signPrefix    = dir[1];  // '-' 或 ''

        // ── 4. 初始化滚动状态（先测量，再决定是否克隆） ──
        this._initScroll();

        // ── 5. 窗口缩放时重新检查滚动条件 ──
        this._onResize = this._onResizeHandler.bind(this);
        window.addEventListener('resize', this._onResize);

        // ── 6. 绑定悬停事件 ──
        if (this.opts.pauseOnHover) {
            this._onMouseEnter = this.stop.bind(this);
            this._onMouseLeave = this.play.bind(this);
            this.container.addEventListener('mouseenter', this._onMouseEnter);
            this.container.addEventListener('mouseleave', this._onMouseLeave);
        }

        // 就绪回调
        if (typeof this.opts.onReady === 'function') {
            this.opts.onReady.call(this);
        }
    };

    // ═══════════════════════════════════════════════════════════════════
    //  内部方法
    // ═══════════════════════════════════════════════════════════════════

    /**
     * 测量原始内容的总像素宽度
     *
     * 取前两个子元素的 getBoundingClientRect() 实测 itemWidth 和 gap，
     * 公式：contentGroupWidth = originalItemCount × (itemWidth + gap)
     *
     * @returns {number} 一组完整内容的像素宽度
     */
    SimpleRoller.prototype._measureContentWidth = function () {
        var items = this._trackElement.children;
        if (!items || items.length < 2) return 0;

        var itemWidth = items[0].getBoundingClientRect().width;
        var itemGap = items[1].getBoundingClientRect().left
                    - items[0].getBoundingClientRect().right;

        return this._originalItemCount * (itemWidth + itemGap);
    };

    /**
     * 初始化滚动：根据内容宽度决定是否克隆及启动
     *
     * 两种路径：
     *   A. 内容宽度 > 容器宽度 → 添加克隆，启动无限滚动
     *   B. 内容宽度 ≤ 容器宽度 → 不克隆，不启动（若配置 center 则居中）
     */
    SimpleRoller.prototype._initScroll = function () {
        this._contentGroupWidth = this._measureContentWidth();
        var containerWidth = this.container.clientWidth;
        this._isScrollable = this._contentGroupWidth > containerWidth;

        if (this._isScrollable) {
            this._addClones();
            // 克隆后重新测量以确保一致性
            this._contentGroupWidth = this._measureContentWidth();
            this.play();
        } else {
            this._removeClones();
            this._applyInsufficientPolicy();
        }
    };

    /**
     * resize 事件处理：
     *   重新测量内容宽度和容器宽度，当可滚动状态变化时动态
     *   添加 / 移除克隆，并在两种模式间切换
     */
    SimpleRoller.prototype._onResizeHandler = function () {
        this._contentGroupWidth = this._measureContentWidth();
        var containerWidth = this.container.clientWidth;
        var wasScrollable = this._isScrollable;
        this._isScrollable = this._contentGroupWidth > containerWidth;

        if (this._isScrollable && !wasScrollable) {
            // 从不足 → 可滚动：取消居中，添加克隆，启动
            this._removeInsufficientPolicy();
            this._addClones();
            this._contentGroupWidth = this._measureContentWidth();
            this._scrollOffset = 0;
            this.play();
        } else if (!this._isScrollable && wasScrollable) {
            // 从可滚动 → 不足：停止动画，移除克隆，应用内容不足策略
            this._stopAnimation();
            this._removeClones();
            this._scrollOffset = 0;
            this._trackElement.style.transform =
                'translate' + this._translateAxis + '(0px)';
            this._applyInsufficientPolicy();
        }
    };

    /**
     * 添加克隆内容到轨道末尾
     * 仅当尚未添加克隆时执行，重复调用无副作用
     */
    SimpleRoller.prototype._addClones = function () {
        if (this._hasClones) return;
        for (var i = 0; i < this.opts.clones; i++) {
            this._trackElement.insertAdjacentHTML('beforeend', this._originalHTML);
        }
        this._hasClones = true;
    };

    /**
     * 移除克隆内容，仅保留原始子元素
     * 仅当已添加克隆时执行，重复调用无副作用
     */
    SimpleRoller.prototype._removeClones = function () {
        if (!this._hasClones) return;
        var children = this._trackElement.children;
        // 从末尾开始删除，避免索引偏移
        while (children.length > this._originalItemCount) {
            this._trackElement.removeChild(children[children.length - 1]);
        }
        this._hasClones = false;
    };

    /**
     * 应用"内容不足"时的布局策略
     *
     * 'stop'  (默认)：不做额外处理，仅保持原始内容左对齐
     * 'center'       ：容器 flex + justify-content: center，
     *                  轨道 width: fit-content，实现居中显示
     */
    SimpleRoller.prototype._applyInsufficientPolicy = function () {
        if (this.opts.contentInsufficient === 'center') {
            this.container.style.display = 'flex';
            this.container.style.justifyContent = 'center';
            this._trackElement.style.width = 'fit-content';
        }
    };

    /**
     * 取消"内容不足"时的布局策略，恢复默认样式
     */
    SimpleRoller.prototype._removeInsufficientPolicy = function () {
        if (this.opts.contentInsufficient === 'center') {
            this.container.style.display = '';
            this.container.style.justifyContent = '';
            this._trackElement.style.width = '';
        }
    };

    /**
     * 停止动画循环
     */
    SimpleRoller.prototype._stopAnimation = function () {
        if (this._animationFrameId) {
            cancelAnimationFrame(this._animationFrameId);
            this._animationFrameId = null;
        }
    };

    /**
     * 每帧回调 — 驱动滚动的核心循环
     *
     * 流程：
     *   1. 检查内容宽度是否超出容器，不足时停止循环（等待 resize 恢复）
     *   2. 检查暂停 / 轨道无效状态，无效时只请求下一帧不做操作
     *   3. 根据窗口宽度匹配响应式断点，决定当前帧速度
     *   4. 累加滚动偏移量
     *   5. 偏移量 >= 一组完整内容宽度时归零（像素复位，视觉上无缝回环）
     *   6. 将偏移量写入轨道 transform 属性
     *   7. 请求下一帧
     */
    SimpleRoller.prototype._tick = function () {
        // 内容不足以滚动时，停止动画循环，不再请求下一帧
        if (!this._isScrollable) {
            this._stopAnimation();
            return;
        }

        // 暂停或轨道不存在时，仅请求下一帧不做操作
        if (this._isPaused || !this._trackElement) {
            this._animationFrameId = requestAnimationFrame(this._tick.bind(this));
            return;
        }

        // ── 响应式速度：按窗口宽度匹配断点 ──
        var responsiveSpeed = this.opts.speed;
        if (this.opts.responsive) {
            var windowWidth = window.innerWidth;
            var breakpoints = Object.keys(this.opts.responsive)
                .map(Number)
                .sort(function (a, b) { return a - b; });

            for (var i = 0; i < breakpoints.length; i++) {
                if (windowWidth <= breakpoints[i]) {
                    responsiveSpeed = this.opts.responsive[breakpoints[i]];
                    break;
                }
            }
        }

        // ── 累加偏移量 ──
        this._scrollOffset += responsiveSpeed;

        // ── 像素级无缝复位 ──
        if (this._scrollOffset >= this._contentGroupWidth) {
            this._scrollOffset = 0;
        }

        // ── 应用变换 ──
        this._trackElement.style.transform =
            'translate' + this._translateAxis +
            '(' + this._signPrefix + this._scrollOffset + 'px)';

        // ── 请求下一帧 ──
        this._animationFrameId = requestAnimationFrame(this._tick.bind(this));
    };

    // ═══════════════════════════════════════════════════════════════════
    //  公开方法
    // ═══════════════════════════════════════════════════════════════════

    /**
     * 开始 / 恢复滚动
     * 内容不足以滚动时，重置偏移不启动动画循环
     */
    SimpleRoller.prototype.play = function () {
        if (!this._isScrollable) {
            this._scrollOffset = 0;
            if (this._trackElement) {
                this._trackElement.style.transform =
                    'translate' + this._translateAxis + '(0px)';
            }
            return;
        }

        this._isPaused = false;
        if (!this._animationFrameId) {
            this._animationFrameId = requestAnimationFrame(this._tick.bind(this));
        }
    };

    /**
     * 暂停滚动（不会取消已请求的帧，下一帧 tick 会检测 _isPaused 并跳过）
     */
    SimpleRoller.prototype.stop = function () {
        this._isPaused = true;
    };

    /**
     * 销毁实例：停止动画、移除事件监听、清理引用
     */
    SimpleRoller.prototype.destroy = function () {
        // 停止动画
        this.stop();
        if (this._animationFrameId) {
            cancelAnimationFrame(this._animationFrameId);
            this._animationFrameId = null;
        }

        // 移除 resize 监听
        if (this._onResize) {
            window.removeEventListener('resize', this._onResize);
            this._onResize = null;
        }

        // 移除鼠标悬停监听
        if (this._onMouseEnter) {
            this.container.removeEventListener('mouseenter', this._onMouseEnter);
            this.container.removeEventListener('mouseleave', this._onMouseLeave);
            this._onMouseEnter = null;
            this._onMouseLeave = null;
        }

        // 恢复内容不足策略改写的样式
        this._removeInsufficientPolicy();

        // 清空引用，帮助 GC
        this._trackElement = null;
        this.container = null;
    };

    // 挂载到全局
    global.SimpleRoller = SimpleRoller;
})(typeof window !== 'undefined' ? window : this);
