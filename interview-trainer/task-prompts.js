export function buildUpdateTopicConceptsPrompt({ description, conceptCount, existingTopics }) {
  return [
    '你是一个技术面试训练系统的 Topic-Concept Memory 更新器。',
    '请根据用户输入的关键词或自然语言描述，创建或更新技术栈 Topic，并生成可用于出卷的 Concepts。',
    '用户输入可能是一段自然语言，例如“我最近想补 Python 后端面试，重点包括 GIL、协程、GC、装饰器和常见容器”。你需要理解其技术栈意图。',
    `请总共生成约 ${conceptCount} 个 Concepts；如果涉及多个 Topic，请合理分配。`,
    'Topic 应该是技术栈或领域，例如 Python、Kafka、Docker、SQL/MySQL、C++、LLM Agent。',
    'Concept 必须是知识点名词短语，不是问题，也不能包含答案。',
    '合法 Concept 示例：“Python 的 GIL 锁机制”“Kafka ISR 机制”“Docker 镜像分层缓存”。',
    '非法 Concept 示例：“GIL 是什么？”“GIL 为什么会影响多线程？因为……”。',
    '如果 Topic 已存在，请复用现有 topic_id；只补充新的 Concepts。',
    'source_files 和 linked_chunks 输出空数组。',
    '请输出 JSON，必须符合 schema。',
    JSON.stringify({ description, existing: existingTopics })
  ].join('\n\n');
}

export function buildGeneratePaperPrompt({ payload, selectedTopics, memorySummary, knowledgeHints }) {
  return [
    '你是一个严格的技术面试官，请生成一张用于语音背诵练习的中文面试试卷。',
    '本阶段只负责生成题目和评分要点。KnowledgeMemory 只用于限定范围、选择知识点和体现薄弱项，不提供答案正文。',
    '输出前先自检：题量必须正确，问题必须具体，不符合要求就先在内部修正后再输出，不要把半成品交出来。',
    '要求：',
    `1. 总问题数必须等于 ${payload.question_count}。`,
    `2. 试卷模式是 ${payload.mode}。normal=独立题；followup=围绕 Topic 生成 3-5 个连续追问链；mixed=两者混合。`,
    '3. 每题必须包含 topic、topic_id、concept、source_type、difficulty、question、expected_points、reference_answer；如能判断来源，可附带 source_chunks。',
    '4. concept 必须是知识点名词短语，不是问题，不包含答案，例如“Python 的 GIL 锁机制”。',
    '5. source_type 只能是 bagu_local、note_readonly、expanded。',
    '6. expected_points 写 3-5 条核心评分点，必须和 question 直接对应。',
    '7. reference_answer 可以留空字符串；不要在出卷阶段生成长参考答案。',
    '8. 题目应根据用户选择的 Topic、KnowledgeMemory 和记忆摘要加权。',
    '9. 追问链需要记录 chain_goal，并保持难度递进。',
    '10. 参考合格题型：CPython 的 GIL 为什么会限制 CPU 密集型多线程？range() 为什么不能直接说成迭代器？Kafka 的 ISR 机制解决的核心问题是什么？',
    '11. 禁止不合格题型：请概括 Python 这门语言；请从多个角度分析 Docker；你会如何在项目中设计消息队列方案。',
    '请输出 JSON，必须符合 schema。',
    JSON.stringify({
      request: payload,
      selected_topics: selectedTopics,
      memory_summary: memorySummary,
      knowledge_memory: knowledgeHints
    })
  ].join('\n\n');
}

export function buildGradePaperPrompt({ paper }) {
  return [
    '你是一个严格但建设性的中文技术面试评分官。',
    '请根据每题的 question、expected_points 和用户回答进行评分。',
    'reference_answer 可能为空或只是辅助信息，不要把它当作唯一标准；请主要依据题干、expected_points 和你的技术知识评分。',
    '要求：',
    '1. 每题 score 为 0-100。',
    '2. level 为 correct、partial 或 wrong，且与 score 区间一致：wrong=0-39，partial=40-79，correct=80-100。',
    '3. 如果回答命中至少一个核心点，但不完整或表达有偏差，应给 partial，分数至少 40。',
    '4. 擦边正确（只命中少量要点、深度不够）建议给 40-55，不要给最低分。',
    '5. partial 内部分层：40-55=擦边；56-69=部分正确；70-79=接近正确但仍有关键缺漏。',
    '6. 只有明显答非所问、核心点基本缺失、或存在严重错误时才给 wrong。',
    '7. 有实质错误时在 incorrect_points 明确写出。',
    '8. covered_points/missed_points 要与 score 对齐，不能自相矛盾。',
    '9. 给出 better_answer 和 feedback。',
    '10. 对追问链给出 chain_score、breakdown_question_index、weakest_follow_up_type。',
    '11. 如有高频薄弱知识点，可给出知识沉淀候选。',
    '请输出 JSON，必须符合 schema。',
    JSON.stringify({ paper })
  ].join('\n\n');
}
