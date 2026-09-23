// 图表资源回收（纯 node，零依赖，本地可跑）：
// 预览重渲染是整块替换 innerHTML，旧容器随之脱离文档 —— 若不回收，ECharts 实例 /
// ResizeObserver / 引擎内部引用会一直持有它们，长会话内存只增不减。
// 用户报障原话：「偶尔会莫名的卡顿，需要重启才能变得正常」。
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/modules/diagram-renderers.js');

// 极简假容器：只提供 renderTikz / renderInto / dispose 实际会用到的那几个成员，
// 这样不必装 jsdom 也能验证回收逻辑。
function fakeContainer() {
  return {
    innerHTML: '',
    style: {},
    classList: { remove() {}, add() {} },
    querySelector(sel) {
      return (sel === 'svg' && String(this.innerHTML).indexOf('<svg') !== -1) ? {} : null;
    },
  };
}

// 注册表是模块级状态、跨用例共享：每个用例开头先清空（把"什么都没有"的 root 传进去，
// 等于把所有已登记容器都视为脱离 → 全部回收），使断言与执行顺序无关。
function drain() {
  return R.disposeDetachedDiagrams({ querySelectorAll: () => [] });
}

const TEX = '\\draw (0,0) -- (2,1);';

test('renderInto 成功后登记容器；disposeDetachedDiagrams 只回收已脱离 DOM 的', async () => {
  drain();
  const live = fakeContainer();
  const stale = fakeContainer();
  const observer = { disconnected: false, disconnect() { this.disconnected = true; } };
  stale._tizuResizeObserver = observer;

  // TikZ 是本项目自研引擎（无 vendor 依赖），用它当"真实渲染"的载体
  assert.equal(await R.renderInto(live, 'tikz', TEX, {}), true, 'TikZ 应渲染成功');
  assert.equal(await R.renderInto(stale, 'tikz', TEX, {}), true, 'TikZ 应渲染成功');
  assert.ok(live.innerHTML.indexOf('<svg') !== -1, '渲染后容器内应有 SVG');

  // 只有 live 仍在预览里 → stale 应被回收
  const preview = { querySelectorAll: () => [live] };
  assert.equal(R.disposeDetachedDiagrams(preview), 1, '应回收 1 个（stale）');
  assert.equal(stale.innerHTML, '', '已脱离容器的内容应被清空（断开引擎引用 → 可被 GC）');
  assert.equal(observer.disconnected, true, 'ResizeObserver 必须 disconnect');
  assert.equal(stale._tizuResizeObserver, null, '句柄应清空');
  assert.ok(live.innerHTML.indexOf('<svg') !== -1, '仍在 DOM 中的容器不得被清（避免白重建）');

  // 幂等：同一批容器不会被重复回收
  assert.equal(R.disposeDetachedDiagrams(preview), 0, '第二次应无可回收');
});

test('disposeDetachedDiagrams: 全部脱离时全部回收；异常输入不抛错', async () => {
  drain();
  const a = fakeContainer();
  const b = fakeContainer();
  await R.renderInto(a, 'tikz', TEX, {});
  await R.renderInto(b, 'tikz', TEX, {});
  assert.equal(R.disposeDetachedDiagrams({ querySelectorAll: () => [] }), 2, '两个都应被回收');
  assert.equal(a.innerHTML, '', 'a 应清空');
  assert.equal(b.innerHTML, '', 'b 应清空');
  // 无 liveRoot / 非法 liveRoot 不得抛错（预览异常时也要能安全调用）
  assert.equal(R.disposeDetachedDiagrams(null), 0);
  assert.equal(R.disposeDetachedDiagrams(undefined), 0);
  assert.equal(R.disposeDetachedDiagrams({}), 0);
});

test('renderInto 失败不登记（失败容器无需回收）', async () => {
  drain();
  const bad = fakeContainer();
  // 语法超出子集 → tikzToSvg 返回 null → renderInto 返回 false，不应进注册表
  assert.equal(await R.renderInto(bad, 'tikz', '\\boguscommand', {}), false);
  assert.equal(drain(), 0, '失败容器不应被登记');
});
