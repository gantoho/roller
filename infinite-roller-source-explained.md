# InfiniteRoller 源码解析

> 逐段解读代码的设计思路、核心机制与实现细节

---

## 一、整体架构概览

InfiniteRoller 是一个**基于 class 的无限循环滚动引擎**，全文约 530 行。它的设计遵循一个清晰的 **初始化 → 测量 → 克隆 → 动画驱动** 流水线。

```
constructor(container, options)
    │
    ├─ 1. 合并配置 + 校验
    │
    ├─ 2. 初始化内部状态变量
    │
    ├─ 3. 绑定方法的 this 上下文
    │
    └─ 4. 调用 _init() 开始初始化
          │
          ├─ 4.1 获取容器直接子元素
          │
          ├─ 4.2 构建轨道 DOM
          │     └── display:flex + will-change:transform
          │
          ├─ 4.3 给子项设置间距 margin
          │     └── _applyMarginToItems()
          │
          ├─ 4.4 测量原始尺寸
          │     └── _updateOriginalSize()
          │
          ├─ 4.5 克隆副本
          │     └── _cloneToAchieveSeamless()
          │
          ├─ 4.6 测量容器 + 轨道尺寸
          │
          ├─ 4.7 偏移归零 + 首次渲染
          │
          ├─ 4.8 绑定悬停 + resize 事件
          │
          └─ 4.9 自动开始滚动
                └── play() → _animationLoop()
                               │
                               └── rAF 循环: 时间差 → 步长 → 偏移递增 → 取模映射 → transform
```

整个代码分为 **9 个功能模块**：

| 模块 | 作用 |
|------|------|
| 构造函数 & 配置合并 | 接收参数、合并默认值、校验、初始化状态 |
| 初始化 (\_init) | 构建 DOM、测量、克隆、绑事件、启动 |
| 间距管理 | 用独立 margin 替代 CSS gap |
| 尺寸测量 | 读取轨道/容器的宽高数据 |
| 克隆策略 | 判断是否需要停止 / 按倍数克隆 |
| 变换应用 | 将偏移量映射到 translate3d |
| 动画循环 | rAF 核心：时间差 → 步长 → 偏移 |
| 公共 API | play / pause / stop / refresh / destroy |
| 事件处理 | 悬停暂停恢复、resize 防抖 |

---

## 二、构造函数 — 配置合并与状态初始化

```js
constructor(container, options = {}) {
    // 校验容器有效性
    this.container = container;

    // 合并默认配置
    const defaults = { direction:'horizontal', gap:20, speed:50, ... };
    this.options = { ...defaults, ...options };

    // 校验 direction 和 contentInsufficient 合法性

    // 内部状态变量
    this.track = null;
    this.originalItems = [];
    this.originalSize = 0;
    this.scrollOffset = 0;
    this.isPlaying = false;
    this.destroyed = false;
    ...

    // 绑定 this 上下文
    this._animationLoop = this._animationLoop.bind(this);
    ...

    this._init();
}
```

> **设计思路：**
>
> 将所有内部状态集中在构造函数中声明，一目了然。使用展开运算符 `{ ...defaults, ...options }` 合并配置，用户传入的选项会覆盖默认值，未传入的使用默认值——这是一种 **「零配置可用」** 的设计哲学。
>
> 为什么要 `.bind(this)`？因为 `requestAnimationFrame` 的回调和事件监听中的 `this` 会丢失指向，提前绑定确保所有方法内的 `this` 都指向实例本身。

---

## 三、初始化 _init() — 核心流水线入口

```js
_init() {
    // 1. 提取直接子元素（忽略文本节点）
    const children = Array.from(this.container.children)
                         .filter(c => c.nodeType === 1);
    this.originalItems = [...children];

    // 2. 清空容器，创建轨道层
    this.container.innerHTML = '';
    this.container.style.overflow = 'hidden';
    this.track = document.createElement('div');
    this.track.style.display = 'flex';
    this.track.style.willChange = 'transform';    // 告诉浏览器提前优化
    this.track.style.backfaceVisibility = 'hidden'; // 触发 GPU 合成层

    // 3. 给原始项设置 margin 间距
    this._applyMarginToItems(this.originalItems);
    this.originalItems.forEach(item => this.track.appendChild(item));
    this.container.appendChild(this.track);

    // 4. 测量 → 克隆 → 更新尺寸
    this._updateOriginalSize();
    this._cloneToAchieveSeamless();
    this._updateContainerSize();
    this._updateTrackSize();

    // 5. 初始位置归零
    this.scrollOffset = 0;
    this._applyTransformFromOffset();

    // 6. 绑定事件 + 自动启动
    ...
}
```

