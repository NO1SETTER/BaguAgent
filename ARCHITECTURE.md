# BaguAgent Architecture

本文档描述当前版本的 BaguAgent。  
重点不是“本地知识库怎么检索”，而是 **Codex + Memory 如何形成出卷与复习闭环**。

## 1. 系统定位

BaguAgent 是一个本地运行的技术面试背诵系统。

当前版本的核心设计是：

- **Topic 由用户手动输入描述创建**
- **Concept 由模型生成并写入 Memory**
- **试卷生成依赖 Codex 自身知识**
- **Memory 决定下一轮更该问什么**

它不是一个文档检索器，也不是一个八股知识库浏览器。

## 2. 高层结构

```text
+--------------------+         +----------------------+
|     Frontend UI    | <-----> |   Node HTTP Server   |
| HTML / CSS / JS    |   API   |   server.js          |
+--------------------+         +----------+-----------+
                                           |
                                           v
                                +----------------------+
                                |   FIFO Task Queue    |
                                |   Codex Jobs         |
                                +----------+-----------+
                                           |
                          +----------------+----------------+
                          |                                 |
                          v                                 v
                +--------------------+            +----------------------+
                |  GPT-5.4 / GPT-5.2 |            |   Memory Storage     |
                | generate / grade   |            | JSON + Markdown      |
                +--------------------+            +----------------------+
```

当前主链路只有三个核心部分：

1. 前端交互
2. 后端任务编排
3. Memory 驱动的模型调用
4. 可替换的后端语音转写接口

## 3. 前端

位置：

- `interview-trainer/public/index.html`
- `interview-trainer/public/app.js`
- `interview-trainer/public/styles.css`

职责：

- 创建 / 更新 Topic
- 勾选 Topic 生成试卷
- 录音、文本答题与转写结果确认
- 查看任务队列
- 提交评分
- 查看反馈

前端不做知识理解，也不直接处理 Memory 逻辑。  
它只负责输入、展示和 API 调用。

## 4. 后端

位置：

- `interview-trainer/server.js`
- `interview-trainer/task-prompts.js`

职责：

- 提供 HTTP API
- 管理 FIFO 任务队列
- 调用 Codex 生成 Topic / 试卷 / 评分结果
- 提供统一语音转写接口
- 保存试卷、反馈、任务状态
- 更新 Memory

## 5. 模型使用

当前模型职责是分开的：

- `gpt-5.4`
  - 只用于试卷生成
- `gpt-5.2`
  - 用于 Topic 更新
  - 用于评分
  - 用于其他非试卷生成任务

所有模型调用都会自动注入：

- `interview-trainer/data/memory/agents.md`

这使得 `agents.md` 不只是文档，而是运行时全局策略。

## 5.1 语音转写

当前语音输入已经不再依赖浏览器原生 `SpeechRecognition` 作为主链路。

前端流程：

- 浏览器录音
- 本地转成 `16k wav`
- 上传到后端 `/api/speech/transcribe`

后端流程：

- 根据当前题目的 `topic / concept / expected_points` 生成热词提示
- 调用具体的语音服务供应商
- 返回统一文本结果给前端

这样做的意义是：

- 供应商可替换
- 中英混输和专业词识别可以继续优化
- 前端交互不用跟着不同供应商接口反复改动

## 6. Memory 结构

当前 Memory 只保留 4 层活跃结构。

### 6.1 第 1 层：Global Policy

文件：

- `interview-trainer/data/memory/agents.md`

职责：

- 统领所有模型任务
- 规定 Topic / Concept / Weak Memory 的使用方式
- 规定出卷、评分、更新时机

它会进入每一次模型调用的 prompt。

### 6.2 第 2 层：Topic-Concept Memory

文件：

- `interview-trainer/data/memory/topic_memory.json`
- `interview-trainer/data/memory/concept_memory.json`

职责：

- 记录当前有哪些 Topic
- 记录每个 Topic 下有哪些 Concept
- Concept 是“知识点名词短语”，不是问题，不带答案

示例：

- `Python 的 GIL 锁机制`
- `Kafka ISR 机制`
- `Docker 镜像分层缓存`

更新时机：

- 仅在“创建 / 更新 Topic”任务完成后更新

### 6.3 第 3 层：Weak Knowledge Memory

文件：

- `interview-trainer/data/memory/weak_memory.json`

职责：

- 记录用户不熟悉、答错、部分正确、不稳定的知识点
- 采用两级索引：
  - Topic 级索引
  - Concept 级明细

Concept 级记录会包含更细的信息，例如：

- 最近分数
- 连续错误情况
- 遗漏点
- 最近反馈
- 复习优先级

更新时机：

- 只在完整试卷评分后更新

### 6.4 第 4 层：Long-term Summary

文件：

