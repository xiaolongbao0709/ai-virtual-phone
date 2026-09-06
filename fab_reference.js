/**
 * =========================================================================
 * 悬浮球组件独立参考代码 (Floating Action Button Reference Implementation)
 * 提取自：英语消息词典 V84
 * 英文术语：Reference（参考 / 参考实现）
 * 
 * 核心特性：
 * 1. 拟物毛玻璃材质 (Glassmorphism): 24px 背景高斯模糊 + 饱和度提升 + 微光内阴影
 * 2. 自动吸附与半隐藏 (Edge Snapping & Half-Hidden): 离手时自动吸附至屏幕左/右边缘，并露出 29px（缩进 15px）
 * 3. 贴边自适应半透明 (Auto Dimming): 停靠边缘时透明度自动降至 0.55，不遮挡页面视线
 * 4. 严谨的手势防误触 (Pointer Drag & Click Discrimination): 
 *    - 移动 > 10px 判定为拖拽（跟随手指，零延迟过渡）；
 *    - 移动 <= 10px 判定为点击（弹出主界面）；
 * 5. 全局物理状态锁 (State Lock): 记录位置与停靠状态，界面刷新时不重置位置。
 * =========================================================================
 */

// ==========================================
// 一、悬浮球样式 (CSS Styles)
// ==========================================
export const FAB_STYLES = `
  /* 悬浮球基础样式（毛玻璃质感） */
  .fdict-fab-glass {
    position: fixed;
    z-index: 9990;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    margin: 0;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.65);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.9);
    box-shadow: 0 8px 24px rgba(31, 38, 135, 0.1), inset 0 0 0 1px rgba(255, 255, 255, 0.6);
    color: #475569;
    cursor: pointer;
    touch-action: none;
    user-select: none;
  }

  /* 悬浮球内图标 */
  .fdict-fab-glass svg {
    width: 24px;
    height: 24px;
    stroke-width: 1.8;
  }

  /* 贴边半隐藏状态（降低不透明度，减淡底色） */
  .fdict-fab-glass.is-snapped {
    opacity: 0.55;
    background: rgba(255, 255, 255, 0.45);
  }

  /* 点击按压动效 */
  .fdict-fab-glass:active {
    transform: scale(0.92);
  }

  /* 暗色模式适配 (Dark Mode) */
  @media (prefers-color-scheme: dark) {
    .fdict-fab-glass {
      background: rgba(30, 41, 59, 0.65);
      color: #cbd5e1;
      border: 1px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3), inset 0 0 0 1px rgba(255, 255, 255, 0.05);
    }
    .fdict-fab-glass.is-snapped {
      opacity: 0.55;
      background: rgba(15, 23, 42, 0.5);
    }
  }
`;

// ==========================================
// 二、悬浮球核心控制器 (FAB Controller)
// ==========================================

/**
 * 悬浮球全局物理状态锁（防止宿主界面重新渲染或刷新插槽时位置被重置）
 */
export const fabState = {
  left: -1,
  top: -1,
  snapped: true
};

/**
 * 创建并初始化悬浮球
 * @param {Object} options 配置项
 * @param {Function} options.onClick 点击悬浮球时的回调函数（例如打开词典窗口）
 * @param {HTMLElement} [options.container=document.body] 挂载容器，默认是 document.body
 * @param {boolean} [options.enabled=true] 是否默认显示
 * @returns {Function} 销毁函数 (cleanup)
 */
