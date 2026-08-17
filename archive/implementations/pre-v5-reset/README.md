# Pre-V5-reset implementation snapshot

这是 2026-08-17 V5 重建前的可运行实现快照，保留原始源码、测试与工作区布局。

## Python oracle

```powershell
python -m pytest -q
```

归档前结果：`321 passed, 18 skipped, 20 subtests passed`。

## TypeScript prototype

```powershell
pnpm install
pnpm -r test
```

归档前并非绿基线：contracts 6/6 通过；kernel 3/5 通过。不要把该原型描述成已经实现 `FOUNDATION_V5.md`。

真实模型配置仍只允许通过环境变量或未跟踪的本地配置提供。归档中仅保留 `config/llm.example.json`。

