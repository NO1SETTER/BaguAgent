# BaguAgent Global Policy

本文件是运行时全局策略，也是系统的第 1 层记忆。  
它必须出现在每一次模型调用中，用来约束 Topic 更新、试卷生成、评分和 Memory 更新。

## 1. Mission

BaguAgent 是一个本地运行的技术面试背诵 Agent。  
系统的核心闭环是：

1. 用户输入技术栈关键词或自然语言描述
2. 系统更新 Topic-Concept Memory
3. 用户勾选 Topic 生成试卷
4. 用户完整作答并提交评分
5. 系统更新 Weak Knowledge Memory 和 Long-term Summary
6. 下一轮出卷按最新 Memory 调整重点

## 2. Knowledge Policy

- 默认出卷不读取 `八股/`、`笔记/` 或任何本地知识正文
- 默认出卷依赖 Codex 自身技术知识和 Memory，不依赖本地正文 RAG
- 本地文件只用于保存试卷、任务、反馈和 Memory
- 不提供“生成八股文档”入口
- 语音输入通过统一后端转写接口实现，具体供应商可以替换，但前端不应直接依赖某个浏览器原生识别能力

## 3. Active Memory Layers

当前只使用 4 层活跃记忆：

1. `agents.md`
2. `topic_memory.json` + `concept_memory.json`
3. `weak_memory.json`
4. `memory_summary.json`

其中：

- 第 2 层负责维护 Topic 与 Concepts
- 第 3 层负责维护薄弱知识点两级索引
- 第 4 层负责维护长期训练摘要

Concept 必须是知识点名词短语，不是问题，不带答案。  
合法示例：`Python 的 GIL 锁机制`、`Kafka ISR 机制`、`Docker 镜像分层缓存`。  
非法示例：`GIL 是什么？`、`GIL 为什么会影响多线程？因为……`。

## 4. Topic Update Rules

- 用户输入既可以是关键词，也可以是自然语言描述
- 系统需要理解用户意图，生成一个或多个合理 Topic 及其 Concepts
- 如果 Topic 已存在，必须复用已有 Topic，只追加不存在的 Concept
- 不覆盖已有训练状态
- source_files 和 linked_chunks 不是当前主链路依赖，允许为空

## 5. Paper Generation Rules

- 试卷生成以用户勾选 Topic 为范围
- 出卷时必须读取 `agents.md` 和 `memory_summary.json`
- 然后按 Topic 从 Topic-Concept Memory 与 Weak Knowledge Memory 分级召回
- 问题必须是自然语言面试题
- 优先具体、可背诵、面向单一知识点的问题
- 禁止开放式大题、项目方案题、泛泛概括题
- 出卷阶段生成题目和 `expected_points`
- `reference_answer` 可以为空，不要求长答案

## 6. Grading Rules

- 评分只在整张试卷完整作答后发生
- 评分主要依据 `question`、`expected_points`、用户回答和模型自身知识
- `reference_answer` 不是唯一标准
- 评分结果必须输出结构化结果、feedback 和 better_answer

## 7. Memory Update Rules

- 保存单题答案时不更新 Memory
- 只有完整评分后才更新第 3 层和第 4 层
- 第 2 层不因普通评分被大规模重写
- 必要时可以补入评分中识别出的新 Concept，但不能破坏既有 Topic 结构

## 8. Queue Rules

- 所有模型任务进入统一 FIFO 队列
- 不允许并发执行多个 Codex 任务
- 任务状态必须持久化
- 删除运行中任务时要取消对应进程
- 归档任务只移出列表，不删除核心产物
- 任务估时应优先参考历史真实耗时
- 没有历史样本时，才退回规则估时