> **设计思路：**
>
> `_init()` 是一条 **单向流水线**，步骤严格有序：先构建 DOM → 再测量 → 再克隆 → 最后启动动画。每个步骤依赖前一步的结果。
>
> 注意 `innerHTML = ''` 这一步：它会 **完全接管容器** 的内部结构。用户提供的子元素会被移入轨道，轨道本身成为容器的唯一子元素。这样轨道可以自由运动而不影响容器的布局。
>
> `will-change: transform` 和 `backfaceVisibility: hidden` 是 CSS 硬件加速的标准组合拳，告诉浏览器提前为 transform 变化分配 GPU 合成层。

---

## 四、间距管理 — 独立 margin 替代 CSS gap

```js
_applyMarginToItems(items) {
    const gap = this.options.gap;
    if (direction === 'horizontal') {
        items.forEach(item => {
            item.style.marginRight = `${gap}px`;   // 每个元素右侧留间距
            item.style.marginLeft = '0px';
            item.style.marginBottom = '';          // 清除垂直方向干扰
        });
    } else {
        items.forEach(item => {
            item.style.marginBottom = `${gap}px`;  // 每个元素底部留间距
            ...
        });
    }
}
```

> **设计思路——为什么不用 CSS `gap`？**
>
> 这是整个组件实现 **「完全无闪烁」** 的关键细节。
>
> 如果使用 `gap: 20px`，轨道结构为 `[A B C] [A' B' C'] [A'' B'' C'']`，每组 3 项。`gap` 是 flex 容器属性，作用于 **每组内相邻元素之间**。但在 **组与组的边界**（C 和 A' 之间），`gap` 同样会生效，间距恰好也是 20px——看起来似乎没问题？
>
> 但问题出在 **克隆时**：`cloneNode(true)` 会克隆元素的 style 属性，它 **不会克隆容器的 gap**。而 margin 是设置在 **每个元素自身** 上的，克隆时会 **自动继承**。所以用独立 margin，克隆后的组边界间距与组内间距 **完全一致**，永远不会有视觉突变。
>
> 一句话总结：**margin 在元素上，gap 在容器上。克隆元素不克隆容器，所以用 margin。**

---

## 五、尺寸测量 — 三组数据各自独立

```js
_updateOriginalSize() {
    // 测量原始内容总尺寸（不含克隆，只含原始项）
    this.originalSize = this.track.scrollWidth;  // 水平
    // 兜底：手动累加 offsetWidth + gap
}

_updateContainerSize() {
    // 测量容器可视区尺寸
    const rect = this.container.getBoundingClientRect();
    this.containerSize = rect.width;  // 或 height
}

_updateTrackSize() {
    // 测量轨道总尺寸（含所有克隆）
    this.totalTrackSize = this.track.scrollWidth;
}
```

> **设计思路：**
>
> 三个尺寸各有用途：
>
> - `originalSize` — 用来做 **取模映射** 的基准，即 `scrollOffset % originalSize`。这是循环周期的长度。
> - `containerSize` — 用来判断内容是否不足容器，决定是否启用 `contentInsufficient` 策略。
> - `totalTrackSize` — 用来确认克隆后的轨道确实足够长。
>
> 其中 `_updateOriginalSize` 有一个 **兜底逻辑**：当 `scrollWidth` 返回 0 时（某些浏览器或隐藏元素可能不准确），手动遍历子项累加 `offsetWidth + gap` 来保证数据可靠性。

---

## 六、克隆策略 — 核心中的核心

