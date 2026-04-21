# BaguAgent Architecture

本文档说明 BaguAgent 的整体架构，重点回答三个问题：

1. 系统由哪些模块组成
2. 一次完整练习是怎么流转的
3. AgentMemory 为什么会真正影响下一轮出题

---

## 1. 系统目标

BaguAgent 不是一个“知识展示站”，而是一个本地运行的面试练习系统。

它的目标是把下面这条链路做完整：

1. 从本地知识库读取内容
2. 基于 Topic 和历史表现生成试卷
3. 让用户用语音或文本作答
4. 对整张试卷评分
5. 抽取错误模式并更新记忆
6. 让下一张卷子更贴近真实薄弱点

所以它本质上是一个：

- 本地 Web 应用
- 带轻量 RAG 的出题系统
- 带串行任务队列的模型调用系统
- 带训练闭环的 AgentMemory 系统

---

## 2. 高层架构

```text
+--------------------+         +----------------------+
|     Frontend UI    | <-----> |   Node HTTP Server   |
| HTML/CSS/JS        |   API   |   server.js          |
+--------------------+         +----------+-----------+
                                           |
                                           |
                      +--------------------+--------------------+
                      |                    |                    |
                      v                    v                    v
             +----------------+   +----------------+   +------------------+
             | Knowledge Base |   |  Task Queue    |   |  Runtime Storage |
             | 八股/ 笔记/     |   | FIFO Codex Jobs|   | data/*.json/.md  |
             +--------+-------+   +--------+-------+   +---------+--------+
                      |                    |                       |
                      v                    v                       v
             +----------------+   +----------------+   +------------------+
             | Lightweight RAG|   |  Codex / GPT-5.2 | | AgentMemory Files |
             | chunks + rank  |   | generate / grade | | events/state/summary |
             +----------------+   +----------------+   +------------------+
```

可以把系统拆成 6 个核心模块：

- 前端交互层
- 后端 API 层
- 知识库层
- RAG 检索层
- Agent 执行层
- AgentMemory 层

---

## 3. 模块划分

### 3.1 前端交互层

位置：

- `interview-trainer/public/index.html`
- `interview-trainer/public/app.js`
- `interview-trainer/public/styles.css`

职责：

- 展示 Topic 列表
- 创建试卷生成任务
- 录入语音和文本答案
- 展示任务列表、进度条、预估耗时
- 提交评分
- 展示反馈和 Memory 摘要

前端不做语义理解，只负责：

- 用户输入
- 状态展示
- API 调用

---

### 3.2 后端 API 层

位置：

- `interview-trainer/server.js`

职责：

- 扫描知识库
- 手动解析 Topic
- 构建和读取 RAG 索引
- 生成试卷
- 保存答案
- 评分
- 生成反馈
- 更新 Memory
- 管理任务队列
- 生成新的八股文档

后端是整个系统的编排中心。

---

### 3.3 知识库层

目录：

- `八股/`
- `笔记/`

规则：

- `八股/`：可读可写，既是主知识库，也是可写回的知识沉淀区
- `笔记/`：只读，只参与检索和评分参考，不允许被应用修改

知识库的职责不是直接“拿来展示”，而是给 RAG 和出题链路提供上下文。

---

### 3.4 RAG 检索层

运行数据位置：

- `interview-trainer/data/rag/chunks.json`
- `interview-trainer/data/rag/topic_index.json`
- `interview-trainer/data/rag/question_bank.json`

职责：

- 将知识库切分为可检索 chunk
- 根据 Topic、关键词和 Memory 信号给 chunk 打分
- 选择少量高价值上下文送进模型

RAG 的目标不是通用问答，而是服务“训练型出题”。

---

### 3.5 Agent 执行层

这里的 Agent 不是多智能体系统，而是一个单 Agent 练习流程。

它会执行：

1. 读取上下文
2. 生成试卷
3. 接收答案
4. 评分
5. 生成反馈
6. 更新记忆

模型调用统一由 `codex exec --model gpt-5.2` 完成。

---

### 3.6 AgentMemory 层