export function initFloatingBall(options = {}) {
  const {
    onClick = () => console.log("FAB Clicked!"),
    container = document.body,
    enabled = true
  } = options;

  // 1. 若已有旧实例，先清理
  const existing = document.getElementById("fdict-global-fab");
  if (existing) existing.remove();

  // 2. 注入样式（若页面尚未注入）
  if (!document.getElementById("fdict-fab-styles")) {
    const styleEl = document.createElement("style");
    styleEl.id = "fdict-fab-styles";
    styleEl.textContent = FAB_STYLES;
    document.head.appendChild(styleEl);
  }

  // 3. 构建 DOM 元素
  const fab = document.createElement("button");
  fab.id = "fdict-global-fab";
  fab.className = "fdict-fab-glass";
  fab.style.display = enabled ? "flex" : "none";
  fab.setAttribute("aria-label", "快捷查词悬浮球");

  // 词典小书本 + 放大镜 SVG 图标
  fab.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
      <path d="M10 9a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"></path>
      <path d="m13 12 2 2"></path>
    </svg>
  `;

  // 4. 尺寸与初次布局计算
  const fabSize = 44;       // 悬浮球宽高 44px
  const hideOffset = 15;    // 停靠时嵌入屏幕边缘的隐藏量 (15px)
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;

  // 若从未初始化过位置，默认吸附在右下侧（高度 70% 处）
  if (fabState.left === -1) {
    fabState.left = vw - (fabSize - hideOffset);
    fabState.top = vh * 0.7;
  }

  fab.style.left = fabState.left + "px";
  fab.style.top = fabState.top + "px";
  if (fabState.snapped) {
    fab.classList.add("is-snapped");
  }

  // 5. 拖拽交互状态机
  let isDragging = false;
  let hasMoved = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  // 自动贴边计算函数
  const snapToEdge = () => {
    fab.classList.add("is-snapped");
    fabState.snapped = true;
    const currentVw = document.documentElement.clientWidth || window.innerWidth;
    const centerX = fabState.left + fabSize / 2;

    // 靠左贴边还是靠右贴边
    if (centerX < currentVw / 2) {
      fabState.left = -hideOffset;
    } else {
      fabState.left = currentVw - (fabSize - hideOffset);
    }
    fab.style.left = fabState.left + "px";
  };

  // ==========================================
  // 三、手势监听 (Pointer Events: 统一鼠标与触摸)
  // ==========================================

  // 按下：记录初始坐标，启用捕获
  fab.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();

    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = fabState.left;
    startTop = fabState.top;

    // 拖拽过程中必须移除 CSS transition，否则跟手会有明显的延迟粘滞感
    fab.style.transition = "none";
    fab.setPointerCapture(e.pointerId);
  });

  // 移动：判定是否触发拖拽位移阈值 (10px)
  fab.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // 只有绝对移动距离超过 10px，才认定用户是“想拖拽”而不是“轻微手抖的点按”
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      hasMoved = true;
      fab.classList.remove("is-snapped"); // 离边移动时立刻恢复 100% 不透明度
      fabState.snapped = false;
    }

    if (hasMoved) {
      const currentVh = document.documentElement.clientHeight || window.innerHeight;
      fabState.left = startLeft + dx;
      // 限制垂直方向不超出可视区域顶部与底部
      fabState.top = Math.max(0, Math.min(currentVh - fabSize, startTop + dy));
      fab.style.left = fabState.left + "px";
      fab.style.top = fabState.top + "px";
    }
  });

  // 抬起：释放捕获，平滑回弹贴边，或触发点击
  fab.addEventListener("pointerup", (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (!isDragging) return;
    isDragging = false;
    fab.releasePointerCapture(e.pointerId);

    // 抬起后赋予极佳阻尼感的贝塞尔过渡曲线，实现丝滑回弹入位
    fab.style.transition = "left 0.3s cubic-bezier(0.25, 0.8, 0.25, 1), top 0.3s ease, opacity 0.3s ease, transform 0.2s ease, background 0.3s ease";

    // 执行贴边吸附
    snapToEdge();

    // 如果手指没有真正拖动（位移 <= 10px），判定为有效点击！
    if (!hasMoved) {
      setTimeout(() => {
        onClick();
      }, 50);
    }
  });

  // 阻止浏览器的原生合成 click 事件冒泡
  fab.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  // 挂载到容器中
  container.appendChild(fab);

  // 返回卸载清理方法
  return function destroy() {
    if (container.contains(fab)) {
      container.removeChild(fab);
    }
  };
}