```js
_cloneToAchieveSeamless() {
    // 第一步：判断内容不足且策略为 stop → 清除克隆、停止滚动
    if (originalSize < containerSize && contentInsufficient === 'stop') {
        this._clearAllClones();
        this.isPlaying = false;
        return;
    }

    // 第二步：计算目标轨道总长度
    let targetTotalSize = originalSize * minCloneMultiplier;
    if (originalSize < containerSize) {  // scroll 模式
        targetTotalSize = originalSize + containerSize * 1.8;
    }

    // 第三步：计算需要克隆的份数，对比当前已有克隆数，差量增删
    if (currentClonedSets < targetCloneSets) {
        // 追加克隆
    } else if (currentClonedSets > targetCloneSets) {
        // 移除多余克隆
    }
}
```

> **设计思路：**
>
> 这是保证 **「无缝衔接」** 的另一个关键。
>
> **为什么至少需要 3 份？**
>
> 设想视口宽度 1000px，原始内容宽度 400px，克隆了 2 份（共 3 份，1200px）。偏移取模范围是 [0, 400)，当前偏移是 350px，视口看到的是第 2 份的 350~750px 范围和第 3 份的开头部分。偏移再走 50px 后取模回到 0，此时视口看到的又是第 2 份和第 3 份的衔接处——始终有内容。如果只有 2 份（800px），取模回绕时可能会出现视口超出轨道范围的情况。
>
> **差量增删**：组件不是每次 refresh 都全删重建克隆，而是比较当前克隆数与目标数，只增删差额部分。这避免了不必要的 DOM 操作，提升了性能。
>
> **contentInsufficient === 'scroll' 时**：如果内容只有 200px 而容器有 1000px，单纯克隆 3 倍（600px）仍然不够。此时会额外补充克隆直到 `originalSize + containerSize * 1.8`，确保轨道长度足够视口完整滚动。

---

## 七、变换应用 — 取模映射消除回绕

```js
_applyTransformFromOffset() {
    // 取模：将单调递增的偏移量映射到 [0, originalSize) 区间
    let effectiveOffset = this.scrollOffset % this.originalSize;
    if (effectiveOffset < 0) effectiveOffset += this.originalSize;

    // 应用 transform（负值 = 向左/向上移动）
    const translateValue = -effectiveOffset;
    this.track.style.transform = `translate3d(${translateValue}px, 0, 0)`;
}
```

> **设计思路：**
>
> 这是整个滚动方案的 **数学核心**。
>
> `scrollOffset` 是一个 **单调递增** 的值，它永远不会被重置为 0。每次渲染时，通过 `scrollOffset % originalSize` 把它映射到 [0, originalSize) 区间内。取模的结果作为实际的 `translate3d` 偏移值。
>
> 因为轨道中有 3 份完整的内容，当取模值从 399px 回到 0px 时，视口内看到的是 **后一份的结尾 + 下一份的开头**——内容完全重复，用户 **察觉不到任何回绕**。这就是「无缝」的真正含义。
>
> 如果只用 1 份内容，取模回绕时视口会从末尾直接跳到开头，产生明显的闪烁。多份克隆 + 取模映射，两者缺一不可。

---

## 八、动画循环 — 基于时间的精确驱动

```js
_animationLoop(now) {
    // 暂停检查
    if (!this.isPlaying || this.isHoverPaused) { this.animationId = null; return; }

    // 第一帧：初始化时间戳
    if (!this.lastTimestamp) { this.lastTimestamp = now; ... return; }

    // 计算时间差（上限 maxDeltaTime，防止切后台后跳跃）
    let delta = Math.min(this.options.maxDeltaTime, (now - this.lastTimestamp) / 1000);

    // 步长 = 速度 × 时间
    let step = this.options.speed * delta;
    if (step > this.originalSize * this.options.stepMaxRatio) {
        step = this.originalSize * this.options.stepMaxRatio;
    }

    // 偏移递增 + 精度保护
    this.scrollOffset += step;
    if (this.scrollOffset > precisionThreshold) {
        this.scrollOffset = this.scrollOffset % this.originalSize;
    }

    this._applyTransformFromOffset();
    this.lastTimestamp = now;
    this.animationId = requestAnimationFrame(this._animationLoop);
}
```