运行数据位置：

- `interview-trainer/data/memory/memory_events.jsonl`
- `interview-trainer/data/memory/concept_memory.json`
- `interview-trainer/data/memory/skill_memory.json`
- `interview-trainer/data/memory/profile_memory.json`
- `interview-trainer/data/memory/memory_summary.json`

职责：

- 记录练习历史
- 判断哪些知识点现在应该优先复习
- 区分“不会”和“会但不稳定”
- 把训练结果重新喂回出题链路

这部分是 BaguAgent 最核心的闭环能力。

---

## 4. 关键数据流

### 4.1 Topic 解析流

```text
八股/ + 笔记/
   -> 手动触发 Topic 解析任务
   -> Codex 归纳 Topic
   -> 写入 topics.json
   -> 前端显示可选 Topic
```

特点：

- 低频任务
- 手动触发
- 目的在于降低模型开销

---

### 4.2 试卷生成流

```text
用户选择 Topic / 题量 / 模式
   -> 后端读取 Topic 权重 + Memory 摘要
   -> RAG 检索高相关 chunks
   -> 组装少量 summary + excerpt
   -> 进入 FIFO 任务队列
   -> Codex 生成自然语言试卷
   -> 本地结构校正 / 风格校正
   -> 试卷落盘
   -> 前端展示
```

这里有两个重要限制：

- 只传少量高相关摘要，不把全库喂给模型
- 生成任务和评分任务串行执行，避免本地资源打架

---

### 4.3 作答流

```text
前端展示试卷
   -> 用户语音输入 / 文本输入
   -> 前端逐题保存
   -> 后端只保存答案，不更新 Memory
```

Memory 在这个阶段不会更新。

这条规则很重要，因为系统只接受“完整练习结果”进入记忆。

---

### 4.4 评分与反馈流

```text
用户提交评分
   -> 后端检查整张试卷是否答完
   -> 进入 FIFO 评分任务
   -> Codex 输出结构化评分结果
   -> 本地分数校准 / fallback
   -> 生成反馈 Markdown
   -> 更新 Memory
```

评分结果至少会产出：

- `score`
- `level`
- `covered_points`
- `missed_points`
- `incorrect_points`
- `feedback`
- `better_answer`

---

### 4.5 Memory 更新流

```text
完整评分结果
   -> 追加 memory_events.jsonl
   -> 同步规则更新 concept_memory.json
   -> 同步规则更新 skill_memory.json
   -> 刷新 memory_summary.json
   -> 异步任务 extract_memory_insights
   -> 写入 profile_memory.json
```

这一步之后，下一次出题就会读到新的 Memory 视图。

---

## 5. 闭环：一张卷子如何影响下一张卷子

这是整个项目最关键的一条主线。

```text
生成试卷
   -> 用户作答
   -> 完整评分
   -> 反馈落盘
   -> Memory 更新
   -> Memory 摘要 + 弱项信号进入下一次 RAG 检索
   -> 下一张试卷更偏向薄弱点
```

这意味着系统并不是“每次独立随机抽题”，而是：

- 你答错什么
- 你答得不稳什么
- 你在哪一类追问容易断掉

这些信息都会逐步重新进入出题过程。

---

## 6. RAG 详细架构

## 6.1 为什么需要 RAG

问题很现实：

- 知识库会越来越大
- 每次生成试卷不可能把所有文档都塞进模型
- 这样既慢，又贵，而且噪声大

所以系统采用轻量 RAG。

RAG 解决两个问题：

1. 限制 token 开销
2. 让真正相关的知识片段进入 prompt

---

## 6.2 索引构建

知识库扫描时会做这些事：

1. 读取 `八股/` 和 `笔记/`
2. 按 Markdown 标题切 section
3. 将 section 进一步切成 chunk
4. 为每个 chunk 生成：
   - `topic_ids`
   - `keywords`
   - `summary`
   - `content`
   - 来源元数据

为什么不用外部向量库：

- demo 项目要尽量本地可运行
- 规则检索更容易解释和调试
- 当前需求更偏“训练调度”，不是开放域语义问答

