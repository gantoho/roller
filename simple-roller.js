/**
 * SimpleRoller — 轻量 rAF 无限滚动
 *
 * 从手写 demo 中抽离，无依赖，纯 rAF 驱动。
 *
 * 用法：
 *   new SimpleRoller('#container', {
 *       track: '.scroll-box',        // 轨道选择器（容器直接子元素）
 *       speed: 1.1,                  // 每帧移动 px
 *       direction: 'left',           // left | right | up | down
 *       pauseOnHover: true,
 *       clones: 2,                   // 轨道整体克隆次数
 *       responsive: { 430: 0.55 },   // { breakpoint: speed, … }
 *   });
 */
(function (global) {
    'use strict';

    function SimpleRoller(container, options) {
        if (!container) throw new Error('[SimpleRoller] 缺少 container 参数');

        this.container = typeof container === 'string'
            ? document.querySelector(container)
            : container;

        if (!this.container) throw new Error('[SimpleRoller] 未找到容器元素');

        this.opts = Object.assign({
            track: null,
            speed: 1.1,
            direction: 'left',
            pauseOnHover: true,
            clones: 2,
            responsive: null,
            onReady: null,
        }, options);

        this._x = 0;
        this._rafId = null;
        this._paused = false;
        this._allTracks = null;

        this._init();
    }

    SimpleRoller.prototype._init = function () {
        // 定位原始轨道
        var track = this.opts.track
            ? this.container.querySelector(this.opts.track)
            : this.container.firstElementChild;

        if (!track) {
            console.warn('[SimpleRoller] 未找到轨道元素');
            return;
        }

        // 克隆整个轨道元素（将其作为兄弟节点插入容器）
        for (var i = 0; i < this.opts.clones; i++) {
            var clone = track.cloneNode(true);
            this.container.appendChild(clone);
        }

        // 用选择器选中所有轨道（原始 + 克隆）
        if (this.opts.track) {
            this._allTracks = this.container.querySelectorAll(this.opts.track);
        } else {
            this._allTracks = this.container.children;
        }

        // 方向映射
        var dirMap = { left: ['X', '-'], right: ['X', ''], up: ['Y', '-'], down: ['Y', ''] };
        var d = dirMap[this.opts.direction] || dirMap.left;
        this._axis = d[0];
        this._neg  = d[1];

        // 监听悬停
        if (this.opts.pauseOnHover) {
            this._onEnter = this.stop.bind(this);
            this._onLeave = this.play.bind(this);
            this.container.addEventListener('mouseenter', this._onEnter);
            this.container.addEventListener('mouseleave', this._onLeave);
        }

        // 启动
        this.play();

        if (typeof this.opts.onReady === 'function') {
            this.opts.onReady.call(this);
        }
    };

    SimpleRoller.prototype._tick = function () {
        if (this._paused || !this._allTracks || this._allTracks.length === 0) {
            this._rafId = requestAnimationFrame(this._tick.bind(this));
            return;
        }

        // 判断复位：第二个轨道（首个克隆）是否已滑出容器左/上边缘
        var second = this._allTracks[1];
        if (second) {
            var rect = second.getBoundingClientRect();
            var containerRect = this.container.getBoundingClientRect();
            var edge = this._axis === 'Y' ? rect.top : rect.left;
            var bound = this._axis === 'Y' ? containerRect.top : containerRect.left;
            if (edge <= bound) this._x = 0;
        }

        // 按窗口尺寸调整速度
        var speed = this.opts.speed;
        if (this.opts.responsive) {
            var ww = window.innerWidth;
            var bps = Object.keys(this.opts.responsive).map(Number).sort(function (a, b) { return a - b; });
            for (var j = 0; j < bps.length; j++) {
                if (ww <= bps[j]) { speed = this.opts.responsive[bps[j]]; break; }
            }
        }

        this._x += speed;
        var transform = 'translate' + this._axis + '(' + this._neg + this._x + 'px)';

        // 应用到所有轨道（保持同步移动）
        for (var k = 0; k < this._allTracks.length; k++) {
            this._allTracks[k].style.transform = transform;
        }

        this._rafId = requestAnimationFrame(this._tick.bind(this));
    };

    SimpleRoller.prototype.play = function () {
        this._paused = false;
        if (!this._rafId) {
            this._rafId = requestAnimationFrame(this._tick.bind(this));
        }
    };

    SimpleRoller.prototype.stop = function () {
        this._paused = true;
    };

    SimpleRoller.prototype.destroy = function () {
        this.stop();
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this._onEnter) {
            this.container.removeEventListener('mouseenter', this._onEnter);
            this.container.removeEventListener('mouseleave', this._onLeave);
        }
        this._allTracks = null;
        this.container = null;
    };

    global.SimpleRoller = SimpleRoller;
})(typeof window !== 'undefined' ? window : this);