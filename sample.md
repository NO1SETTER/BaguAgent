# Sample Benchmark

本次测试针对当前版本的 BaguAgent 试卷生成链路做了一个小样本基准。

## 测试条件

- Topic: `python`
- Mode: `normal`
- 分别生成 `10 / 30 / 50` 题
- 统计口径：
  - 生成时间：`POST /api/papers` 到任务状态 `completed` 的实际墙钟时间
  - token 估算：
    - 输入 token ≈ `完整 prompt 字符数 / 4`
    - 输出 token ≈ `生成出的 paper JSON 字符数 / 4`

## 结果

| 题量 | 实际生成时间 | 输入 token 估算 | 输出 token 估算 | 总 token 估算 |
|---|---:|---:|---:|---:|
| 10 题 | 63.1s | 1665 | 2426 | 4091 |
| 30 题 | 108.2s | 1665 | 5430 | 7095 |
| 50 题 | 282.5s | 1665 | 9096 | 10761 |

## 原始体积数据

- 输入 prompt 字符数三次基本一致：`6658 chars`
- 输出 JSON 字符数：
  - 10 题：`9701 chars`
  - 30 题：`21719 chars`
  - 50 题：`36384 chars`

## 对应试卷

- `python_normal_2026_04_22_01`
- `python_normal_2026-04-22_30`
- `python_normal_50_2026-04-22`

## 结论

1. 当前生成耗时的主要来源不是输入 prompt，而是输出规模。
2. `10 -> 30` 的增长相对平滑，`30 -> 50` 开始明显变陡。
3. 输入 token 基本固定，增长主要来自输出 JSON 体积。

## 后续优化方向

- 缩短单题字段，尤其是 `expected_points`
- 50 题拆成两段生成后再合并
- 在 `followup / mixed` 模式下减少重复字段