---

## 6.3 检索排序

chunk 打分时，不只看 Topic，还会混合以下信号：

- 用户当前选择的 Topic
- Topic 权重（普通 / 重点 / 弱项优先）
- 关键词命中
- 来源类型（`八股` 与 `笔记`）
- 弱 Topic 信号
- 弱 Concept 信号
- 弱 Skill 信号
- 恢复观察信号

也就是说，检索不只是“找相关内容”，而是“找最适合当前训练目标的内容”。

---

## 6.4 为什么只传 `summary + excerpt`

当前送进模型的不是 chunk 全文，而是：

- `summary`
- `excerpt`

其中 `excerpt` 会从原文中抽出最相关的 1-2 段关键句。

这样做的原因：

- 控制 token
- 提升生成速度
- 减少无关长文本对问题风格的污染

这个选择直接影响系统的实用性。没有这一步，出题链路会明显更慢。

---

## 7. AgentMemory 详细架构

## 7.1 设计原则

当前 Memory 设计遵循 4 条原则：

1. 只在完整试卷评分后更新
2. 规则负责状态演算，模型负责高层抽取
3. 详细记忆落本地文件，小摘要按需召回
4. Memory 必须参与下一轮出题，而不是只做展示

这使它更像一个训练闭环系统，而不是一个历史记录面板。

---

## 7.2 Memory 分层

### Event Layer

文件：

- `memory_events.jsonl`

用途：

- 记录每次练习的原始事件
- 只追加，不覆盖
- 便于追溯和重算

典型事件包括：

- `concept_correct`
- `concept_partial`
- `concept_wrong`
- `followup_breakdown`

---

### Concept Layer

文件：

- `concept_memory.json`

用途：

- 维护知识点级别的长期状态

核心字段包括：

- `concept_id`
- `topic_id`
- `canonical_name`
- `mastery_score`
- `stability_score`
- `difficulty_score`
- `forget_risk`
- `failure_streak`
- `recovery_streak`
- `last_error_types`
- `linked_chunks`
- `pool`

这层回答的问题是：

- 你现在最该补的是哪个知识点
- 这个知识点属于错题修复，还是恢复观察

---

### Skill Layer

文件：

- `skill_memory.json`

用途：

- 记录答题能力，而不是知识点本身

当前固定维度包括：

- `definition`
- `mechanism`
- `comparison`
- `boundary_conditions`
- `followup_resilience`

这层回答的问题是：

- 你是不懂这个点
- 还是懂，但总在某种提问方式下答得不稳

---

### Profile Layer

文件：

- `profile_memory.json`

用途：

- 存长期、稳定的错误模式和表达画像

这层不参与每次同步状态推进，而是由异步模型抽取来补充。

例如：

- 容易答定义但答不清机制
- 一到追问就开始泛化
- 表达容易跳结论，缺少关键前提

---

### Summary Layer

文件：

- `memory_summary.json`

用途：

- 只保留 prompt 需要的高价值摘要

例如：

- `weak_topics`
- `weak_concepts`
- `weak_skills`
- `recovery_watchlist`
- `profile_summary`

这层是 Claude Code 式“按需召回”的关键：  
把真正需要给模型看的东西压缩到一个小视图里，而不是把全部历史硬塞进 prompt。

---

## 7.3 同步更新

评分完成后，会先做一轮同步更新：

1. 写反馈文件
2. 追加 event
3. 更新 concept 状态
4. 更新 skill 状态
5. 刷新 summary

同步阶段不依赖模型，原因很明确：

- 评分主流程不能因为额外抽取而卡住
- 核心状态演算应该可预测、可解释

---

## 7.4 异步更新

同步阶段完成后，会再排一个后台任务：

- `extract_memory_insights`

它会读取评分结果，抽取：

- 长期错误模式
- 高层表达偏差
- 稳定的训练提示

然后写入：

- `profile_memory.json`

这部分用模型的原因是：

- 高层模式归纳更适合语义抽取
- 但它不应该接管核心状态机

所以当前策略是：