> **设计思路：**
>
> 动画驱动力来自 `requestAnimationFrame`，它的回调会传入一个高精度时间戳 `now`（单位毫秒）。
>
> **基于时间的动画 vs 基于帧的动画：**
>
> - **基于帧**：每帧移动固定像素（如 `scrollOffset += 2`）。缺点是帧率不稳定时速度会忽快忽慢，60fps 和 30fps 下速度差一倍。
> - **基于时间**：每帧移动 `speed × delta` 像素。帧率高时每帧移动量小，帧率低时每帧移动量大，**实际速度始终恒定**。
>
> **两个安全机制：**
>
> - `maxDeltaTime`（默认 0.05 秒）：用户切换到其他标签页后，回来时 `delta` 可能长达十几秒，步长会极大。限制后，回来时最多按 0.05 秒的步长计算，画面平滑跟上。
> - `stepMaxRatio`（默认 0.5）：单帧步长不超过原始尺寸的一半，防止任何极端情况下的跳跃。
> - `precisionThreshold`（默认 1e8）：`scrollOffset` 长期递增可能达到非常大的数值，JavaScript 的浮点数在大数时精度会下降。超过阈值时主动取模，把数值降下来。

---

## 九、公共 API — 对外接口

```js
play()    // 开始滚动：设置 isPlaying=true，启动 rAF 循环
pause()   // 暂停滚动：设置 isPlaying=false，取消 rAF
stop()    // 停止 + 重置位置到起点

refresh() // 刷新组件：重新捕获子元素 → 清除克隆 → 重测 → 重克隆 → 恢复
          // 适用于：窗口 resize、动态增删内容后调用

destroy() // 销毁组件：断开所有监听、还原 DOM、释放内存
          // 适用于：SPA 页面卸载时调用，防止内存泄漏
```

> **设计思路：**
>
> API 设计遵循 **直观命名** 原则，每个方法只做一件事：
>
> - `play()` 在启动前会检查 `contentInsufficient === 'stop'` 条件，如果是 stop 模式且内容不足，则 **静默拒绝**，不会报错也不会启动。
> - `pause()` 只暂停，位置不动。调用 `play()` 可以从暂停处继续。
> - `stop()` = `pause()` + 位置归零。
> - `refresh()` 会保留当前播放状态（恢复后继续播放），并且会过滤掉已被外部 DOM 移除的原始项，**健壮性较好**。
> - `destroy()` 会清除所有 side effect（事件监听、ResizeObserver），并将原始项从轨道中移出、清除 margin 样式，**还原容器到调用前的状态**。

---

## 十、事件处理 — 悬停与自适应

```js
_handleHoverEnter() {
    // 设置 isHoverPaused=true，_animationLoop 中检测到后会停止 rAF
}

_handleHoverLeave() {
    // 设置 isHoverPaused=false，重启 rAF
}

_handleResize() {
    // 防抖：100ms 内多次 resize 只触发一次 refresh
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.refresh(), this.options.resizeDebounceMs);
}
```

> **设计思路：**
>
> **悬停暂停**：使用一个独立的 `isHoverPaused` 标志位，而不是直接修改 `isPlaying`。这样悬停暂定和手动暂停互不干扰——用户手动暂停后鼠标移入移出不会意外重启动画。
>
> **尺寸自适应**：同时使用了 `ResizeObserver`（监听容器尺寸变化）和 `window resize` 事件（兼容某些 ResizeObserver 无法捕捉的场景）。两个触发源共享同一个防抖定时器，避免重复执行。

---

## 十一、总结：核心机制一句话

> **InfiniteRoller = 多份 DOM 克隆 + 单调递增偏移 + 取模映射 translate3d + 独立 margin**
>
> 这四项技术配合，实现了 **完全无缝、无闪烁、无跳跃** 的无限循环滚动效果。
>
> - **多份克隆** — 保证取模回绕时视口始终有内容
> - **单调递增偏移** — 永不重置，消除回绕跳跃
> - **取模映射** — 将无限增长的偏移映射到有限区间
> - **独立 margin** — 克隆时自动继承间距，边界无突变
> - **rAF + translate3d** — GPU 硬件加速，高性能动画

---

> 源码文件：[infinite-roller.js](infinite-roller.js) | 使用文档：[infinite-roller-guide.html](infinite-roller-guide.html)