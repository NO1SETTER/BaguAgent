# BaguAgent

给准备找工作的宝子们一个更像“真面试排练器”的八股 Agent。  
不是背 agent 的八股，是让 agent 帮你背八股。

很多人背八股的问题不是没看过，而是：

- 看过
- 记过
- 真被问到时开始说“这个我大概知道……”

BaguAgent 的目标很直接：**把“我好像会”练成“你问我就答”**。

它现在的核心不是本地知识库检索，而是 **Codex 自身技术能力 + Memory 驱动的练习闭环**：

1. 你手动输入一个技术栈关键词，或者一段自然语言描述
2. 系统把它整理成 Topic 和 Concepts，写入 Memory
3. 你勾选 Topic 生成试卷
4. 你完整作答后提交评分
5. 系统更新薄弱知识点和长期总结
6. 下一轮试卷优先追着你的薄弱点问

一句话：**这不是刷题页，这是个会记仇的背诵系统。**

## 功能

### 🧠 Memory First

- `agents.md` 作为全局策略和第 1 层记忆，所有模型调用都会注入
- `Topic-Concept Memory` 维护当前可练的技术栈和知识点
- `Weak Knowledge Memory` 记录答错、部分正确和不稳定的知识点
- `Long-term Summary` 汇总长期表现，驱动下一轮出卷
- Memory 只在**整张试卷完整作答并提交评分后**更新

### 🏷️ 手动创建 / 更新 Topic

- 支持输入关键词：`Python`
- 也支持输入自然语言描述：
  - `Python 后端面试，重点包括 GIL、协程、GC、装饰器、容器和 asyncio`
- 系统会自动理解描述，生成 Topic 与 Concepts
- 如果 Topic 已存在，只补充新增 Concept，不覆盖现有训练状态
- Concept 被约束为**知识点名词短语**，不是问题，不带答案

### 📝 试卷生成

- 支持 `10 / 30 / 50` 题
- 支持三种模式：
  - `normal`
  - `followup`
  - `mixed`
- 试卷生成使用 `gpt-5.4`
- 出卷默认**不读取 `八股/`、`笔记/` 或任何本地知识正文**
- 出卷只依赖：
  - 全局策略
  - 用户勾选的 Topic
  - Topic-Concept Memory
  - Weak Knowledge Memory
  - Long-term Summary

### 🎙️ 作答

- 浏览器内录音
- 默认通过后端统一接口 `/api/speech/transcribe` 做语音转写
- 当前已接好“后端转写接口 + 前端录音上传”的结构，供应商可以替换，不锁死浏览器原生语音 API
- 支持手动编辑文本
- 支持逐题保存
- 未完整作答不能提交评分

### 🤖 评分与反馈

- 评分任务使用结构化 JSON 输出
- 依据 `question + expected_points + 用户答案` 评分
- `reference_answer` 不是评分唯一依据
- 每次评分会产出：
  - 分数
  - 覆盖点
  - 遗漏点
  - 错误点
  - feedback
  - better_answer
- 评分完成后生成反馈文件，并更新 Weak Knowledge Memory 与 Long-term Summary

### 📋 任务队列

- 所有模型任务统一进入 FIFO 队列
- 不并发执行多个 Codex 任务
- 支持排队、运行、删除、归档
- 任务估时现在会优先参考历史真实耗时，而不是只用固定规则

## 当前架构

当前版本已经从“本地知识库 RAG 出卷”切换为 **Memory-only 出卷**：

- 不再依赖扫描 `八股/`、`笔记/` 自动解析 Topic
- 不再默认把本地知识正文送进 prompt
- Topic 和 Concept 由你手动创建 / 更新
- Codex 根据自身知识和 Memory 生成试卷并评分
- 语音输入已经从浏览器原生识别抽离成可替换的后端转写接口

更详细的系统结构见：

- [ARCHITECTURE.md](/Users/zhouyux/Documents/Workspace/interview/ARCHITECTURE.md)
- [agents.md](/Users/zhouyux/Documents/Workspace/interview/interview-trainer/data/memory/agents.md)

## 目录

- `interview-trainer/`: 应用代码
- `interview-trainer/data/memory/`: 当前纳入版本控制的 Memory 初始状态
- `截图/`: 项目截图

以下目录**不再跟踪**：

- `八股/`
- `笔记/`
- `简历/`

它们可以继续留在你本地，但不会进入仓库。

## 运行环境

- Node.js 20+
- 本地可用的 `codex` CLI
- Chrome 或兼容 Web Speech API 的浏览器

## 启动

```bash
cd interview-trainer
npm run dev
```

默认地址：

`http://127.0.0.1:5177`

## 常用脚本

```bash
cd interview-trainer
npm run dev
npm run check
```

## 使用方式

1. 启动服务
2. 在“创建/更新 Topic”里输入关键词或自然语言描述
3. 等 Topic 更新任务完成
4. 勾选 Topic，选择题量和模式，生成试卷
5. 完整作答
6. 提交评分
7. 查看反馈，继续下一轮练习

## 版本控制策略

仓库会保留一份可直接运行的初始 Memory 状态：

- `interview-trainer/data/memory/agents.md`
- `interview-trainer/data/memory/topic_memory.json`
- `interview-trainer/data/memory/concept_memory.json`
- `interview-trainer/data/memory/weak_memory.json`
- `interview-trainer/data/memory/memory_summary.json`

另外，任务系统会保留历史估时统计：

- `interview-trainer/data/tasks/task_metrics.json`

以下内容默认不提交：

- `interview-trainer/data/papers/`
- `interview-trainer/data/feedback/`
- `interview-trainer/data/tasks/`
- `interview-trainer/data/rag/*.json`
- `interview-trainer/data/memory/memory.json`
- `interview-trainer/data/memory/memory_events.jsonl`
- `interview-trainer/data/memory/skill_memory.json`
- `interview-trainer/data/memory/profile_memory.json`
- `interview-trainer/data/knowledge_candidates/`

## 截图

首页：

![首页](./截图/截屏2026-04-21%2002.04.09.png)

任务与试卷：

![任务与试卷](./截图/截屏2026-04-21%2002.04.32.png)

## License

MIT