- **规则管状态**
- **模型管洞察**

---

## 7.5 复习池

当前 concept 会被归到不同训练池中：

- `urgent_remediation`
  - 最近连续失败，需要优先修复
- `unstable_concepts`
  - 不是完全不会，但不稳定
- `recovery_watchlist`
  - 刚从错误中恢复，还需要观察
- `exploration_pool`
  - 默认练习池，承接新题和扩展题

复习池的意义是：系统不是按“总分高低”粗暴出题，而是按训练状态调度。

---

## 7.6 Memory 如何影响下一轮出题

Memory 通过两条路径作用到出题：

### 路径 A：影响 Prompt 摘要

生成试卷时，模型会收到小型 Memory 摘要，例如：

- 最近最弱的 Topic
- 最近最弱的知识点
- 最近最弱的技能维度
- 刚恢复但还不稳的点

这会改变模型对问题重心的选择。

### 路径 B：影响 RAG 排序

在 chunk 检索阶段，弱项信号会直接影响排序。

这会改变模型能看到什么上下文。

这两条路径叠加后，系统就会更倾向于：

- 再问你没掌握好的点
- 继续追你答得不稳的点
- 避免一张卷子看起来“覆盖很广”，实际上却没有命中真实薄弱点

---

## 8. 任务队列架构

模型任务全部进入统一 FIFO 队列。

任务类型包括：

- `rebuild_topics`
- `generate_paper`
- `grade_paper`
- `generate_bagu_doc`
- `extract_memory_insights`

为什么要串行：

- 本地 `codex exec` 资源有限
- 并发时更容易出现失败和状态混乱
- 这类系统更看重稳定而不是理论吞吐

任务状态包括：

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

前端支持：

- 进度条
- 预估耗时
- 删除
- 归档

---

## 9. 八股文档生成链路

除了出卷和评分，系统还支持直接生成新的八股知识文档。

流程：

```text
输入技术栈关键词 + 问题规模
   -> 检索相关上下文
   -> Codex 生成 Markdown 文档
   -> 写入 八股/
   -> 自动重建本地 RAG 索引
```

这样新文档会立刻进入后续检索和出题链路。

---

## 10. 一次完整请求的端到端视图

```text
[1] 用户在前端勾选 Topic
    ->
[2] 后端读取 Topic 权重 + Memory 摘要
    ->
[3] RAG 检索高相关 chunks
    ->
[4] 生成试卷任务进入队列
    ->
[5] Codex 生成试卷
    ->
[6] 用户逐题作答
    ->
[7] 用户提交评分
    ->
[8] 评分任务进入队列
    ->
[9] Codex 评分 + 本地校准
    ->
[10] 生成反馈文件
    ->
[11] 同步更新 Memory
    ->
[12] 异步抽取长期模式
    ->
[13] 下一次出题读取新的 Memory 视图
```

这 13 步就是 BaguAgent 的完整训练闭环。

---

## 11. 架构取舍

这个项目有几项明确的工程取舍：

- 不用前端框架，降低 demo 复杂度
- 不用数据库，保持本地可运行
- 不用外部向量库，优先做轻量可解释 RAG
- 模型任务串行，优先稳定性
- Memory 用文件化状态而不是复杂服务，优先透明和可调试

这些取舍共同指向一个目标：

**把真正重要的部分留给“练习闭环”和“记忆驱动出题”。**

---

## 12. 总结

从架构上看，BaguAgent 的核心不是“AI 出题”本身，而是：

- 试卷生成
- 完整作答
- 评分反馈
- Memory 更新
- 下一轮再出题

这条链路能不能闭合。

当前实现已经把这条链路做成了一个可运行的本地系统：

- 用轻量 RAG 控制上下文
- 用 FIFO 队列控制模型任务
- 用文件化 AgentMemory 保留训练状态
- 用同步规则 + 异步洞察让记忆既稳定又有语义层次

最终效果不是“做过多少题”，而是：

- 系统知道你哪里弱
- 系统知道你为什么弱
- 系统会继续问到你不再弱为止