- `interview-trainer/data/memory/memory_summary.json`
- `interview-trainer/data/tasks/task_metrics.json`

职责：

- 汇总长期训练状态
- 提供下一轮出卷所需的小摘要

通常包含：

- weak topics
- weak concepts
- unstable concepts
- recently mastered

更新时机：

- 只在完整试卷评分后更新

### 6.5 任务估时统计

文件：

- `interview-trainer/data/tasks/task_metrics.json`

职责：

- 记录不同任务类型的真实耗时样本
- 让任务进度条优先使用“历史中位数估时”
- 只在没有历史样本时退回固定规则估时

当前主要按这些维度分组：

- `generate_paper`: 模型 + 题量 + 模式
- `grade_paper`: 模型
- `update_topic_concepts`: 模型

## 7. Topic 创建 / 更新链路

当前版本不再扫描本地知识库解析 Topic。  
Topic 来自用户输入。

流程：

```text
用户输入关键词或自然语言描述
   -> POST /api/topics/update
   -> 进入 FIFO 队列
   -> GPT-5.2 理解描述
   -> 生成 Topic 和 Concepts
   -> 合并到 topic_memory.json / concept_memory.json
```

关键约束：

- Topic 已存在时只补充新增 Concept
- 不覆盖已有训练状态
- Concept 必须是名词短语

## 8. 试卷生成链路

试卷生成是当前系统最重要的运行链路。

流程：

```text
用户勾选 Topic
   -> 后端读取 agents.md
   -> 读取 memory_summary.json
   -> 按 Topic 从 Topic-Concept Memory 召回候选 Concept
   -> 再从 Weak Knowledge Memory 召回薄弱 Concept
   -> 组装知识提示 knowledgeHints
   -> GPT-5.4 按 JSON Schema 生成试卷
   -> 保存试卷
```

当前版本有几个关键边界：

- 默认不读取 `八股/`、`笔记/` 正文
- 默认不依赖本地 RAG 正文检索
- 试卷生成只走一次结构化 JSON 输出
- 不再使用宽松重试
- 不再进行“生成后再修 schema”的二次模型调用

换句话说，出卷是：

**Memory 限定范围，Codex 负责出题。**

## 9. 作答链路

流程：

```text
前端加载试卷
   -> 用户录音或文本作答
   -> 录音上传 /api/speech/transcribe
   -> 后端转写返回文本
   -> 逐题保存答案
```

这个阶段：

- 不更新 Memory
- 不触发评分
- 只保存试卷状态

## 10. 评分链路

流程：

```text
用户提交评分
   -> 后端检查是否完整作答
   -> 进入 FIFO 队列
   -> GPT-5.2 结构化评分
   -> 生成反馈文件
   -> 更新 weak_memory.json
   -> 更新 memory_summary.json
```

评分依据：

- `question`
- `expected_points`
- `user_answer`

`reference_answer` 不是评分唯一依据，只是辅助字段。

评分输出通常包括：

- `score`
- `level`
- `covered_points`
- `missed_points`
- `incorrect_points`
- `feedback`
- `better_answer`

## 11. Memory 如何影响下一轮出题

这是整个系统真正的闭环。

一次完整评分后：

1. 第 3 层 Weak Knowledge Memory 被更新
2. 第 4 层 Long-term Summary 被更新
3. 下一次出卷时，这两层会参与召回

因此下一张卷子不是随机生成，而是更偏向：

- 你最近一直不会的 Concept
- 你答对过但不稳定的 Concept
- 你当前勾选 Topic 下的高优先级薄弱点

## 12. 任务队列

所有模型任务统一进入 FIFO 队列。

主要任务类型：

- `update_topic_concepts`
- `generate_paper`
- `grade_paper`

队列规则：

- 同一时间只执行一个模型任务
- 任务状态持久化
- 删除运行中任务时需要取消对应子进程
- 归档只移出列表，不删除核心结果
- 任务估时优先使用历史真实耗时中位数
- 运行时间明显超过历史估时时，前端显示超时提示而不是继续显示不可信倒计时

## 13. 当前不再使用的旧设计

当前仓库里可能还保留一些历史代码或历史数据，但它们不再是主链路的一部分：

- 基于 `八股/`、`笔记/` 的默认正文 RAG 出卷
- 自动扫描本地知识库生成 Topic
- 生成八股文档入口
- 前端 Memory 可视化
- 依赖宽松 JSON 重试的试卷生成链路

## 14. 结论

当前 BaguAgent 的架构可以概括为：

**Codex 负责知识与生成，Memory 负责范围与个性化，评分结果负责驱动下一轮练习。**

这也是当前版本和早期版本最大的区别。  
早期版本更像“知识库驱动的出题器”，当前版本更像“Memory 驱动的训练 Agent”。
