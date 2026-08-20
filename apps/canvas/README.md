# apps/canvas —— 渲染器第一版

伪 3D 球体渲染。**只依赖 `@nodeflow/scene` 的输出形状,不 import 任何后端包**
（RENDERING.md §8）。

```bash
npx serve -l 5178 apps/canvas
```

- `index.html` + `render.js` —— 从 `scene.sample.json` 取数
- `standalone.html` —— 场景内联的自包含版，双击就能看

## 换一份数据

```bash
npx tsx packages/state/fixture-gen.mts > snap.json   # 跑一个 run，导出快照
```

再把快照喂给 `buildScene()`，输出写进 `scene.sample.json`。

## 这一版做了什么、没做什么

做了 **球面着色 / 半透明容器 / 景深** 三层。**视差留给动效轮** —— 它要交互
才看得出来。布局是最朴素的环形嵌套：场景里没有 position，位置本来就是渲染器
自己的事，物理与生长树是后面两个渲染器的事。
