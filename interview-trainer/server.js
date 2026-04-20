import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 5177);
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(APP_DIR, '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = path.join(APP_DIR, 'data');
const SCHEMA_DIR = path.join(APP_DIR, 'schemas');
const BAGU_DIR = path.join(REPO_DIR, '八股');
const NOTE_DIR = path.join(REPO_DIR, '笔记');

const DIRS = {
  topics: path.join(DATA_DIR, 'topics'),
  papers: path.join(DATA_DIR, 'papers'),
  feedback: path.join(DATA_DIR, 'feedback'),
  memory: path.join(DATA_DIR, 'memory'),
  candidates: path.join(DATA_DIR, 'knowledge_candidates'),
  tasks: path.join(DATA_DIR, 'tasks'),
  rag: path.join(DATA_DIR, 'rag')
};

const FILES = {
  topics: path.join(DIRS.topics, 'topics.json'),
  memory: path.join(DIRS.memory, 'memory.json'),
  tasks: path.join(DIRS.tasks, 'tasks.json'),
  chunks: path.join(DIRS.rag, 'chunks.json'),
  topicIndex: path.join(DIRS.rag, 'topic_index.json'),
  questionBank: path.join(DIRS.rag, 'question_bank.json')
};
const TOPIC_INDEX_VERSION = 3;
const CODEX_MODEL = 'gpt-5.2';

const KNOWN_TOPICS = [
  { name: 'Python', aliases: ['python', 'cpython', 'gil', 'asyncio'], category: 'language' },
  { name: 'C++', aliases: ['c++', 'cpp', 'c/c++'], category: 'language' },
  { name: 'SQL/MySQL', aliases: ['sql', 'mysql', 'innodb', 'mvcc', '索引', '事务'], category: 'database' },
  { name: 'Docker', aliases: ['docker', 'dockerfile', 'compose', 'container'], category: 'container' },
  { name: 'Kafka', aliases: ['kafka', 'broker', 'partition', 'isr'], category: 'mq' },
  { name: 'ELK', aliases: ['elk', 'elasticsearch', 'logstash', 'kibana'], category: 'observability' },
  { name: 'LLM Agent', aliases: ['agent', 'llm', '大模型', 'tool use', 'function calling'], category: 'ai-agent' },
  { name: 'AgentMemory', aliases: ['memory', 'mem0', 'letta', '记忆'], category: 'ai-agent' },
  { name: 'Harness Engineering', aliases: ['harness', '评测', '控制模型行为'], category: 'ai-agent' },
  { name: 'LogAgent', aliases: ['log agent', '日志', '异常检测'], category: 'observability' }
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

let tasks = [];
let queueRunning = false;
const activeTaskProcesses = new Map();

await ensureDataDirs();
await loadTasks();
await ensureMemory();
await ensureLocalIndexes();
startQueueLoop();

createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || String(error) });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Interview trainer running at http://127.0.0.1:${PORT}`);
});

async function ensureDataDirs() {
  await Promise.all(Object.values(DIRS).map((dir) => fs.mkdir(dir, { recursive: true })));
}

async function ensureMemory() {
  if (existsSync(FILES.memory)) return;
  await writeJson(FILES.memory, {
    version: 1,
    updated_at: new Date().toISOString(),
    topics: {},
    knowledge: {},
    questions: {},
    chains: {}
  });
}

async function loadTasks() {
  if (!existsSync(FILES.tasks)) {
    tasks = [];
    await saveTasks();
    return;
  }
  tasks = await readJson(FILES.tasks, []);
  for (const task of tasks) {
    task.progress ??= task.status === 'completed' ? 100 : 0;
    task.stage ||= task.status === 'queued' ? '排队中' : task.status;
    task.estimated_seconds ||= estimateTaskSeconds(task.type, task.payload || {});
    if (['completed', 'failed', 'cancelled'].includes(task.status) && !task.finished_at) {
      task.finished_at = task.updated_at || task.started_at || task.created_at || new Date().toISOString();
    }
    if (task.status === 'running') {
      task.status = 'queued';
      task.updated_at = new Date().toISOString();
    }
  }
  await saveTasks();
}

async function saveTasks() {
  await writeJson(FILES.tasks, tasks);
}

function startQueueLoop() {
  if (queueRunning) return;
  queueRunning = true;
  setTimeout(processQueue, 10);
}

async function enqueueTask(type, payload) {
  const task = {
    task_id: randomUUID(),
    type,
    payload,
    status: 'queued',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    progress: 0,
    stage: '排队中',
    estimated_seconds: estimateTaskSeconds(type, payload),
    result: null,
    error: null
  };
  tasks.push(task);
  await saveTasks();
  startQueueLoop();
  return task;
}

async function processQueue() {
  try {
    while (true) {
      const task = tasks.find((item) => item.status === 'queued');
      if (!task) break;
      task.status = 'running';
      task.started_at = new Date().toISOString();
      task.progress = Math.max(task.progress || 0, 5);
      task.stage = '开始执行';
      task.finished_at = new Date().toISOString();
      task.updated_at = task.finished_at;
      await saveTasks();
      try {
        assertTaskNotCancelled(task);
        if (task.type === 'rebuild_topics') task.result = await taskRebuildTopics(task);
        if (task.type === 'rebuild_index') task.result = await taskRebuildTopics(task);
        if (task.type === 'generate_paper') task.result = await taskGeneratePaper(task.payload, task);
        if (task.type === 'grade_paper') task.result = await taskGradePaper(task.payload, task);
        if (task.type === 'generate_bagu_doc') task.result = await taskGenerateBaguDoc(task.payload, task);
        task.status = 'completed';
        task.progress = 100;
        task.stage = '完成';
      } catch (error) {
        if (task.cancel_requested) {
          task.status = 'cancelled';
          task.stage = '已取消';
          task.error = null;
        } else {
          task.status = 'failed';
          task.stage = '失败';
          task.error = error.stack || error.message || String(error);
        }
      }
      task.updated_at = new Date().toISOString();
      await saveTasks();
    }
  } finally {
    queueRunning = false;
    if (tasks.some((item) => item.status === 'queued')) startQueueLoop();
  }
}

async function updateTaskProgress(task, progress, stage) {
  if (!task) return;
  assertTaskNotCancelled(task);
  task.progress = clamp(Number(progress), 0, 99);
  task.stage = stage;
  task.updated_at = new Date().toISOString();
  await saveTasks();
}

function assertTaskNotCancelled(task) {
  if (task?.cancel_requested) {
    throw new Error('Task cancelled');
  }
}

async function deleteTask(taskId) {
  const index = tasks.findIndex((item) => item.task_id === taskId);
  if (index === -1) return { deleted: false };
  const task = tasks[index];
  task.cancel_requested = true;
  task.updated_at = new Date().toISOString();
  const active = activeTaskProcesses.get(taskId);
  if (active) {
    active.kill('SIGTERM');
    setTimeout(() => {
      if (!active.killed) active.kill('SIGKILL');
    }, 3000);
    activeTaskProcesses.delete(taskId);
  }
  tasks.splice(index, 1);
  await saveTasks();
  return {
    deleted: true,
    task_id: taskId,
    previous_status: task.status,
    cancelled_process: Boolean(active)
  };
}

async function archiveTask(taskId) {
  const index = tasks.findIndex((item) => item.task_id === taskId);
  if (index === -1) return { archived: false };
  const task = tasks[index];
  await assertTaskCanArchive(task);
  tasks.splice(index, 1);
  await saveTasks();
  return {
    archived: true,
    task_id: taskId,
    type: task.type,
    kept: archiveKeptArtifact(task)
  };
}

async function assertTaskCanArchive(task) {
  if (task.status !== 'completed') {
    throw new Error('只能归档已完成的任务。排队中或运行中的任务请使用删除。');
  }
  if (task.type === 'rebuild_topics' || task.type === 'rebuild_index') {
    return;
  }
  if (task.type === 'generate_paper') {
    const paperId = task.result?.paper_id;
    if (!paperId) throw new Error('生成试卷任务没有可归档的试卷文件。');
    const paper = await readPaper(paperId);
    assertPaperFullyAnswered(paper);
    return;
  }
  if (task.type === 'grade_paper') {
    if (!task.result?.paper_id && !task.payload?.paper_id) throw new Error('评分任务没有关联试卷。');
    return;
  }
  if (task.type === 'generate_bagu_doc') {
    if (!task.result?.file) throw new Error('生成八股任务没有可归档的八股文件。');
    return;
  }
  throw new Error(`任务类型 ${task.type} 不支持归档。`);
}

function archiveKeptArtifact(task) {
  if (task.result?.paper_id) return task.result.paper_id;
  if (task.result?.feedback_file) return task.result.feedback_file;
  if (task.result?.file) return task.result.file;
  if (task.result?.topics_file) return task.result.topics_file;
  return null;
}

function estimateTaskSeconds(type, payload = {}) {
  if (type === 'generate_paper') {
    const count = Number(payload.question_count || 10);
    const topicCount = Array.isArray(payload.selected_topics) ? payload.selected_topics.length : 1;
    const modeFactor = payload.mode === 'followup' ? 1.25 : payload.mode === 'mixed' ? 1.15 : 1;
    return Math.round((50 + count * 7 + topicCount * 8) * modeFactor);
  }
  if (type === 'grade_paper') return 90;
  if (type === 'generate_bagu_doc') return Math.round(60 + Number(payload.question_count || 20) * 4);
  if (type === 'rebuild_topics' || type === 'rebuild_index') return 45;
  return 60;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;

  if (req.method === 'GET' && route === '/api/health') {
    sendJson(res, 200, { ok: true, port: PORT });
    return;
  }

  if (req.method === 'POST' && route === '/api/topics/rebuild') {
    sendJson(res, 202, await enqueueTask('rebuild_topics', {}));
    return;
  }

  if (req.method === 'POST' && route === '/api/index/rebuild') {
    sendJson(res, 202, await enqueueTask('rebuild_index', {}));
    return;
  }

  if (req.method === 'GET' && route === '/api/index') {
    sendJson(res, 200, await readIndexSummary());
    return;
  }

  if (req.method === 'GET' && route === '/api/topics') {
    sendJson(res, 200, await readAvailableTopics());
    return;
  }

  if (req.method === 'GET' && route === '/api/library') {
    sendJson(res, 200, await scanKnowledgeBase());
    return;
  }

  if (req.method === 'POST' && route === '/api/papers') {
    const body = await readBody(req);
    validatePaperRequest(body);
    sendJson(res, 202, await enqueueTask('generate_paper', body));
    return;
  }

  if (req.method === 'POST' && route === '/api/bagu-docs/generate') {
    const body = await readBody(req);
    validateBaguDocRequest(body);
    sendJson(res, 202, await enqueueTask('generate_bagu_doc', body));
    return;
  }

  const paperMatch = route.match(/^\/api\/papers\/([^/]+)$/);
  if (req.method === 'GET' && paperMatch) {
    sendJson(res, 200, await readPaper(paperMatch[1]));
    return;
  }

  const answersMatch = route.match(/^\/api\/papers\/([^/]+)\/answers$/);
  if (req.method === 'POST' && answersMatch) {
    const paper = await readPaper(answersMatch[1]);
    const body = await readBody(req);
    paper.answers = { ...(paper.answers || {}), ...(body.answers || {}) };
    paper.updated_at = new Date().toISOString();
    await writePaper(paper);
    sendJson(res, 200, { ok: true, paper_id: paper.paper_id });
    return;
  }

  const gradeMatch = route.match(/^\/api\/papers\/([^/]+)\/grade$/);
  if (req.method === 'POST' && gradeMatch) {
    sendJson(res, 202, await enqueueTask('grade_paper', { paper_id: gradeMatch[1] }));
    return;
  }

  const taskMatch = route.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'DELETE' && taskMatch) {
    sendJson(res, 200, await deleteTask(taskMatch[1]));
    return;
  }

  const archiveTaskMatch = route.match(/^\/api\/tasks\/([^/]+)\/archive$/);
  if (req.method === 'POST' && archiveTaskMatch) {
    sendJson(res, 200, await archiveTask(archiveTaskMatch[1]));
    return;
  }

  if (req.method === 'GET' && taskMatch) {
    const task = tasks.find((item) => item.task_id === taskMatch[1]);
    if (!task) return sendJson(res, 404, { error: 'Task not found' });
    sendJson(res, 200, task);
    return;
  }

  if (req.method === 'GET' && route === '/api/tasks') {
    sendJson(res, 200, tasks.slice().reverse());
    return;
  }

  if (req.method === 'GET' && route === '/api/memory') {
    sendJson(res, 200, await readJson(FILES.memory, {}));
    return;
  }

  const feedbackMatch = route.match(/^\/api\/feedback\/([^/]+)$/);
  if (req.method === 'GET' && feedbackMatch) {
    const paper = await readPaper(feedbackMatch[1]);
    const markdown = paper.feedback_file ? await fs.readFile(paper.feedback_file, 'utf8') : '';
    sendJson(res, 200, { paper_id: paper.paper_id, markdown, feedback_file: paper.feedback_file || null });
    return;
  }

  const candidateMatch = route.match(/^\/api\/knowledge-candidates\/([^/]+)\/apply$/);
  if (req.method === 'POST' && candidateMatch) {
    sendJson(res, 200, await applyCandidate(candidateMatch[1]));
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

function validatePaperRequest(body) {
  const questionCount = Number(body.question_count);
  if (![10, 30, 50].includes(questionCount)) {
    throw new Error('question_count must be 10, 30, or 50');
  }
  if (!['normal', 'followup', 'mixed'].includes(body.mode)) {
    throw new Error('mode must be normal, followup, or mixed');
  }
  if (!Array.isArray(body.selected_topics) || body.selected_topics.length === 0) {
    throw new Error('selected_topics is required');
  }
  const limit = topicLimitForQuestionCount(questionCount);
  if (Number.isFinite(limit) && body.selected_topics.length > limit) {
    throw new Error(`${questionCount}题试卷最多选择${limit}个Topic，当前选择了${body.selected_topics.length}个。请减少Topic数量或选择更大题量。`);
  }
}

function topicLimitForQuestionCount(questionCount) {
  if (Number(questionCount) === 10) return 3;
  if (Number(questionCount) === 30) return 6;
  return Infinity;
}

function validateBaguDocRequest(body) {
  if (!Array.isArray(body.keywords) || body.keywords.map(String).filter(Boolean).length === 0) {
    throw new Error('keywords is required');
  }
  const count = Number(body.question_count);
  if (!Number.isInteger(count) || count < 5 || count > 200) {
    throw new Error('question_count must be an integer between 5 and 200');
  }
}

async function taskRebuildTopics(task = null) {
  await updateTaskProgress(task, 10, '扫描知识库并重建本地索引');
  const library = await ensureRagIndex();
  await updateTaskProgress(task, 35, '调用 Codex 解析 Topic');
  const schema = path.join(SCHEMA_DIR, 'topics.schema.json');
  const prompt = [
    '你是一个面试知识库 Topic 解析器。请从给定 Markdown 知识库中抽取所有可能涉及的技术栈 Topic。',
    'Topic 应该是可用于生成面试试卷的技术栈或领域，例如 Python、C++、Docker、Kafka、SQL/MySQL、LLM Agent。',
    '笔记/ 目录是只读来源；八股/ 目录可用于后续面试知识沉淀。',
    '请输出 JSON，必须符合 schema。',
    JSON.stringify({ files: library.files, sections: library.sections.slice(0, 300), chunks: library.chunks.slice(0, 300) })
  ].join('\n\n');
  const result = await runCodexJson(prompt, schema, task).catch(() => null);
  await updateTaskProgress(task, 80, '写入 Topic 和 RAG 索引');
  const topics = normalizeTopics(result?.topics?.length ? result : await buildFallbackTopics());
  const rebuilt = await rebuildLocalIndexes(topics, { writeTopics: true });
  return {
    topics_count: topics.topics.length,
    chunks_count: rebuilt.chunks.length,
    topics_file: path.relative(REPO_DIR, FILES.topics)
  };
}

async function taskGeneratePaper(payload, task = null) {
  await updateTaskProgress(task, 8, '准备 RAG 索引');
  const paperId = `paper_${timestampId()}`;
  const library = await ensureRagIndex();
  await updateTaskProgress(task, 16, '读取 Topic 和记忆');
  const topics = await readAvailableTopics();
  const memory = await readJson(FILES.memory, {});
  const selectedTopics = topics.topics.filter((topic) => payload.selected_topics.includes(topic.topic_id));
  await updateTaskProgress(task, 25, '检索相关知识片段');
  const context = await retrieveContext(payload, selectedTopics, memory);
  const schema = path.join(SCHEMA_DIR, 'paper.schema.json');
  const prompt = [
    '你是一个严格的技术面试官，请生成一张用于语音背诵练习的中文面试试卷。',
    '你必须阅读给定的 context_chunks 摘要后，用自然语言重新设计问题，不能把标题或字段直接包装成问题。',
    '输出前先自检：题量必须正确，问题必须具体，不符合要求就先在内部修正后再输出，不要把半成品交出来。',
    '要求：',
    `1. 总问题数必须等于 ${payload.question_count}。`,
    `2. 试卷模式是 ${payload.mode}。normal=独立题；followup=围绕 Topic 生成 3-5 个连续追问链；mixed=两者混合。`,
    '3. 每题必须包含 topic、source_type、difficulty、question、expected_points、reference_answer、source_chunks。',
    '4. source_type 只能是 bagu_local、note_readonly、expanded。expanded 表示知识库没覆盖但面试高频的补充知识。',
    '5. 笔记/ 目录只读，不要提出写入笔记/ 的动作。',
    '6. 题目应根据用户选择的 Topic 和记忆中的薄弱点加权。',
    '7. 追问链每条包含 3-5 个问题，难度逐步深入，并记录 chain_goal。',
    '8. 问题必须像真实面试官提问，避免“请说明某标题”这种机械模板。',
    '9. 问题必须是具体八股知识点，不要开放式、场景式、项目方案式问题。',
    '10. 禁止使用这类问法：你会怎么、你怎么、如何判断、优先考虑哪些、线上遇到、接口服务、项目中、方案、权衡、排查、设计一个。',
    '11. 优先生成这类明确问题：什么是 X；X 和 Y 的区别；为什么会有 X；X 的底层机制是什么；X 在什么条件下成立；候选人说法哪里不严谨。',
    '12. 每个问题只考一个核心知识点，不要把多个知识点组合成一个大题。',
    '13. 参考合格题型：CPython 的 GIL 为什么会限制 CPU 密集型多线程？range() 为什么不能直接说成迭代器？Kafka 的 ISR 机制解决的核心问题是什么？',
    '14. 禁止不合格题型：请概括 Python 这门语言；请从多个角度分析 Docker；你会如何在项目中设计消息队列方案。',
    '请输出 JSON，必须符合 schema。',
    JSON.stringify({
      request: payload,
      selected_topics: selectedTopics,
      memory_summary: summarizeMemory(memory),
      context_chunks: context
    })
  ].join('\n\n');
  let generationError = null;
  await updateTaskProgress(task, 35, 'Codex 生成试卷');
  let generated = await runCodexJson(prompt, schema, task).catch((error) => {
    generationError = error;
    return null;
  });
  if (!generated) {
    await updateTaskProgress(task, 55, 'Codex 宽松 JSON 重试');
    generated = await runCodexJsonLoose(`${prompt}\n\n只输出一个 JSON 对象，不要 Markdown 代码块，不要解释文字。`, task).catch((error) => {
      generationError = error;
      return null;
    });
  }
  let paper = null;
  if (generated) {
    await updateTaskProgress(task, 72, '校验试卷结构');
    paper = await normalizePaperWithRepair(generated, payload, paperId, prompt, schema, task).catch((error) => {
      generationError = error;
      return null;
    });
  }
  if (!paper) {
    try {
      await updateTaskProgress(task, 78, '尝试复用题库缓存');
      generated = await buildPaperFromQuestionBank(payload, paperId, selectedTopics);
      paper = normalizePaper(generated, payload, paperId);
    } catch (cacheError) {
      const codexMessage = generationError ? ` Codex error: ${generationError.message || String(generationError)}` : '';
      throw new Error(`${cacheError.message || String(cacheError)}.${codexMessage}`);
    }
  }
  paper.generation_method = generated.generation_method || (generated.from_question_bank ? 'question_bank' : 'codex_rag');
  if (!generated.from_question_bank) {
    await updateTaskProgress(task, 84, '检查题目风格');
    paper = await repairPaperStyleIfNeeded(paper, payload, prompt, schema, task);
  }
  if (generationError && paper.generation_method === 'question_bank') {
    paper.generation_warning = generationError.message || String(generationError);
  }
  await updateTaskProgress(task, 94, '保存试卷和题库缓存');
  paper.context_chunk_ids = context.map((chunk) => chunk.chunk_id);
  await writePaper(paper);
  await updateQuestionBankFromPaper(paper);
  return { paper_id: paper.paper_id, question_count: countPaperQuestions(paper) };
}

async function taskGradePaper(payload, task = null) {
  await updateTaskProgress(task, 10, '读取试卷答案');
  const paper = await readPaper(payload.paper_id);
  assertPaperFullyAnswered(paper);
  const schema = path.join(SCHEMA_DIR, 'grade.schema.json');
  const prompt = [
    '你是一个严格但建设性的中文技术面试评分官。',
    '请根据每题的参考答案和 expected_points，对用户回答进行评分。',
    '要求：',
    '1. 每题 score 为 0-100。',
    '2. level 为 correct、partial 或 wrong，且与 score 区间一致：wrong=0-39，partial=40-79，correct=80-100。',
    '3. 如果回答命中至少一个核心点，但不完整或表达有偏差，应给 partial，分数至少 40。',
    '4. 擦边正确（只命中少量要点、深度不够）建议给 40-55，不要给最低分。',
    '5. partial 内部分层：40-55=擦边；56-69=部分正确；70-79=接近正确但仍有关键缺漏。',
    '6. 只有明显答非所问、核心点基本缺失、或存在严重错误时才给 wrong。',
    '7. 有实质错误时在 incorrect_points 明确写出。',
    '8. covered_points/missed_points 要与 score 对齐，不能自相矛盾。',
    '9. 指出 covered_points、missed_points、incorrect_points。',
    '10. 给出 better_answer 和 feedback。',
    '11. 对追问链给出 chain_score、breakdown_question_index、weakest_follow_up_type。',
    '12. 总结可沉淀到八股/ 的 expanded 或 note_readonly 高频薄弱知识点；不要写入笔记/。',
    '请输出 JSON，必须符合 schema。',
    JSON.stringify({ paper })
  ].join('\n\n');
  await updateTaskProgress(task, 35, 'Codex 评分');
  let grade = await runCodexJson(prompt, schema, task).catch(() => null);
  await updateTaskProgress(task, 75, '整理评分结果');
  if (!grade) grade = buildFallbackGrade(paper);
  paper.grade = normalizeGrade(grade, paper);
  paper.status = 'graded';
  paper.updated_at = new Date().toISOString();
  paper.feedback_file = await writeFeedback(paper);
  await updateTaskProgress(task, 88, '更新记忆和反馈文件');
  await writePaper(paper);
  await updateMemoryFromPaper(paper);
  await writeKnowledgeCandidates(paper);
  return { paper_id: paper.paper_id, average_score: paper.grade.average_score, feedback_file: paper.feedback_file };
}

function assertPaperFullyAnswered(paper) {
  const questions = flattenPaperQuestions(paper);
  const missing = questions
    .filter((question) => !String(paper.answers?.[question.question_id] || '').trim())
    .map((question) => question.question_id);
  if (missing.length) {
    throw new Error(`试卷尚未完整作答，未作答题目 ${missing.length}/${questions.length}：${missing.slice(0, 8).join(', ')}`);
  }
}

async function runCodexJson(prompt, schemaPath, task = null) {
  return new Promise((resolve, reject) => {
    assertTaskNotCancelled(task);
    const outputFile = path.join('/tmp', `interview-trainer-codex-${randomUUID()}.json`);
    const args = [
      'exec',
      '--model',
      CODEX_MODEL,
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outputFile,
      '-'
    ];
    const child = spawn('codex', args, { cwd: REPO_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    if (task) activeTaskProcesses.set(task.task_id, child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Codex task timed out'));
    }, 12 * 60 * 1000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (task) activeTaskProcesses.delete(task.task_id);
      reject(error);
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (task) activeTaskProcesses.delete(task.task_id);
      if (task?.cancel_requested) return reject(new Error('Task cancelled'));
      if (code !== 0) return reject(new Error(stderr || `codex exited with code ${code}`));
      let finalText = stdout;
      try {
        finalText = await fs.readFile(outputFile, 'utf8');
        await fs.unlink(outputFile).catch(() => {});
      } catch {}
      const parsed = parseJsonFromText(finalText) || parseJsonFromText(stdout);
      if (!parsed) return reject(new Error(`Codex did not return JSON: ${stdout.slice(0, 500)}`));
      resolve(parsed);
    });
    child.stdin.end(prompt);
  });
}

async function runCodexJsonLoose(prompt, task = null) {
  return new Promise((resolve, reject) => {
    assertTaskNotCancelled(task);
    const outputFile = path.join('/tmp', `interview-trainer-codex-${randomUUID()}.json`);
    const args = [
      'exec',
      '--model',
      CODEX_MODEL,
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--output-last-message',
      outputFile,
      '-'
    ];
    const child = spawn('codex', args, { cwd: REPO_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    if (task) activeTaskProcesses.set(task.task_id, child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Codex loose task timed out'));
    }, 12 * 60 * 1000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (task) activeTaskProcesses.delete(task.task_id);
      reject(error);
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (task) activeTaskProcesses.delete(task.task_id);
      if (task?.cancel_requested) return reject(new Error('Task cancelled'));
      if (code !== 0) return reject(new Error(stderr || `codex exited with code ${code}`));
      let finalText = stdout;
      try {
        finalText = await fs.readFile(outputFile, 'utf8');
        await fs.unlink(outputFile).catch(() => {});
      } catch {}
      const parsed = parseJsonFromText(finalText) || parseJsonFromText(stdout);
      if (!parsed) return reject(new Error(`Codex loose mode did not return JSON: ${stdout.slice(0, 500)}`));
      resolve(parsed);
    });
    child.stdin.end(prompt);
  });
}

async function taskGenerateBaguDoc(payload, task = null) {
  await updateTaskProgress(task, 8, '准备文档生成参数');
  const keywords = payload.keywords.map((item) => String(item).trim()).filter(Boolean);
  const questionCount = Number(payload.question_count);
  const title = sanitizeFileTitle(payload.target_title || `${keywords.join('_')}_高频面试知识`);
  const target = await uniqueBaguDocPath(`${title}.md`);
  await updateTaskProgress(task, 18, '检索相关知识片段');
  const library = await ensureRagIndex();
  const pseudoTopics = keywords.map((keyword) => ({ topic_id: topicId(keyword), name: keyword, aliases: [keyword] }));
  const context = await retrieveContext({
    selected_topics: pseudoTopics.map((topic) => topic.topic_id),
    topic_weights: {},
    question_count: Math.min(50, questionCount),
    mode: 'normal',
    keywords
  }, pseudoTopics, await readJson(FILES.memory, {}));
  const schema = path.join(SCHEMA_DIR, 'bagu-doc.schema.json');
  const prompt = [
    '你是一个资深技术面试资料整理者，请生成一份可直接写入 八股/ 的 Markdown 面试知识文档。',
    '要求：',
    `1. 技术栈关键词：${keywords.join('、')}。`,
    `2. 高频问题数量必须是 ${questionCount} 条。`,
    '3. 输出内容要是完整 Markdown 文档，不要 JSON 以外的解释。',
    '4. 结构包含：技术栈总览、高频问题、参考答案、追问方向、易错点、面试表达建议。',
    '5. 可以参考 context_chunks，也可以补充通用高频面试知识。',
    '6. 笔记/ 是只读来源，不能要求修改笔记/。',
    '请输出 JSON，必须符合 schema，其中 markdown 字段是完整文档。',
    JSON.stringify({ keywords, question_count: questionCount, context_chunks: context, known_files: library.files })
  ].join('\n\n');
  await updateTaskProgress(task, 40, 'Codex 生成八股文档');
  const generated = await runCodexJson(prompt, schema, task);
  await updateTaskProgress(task, 78, '写入八股文档');
  const markdown = normalizeMarkdownDoc(generated.markdown, keywords, questionCount);
  await fs.writeFile(target, markdown, 'utf8');
  await updateTaskProgress(task, 88, '自动更新 RAG 索引');
  const rebuilt = await rebuildLocalIndexes(await readAvailableTopics());
  return {
    file: path.relative(REPO_DIR, target),
    question_count: questionCount,
    rag_rebuilt: true,
    chunks_count: rebuilt.chunks.length
  };
}

function parseJsonFromText(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
  }
  return null;
}

async function rebuildLocalIndexes(topicsInput = null, options = {}) {
  const library = await scanKnowledgeBase();
  const topics = topicsInput || await readAvailableTopics(library);
  const chunks = buildChunks(library.sections, topics.topics || []);
  const topicIndex = buildTopicIndex(chunks);
  const sourceSignature = hash(JSON.stringify(library.files.map((file) => [file.path, file.mtime_ms])));
  if (options.writeTopics) {
    await writeJson(FILES.topics, normalizeTopics(topics));
  }
  await writeJson(FILES.chunks, { version: 1, source_signature: sourceSignature, updated_at: new Date().toISOString(), chunks });
  await writeJson(FILES.topicIndex, { version: 1, updated_at: new Date().toISOString(), topics: topicIndex });
  if (!existsSync(FILES.questionBank)) {
    await writeJson(FILES.questionBank, { version: 1, updated_at: new Date().toISOString(), questions: [] });
  }
  return { ...library, chunks };
}

async function ensureRagIndex() {
  if (!existsSync(FILES.chunks) || !existsSync(FILES.topicIndex)) {
    return rebuildLocalIndexes();
  }
  const library = await scanKnowledgeBase();
  const chunksData = await readJson(FILES.chunks, null);
  const currentSignature = hash(JSON.stringify(library.files.map((file) => [file.path, file.mtime_ms])));
  if (!chunksData || chunksData.source_signature !== currentSignature) {
    const rebuilt = await rebuildLocalIndexes();
    rebuilt.source_signature = currentSignature;
    return rebuilt;
  }
  return { ...library, chunks: chunksData.chunks || [] };
}

async function ensureLocalIndexes() {
  if (!existsSync(FILES.chunks) || !existsSync(FILES.topicIndex) || !existsSync(FILES.questionBank)) {
    return rebuildLocalIndexes();
  }
  return ensureRagIndex();
}

function buildChunks(sections, topics) {
  const topicNames = new Map(topics.map((topic) => [topic.topic_id, topic.name]));
  const chunks = [];
  for (const section of sections) {
    const text = compact(section.content);
    if (text.length < 80) continue;
    const parts = splitIntoChunkTexts(text, 1400);
    parts.forEach((part, index) => {
      const topic_ids = section.topic_ids?.length ? section.topic_ids : inferTopicIds(`${section.file} ${section.path.join(' ')} ${part}`);
      chunks.push({
        chunk_id: hash(`${section.section_id}:${index}:${part.slice(0, 80)}`),
        section_id: section.section_id,
        source_type: section.source_type,
        file: section.file,
        readonly: section.readonly,
        path: section.path,
        title: section.title,
        topic_ids,
        topics: topic_ids.map((id) => topicNames.get(id) || id),
        keywords: extractKeywords(`${section.path.join(' ')} ${part}`),
        summary: part.slice(0, 260),
        content: part,
        used_count: 0,
        last_used_at: null
      });
    });
  }
  return chunks;
}

function splitIntoChunkTexts(text, maxLength) {
  const sentences = String(text).split(/(?<=[。！？!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength && current.length > 120) {
      chunks.push(current.trim());
      current = '';
    }
    current += `${sentence} `;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function buildTopicIndex(chunks) {
  const index = {};
  for (const chunk of chunks) {
    for (const topicIdValue of chunk.topic_ids || []) {
      index[topicIdValue] ||= [];
      index[topicIdValue].push(chunk.chunk_id);
    }
  }
  return index;
}

async function readIndexSummary() {
  const topics = await readAvailableTopics();
  const chunks = await readJson(FILES.chunks, { chunks: [] });
  const questionBank = await readJson(FILES.questionBank, { questions: [] });
  return {
    topics_count: topics.topics.length,
    chunks_count: chunks.chunks.length,
    question_bank_count: questionBank.questions.length,
    topics_recorded: existsSync(FILES.topics),
    writable_sources: ['八股'],
    readonly_sources: ['笔记']
  };
}

async function retrieveContext(payload, selectedTopics, memory) {
  const chunksData = await readJson(FILES.chunks, { chunks: [] });
  const chunks = chunksData.chunks || [];
  const selectedIds = new Set(selectedTopics.map((topic) => topic.topic_id).concat(payload.selected_topics || []));
  const keywords = [
    ...selectedTopics.flatMap((topic) => [topic.name, ...(topic.aliases || [])]),
    ...(payload.keywords || [])
  ].map((item) => String(item).toLowerCase()).filter(Boolean);
  const weakTopicIds = new Set(Object.entries(memory.topics || {})
    .filter(([, item]) => ['weak', 'unstable'].includes(item.mastery_level))
    .map(([id]) => id));
  const weakKnowledgeSignals = buildWeakKnowledgeSignals(memory, selectedIds);
  const weakChainSignals = buildWeakChainSignals(memory, selectedIds);
  const limit = clamp(Number(payload.rag_context_limit || 14), 8, 40);
  const randomness = clamp(Number(payload.randomness ?? 0.25), 0, 1);
  return chunks
    .map((chunk) => ({
      chunk,
      score: scoreChunk(
        chunk,
        selectedIds,
        keywords,
        weakTopicIds,
        payload.topic_weights || {},
        randomness,
        weakKnowledgeSignals,
        weakChainSignals
      )
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ chunk }) => ({
      chunk_id: chunk.chunk_id,
      source_type: chunk.source_type,
      file: chunk.file,
      path: chunk.path,
      topic_ids: chunk.topic_ids,
      keywords: chunk.keywords,
      summary: chunk.summary,
      excerpt: buildChunkExcerpt(chunk, keywords, weakKnowledgeSignals, weakChainSignals)
    }));
}

function scoreChunk(chunk, selectedIds, keywords, weakTopicIds, topicWeights, randomness, weakKnowledgeSignals = [], weakChainSignals = []) {
  let score = 0;
  const topicIds = chunk.topic_ids || [];
  if (topicIds.some((id) => selectedIds.has(id))) score += 40;
  for (const id of topicIds) {
    if (topicWeights[id] === 'focus') score += 20;
    if (topicWeights[id] === 'weak' || weakTopicIds.has(id)) score += 25;
  }
  const haystack = `${chunk.file} ${chunk.path.join(' ')} ${chunk.keywords.join(' ')} ${chunk.content}`.toLowerCase();
  for (const keyword of keywords) {
    if (keyword && haystack.includes(keyword)) score += 8;
  }
  if (chunk.source_type === 'bagu_local') score += 6;
  if (chunk.source_type === 'note_readonly') score += 3;
  const chunkKeywords = new Set([...(chunk.keywords || []), ...extractKeywords(`${chunk.title || ''} ${chunk.content || ''}`).slice(0, 20)]);
  for (const signal of weakKnowledgeSignals) {
    if (signal.topic_id && topicIds.includes(signal.topic_id)) score += 6;
    if (signal.source_chunks.has(chunk.chunk_id)) score += 28 + Math.round(signal.priority / 8);
    const overlap = overlapCount(chunkKeywords, signal.keywords);
    if (overlap > 0) score += Math.min(18, overlap * 4 + Math.round(signal.priority / 20));
  }
  for (const signal of weakChainSignals) {
    if (signal.topic_id && topicIds.includes(signal.topic_id)) score += 5;
    const overlap = overlapCount(chunkKeywords, signal.keywords);
    if (overlap > 0) score += Math.min(12, overlap * 3 + Math.round(signal.priority / 25));
  }
  score += Math.random() * 20 * randomness;
  return score;
}

async function scanKnowledgeBase() {
  const files = [];
  const sections = [];
  for (const [kind, dir] of [['bagu', BAGU_DIR], ['note', NOTE_DIR]]) {
    if (!existsSync(dir)) continue;
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.md'));
    for (const name of names) {
      const filePath = path.join(dir, name);
      const stat = await fs.stat(filePath);
      const relPath = path.relative(REPO_DIR, filePath);
      const content = await fs.readFile(filePath, 'utf8');
      files.push({ kind, path: relPath, readonly: kind === 'note', line_count: content.split('\n').length, mtime_ms: stat.mtimeMs });
      for (const section of splitMarkdownSections(content, relPath, kind)) {
        section.topic_ids = inferTopicIds(`${name}\n${section.path.join(' ')}\n${section.content}`);
        sections.push(section);
      }
    }
  }
  return { files, sections };
}

function splitMarkdownSections(content, relPath, kind) {
  const lines = content.split('\n');
  const sections = [];
  const stack = [];
  let current = null;
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = inFence ? null : /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (current && current.content.trim().length > 80) sections.push(current);
      const level = match[1].length;
      stack[level - 1] = match[2].replace(/\[TOC\]/g, '').trim();
      stack.length = level;
      current = {
        section_id: hash(`${relPath}:${index}:${match[2]}`),
        source_type: kind === 'bagu' ? 'bagu_local' : 'note_readonly',
        file: relPath,
        readonly: kind === 'note',
        level,
        path: stack.filter(Boolean),
        title: match[2].trim(),
        start_line: index + 1,
        content: ''
      };
      continue;
    }
    if (current) current.content += `${line}\n`;
  }
  if (current && current.content.trim().length > 80) sections.push(current);
  return sections.slice(0, 1000);
}

async function buildFallbackTopics() {
  const library = await scanKnowledgeBase().catch(() => ({ sections: [], files: [] }));
  return buildFallbackTopicsFromLibrary(library);
}

async function readAvailableTopics(library = null) {
  const recorded = await readJson(FILES.topics, null);
  if (recorded?.topics?.length) return normalizeTopics(recorded);
  const baseLibrary = library || await scanKnowledgeBase().catch(() => ({ sections: [], files: [] }));
  return buildFallbackTopicsFromLibrary(baseLibrary);
}

function buildFallbackTopicsFromLibrary(library) {
  const topics = [];
  for (const known of KNOWN_TOPICS) {
    const matchedSections = library.sections.filter((section) => inferTopicIds(`${section.file}\n${section.path.join(' ')}\n${section.content}`).includes(topicId(known.name)));
    const matchedFiles = [...new Set(matchedSections.map((section) => section.file))];
    if (matchedSections.length || ['C++'].includes(known.name)) {
      topics.push({
        topic_id: topicId(known.name),
        name: known.name,
        aliases: known.aliases,
        category: known.category,
        confidence: matchedSections.length ? 0.9 : 0.35,
        enabled: true,
        can_write_back_to_bagu: true,
        source_files: matchedFiles,
        covered_sections: matchedSections.slice(0, 30).map((section) => ({
          section_id: section.section_id,
          file: section.file,
          path: section.path,
          source_type: section.source_type
        }))
      });
    }
  }
  return normalizeTopics({ topics });
}

function inferTopicIds(text) {
  const lower = text.toLowerCase();
  return KNOWN_TOPICS
    .filter((topic) => topic.aliases.some((alias) => lower.includes(alias.toLowerCase())) || lower.includes(topic.name.toLowerCase()))
    .map((topic) => topicId(topic.name));
}

function normalizeTopics(input) {
  const seen = new Set();
  const topics = (input.topics || []).map((topic) => {
    const id = topic.topic_id || topicId(topic.name);
    return {
      topic_id: id,
      name: topic.name || id,
      aliases: Array.isArray(topic.aliases) ? topic.aliases : [],
      category: topic.category || 'general',
      confidence: Number(topic.confidence || 0.7),
      enabled: topic.enabled !== false,
      can_write_back_to_bagu: topic.can_write_back_to_bagu !== false,
      source_files: Array.isArray(topic.source_files) ? topic.source_files : [],
      covered_sections: Array.isArray(topic.covered_sections) ? topic.covered_sections : []
    };
  }).filter((topic) => {
    if (!topic.name || seen.has(topic.topic_id)) return false;
    seen.add(topic.topic_id);
    return true;
  });
  return { version: 1, parser_version: TOPIC_INDEX_VERSION, updated_at: new Date().toISOString(), topics };
}

function questionsToChains(questions) {
  const chains = [];
  let index = 0;
  while (index < questions.length) {
    const size = Math.min(5, Math.max(3, questions.length - index));
    const slice = questions.slice(index, index + size).map((question, offset) => ({
      ...question,
      question: offset === 0 ? question.question : `追问 ${offset + 1}：${question.question}`
    }));
    chains.push({
      chain_id: `chain_${chains.length + 1}_${hash(slice.map((q) => q.question_id).join(':')).slice(0, 8)}`,
      topic: slice[0]?.topic || 'General',
      root_knowledge_point: slice[0]?.question || '综合追问',
      chain_goal: '模拟面试官围绕同一技术栈逐层追问。',
      difficulty_progression: ['basic', 'medium', 'hard'],
      questions: slice
    });
    index += size;
  }
  return chains;
}

async function buildPaperFromQuestionBank(payload, paperId, selectedTopics) {
  if (payload.reuse_cached_questions === false) {
    throw new Error('Codex failed to generate a paper and cached question reuse is disabled');
  }
  const bank = await readJson(FILES.questionBank, { questions: [] });
  const selectedIds = new Set(selectedTopics.map((topic) => topic.topic_id).concat(payload.selected_topics || []));
  const pool = (bank.questions || [])
    .filter((question) => question.quality_status !== 'bad_question')
    .filter((question) => !selectedIds.size || selectedIds.has(question.topic_id) || selectedIds.has(topicId(question.topic || '')))
    .sort((a, b) => (a.used_count || 0) - (b.used_count || 0));
  if (pool.length < Number(payload.question_count)) {
    throw new Error(`Codex failed and question bank has only ${pool.length} reusable questions for selected topics`);
  }
  const questions = pool.slice(0, Number(payload.question_count)).map((question, index) => ({
    ...question,
    question_id: `q_${index + 1}_${hash(`${paperId}:${question.question}`).slice(0, 8)}`
  }));
  if (payload.mode === 'followup') {
    return { paper_id: paperId, generation_method: 'question_bank', from_question_bank: true, questions: [], chains: questionsToChains(questions) };
  }
  if (payload.mode === 'mixed') {
    const split = Math.floor(questions.length / 2);
    return { paper_id: paperId, generation_method: 'question_bank', from_question_bank: true, questions: questions.slice(0, split), chains: questionsToChains(questions.slice(split)) };
  }
  return { paper_id: paperId, generation_method: 'question_bank', from_question_bank: true, questions, chains: [] };
}

async function updateQuestionBankFromPaper(paper) {
  const bank = await readJson(FILES.questionBank, { version: 1, questions: [] });
  const byHash = new Map((bank.questions || []).map((question) => [hash(question.question), question]));
  for (const question of flattenPaperQuestions(paper)) {
    const key = hash(question.question);
    const existing = byHash.get(key) || {};
    byHash.set(key, {
      ...existing,
      ...question,
      bank_id: existing.bank_id || `bank_${key.slice(0, 12)}`,
      original_question_id: question.question_id,
      quality_status: existing.quality_status || 'good',
      used_count: (existing.used_count || 0) + 1,
      last_used_at: new Date().toISOString(),
      generation_method: paper.generation_method || 'codex_rag'
    });
  }
  await writeJson(FILES.questionBank, {
    version: 1,
    updated_at: new Date().toISOString(),
    questions: [...byHash.values()]
  });
}

function normalizePaper(input, payload, paperId) {
  const paper = {
    paper_id: input.paper_id || paperId,
    status: 'ready',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    request: payload,
    mode: payload.mode,
    question_count: Number(payload.question_count),
    selected_topics: payload.selected_topics,
    questions: Array.isArray(input.questions) ? input.questions : [],
    chains: Array.isArray(input.chains) ? input.chains : [],
    answers: {},
    grade: null,
    generation_method: input.generation_method || 'codex_rag'
  };
  let flat = flattenPaperQuestions(paper);
  if (flat.length !== paper.question_count) {
    throw new Error(`Generated paper question count mismatch: expected ${paper.question_count}, got ${flat.length}`);
  }
  const seenQuestionIds = new Set();
  for (const question of flattenPaperQuestions(paper)) {
    question.topic_id ||= topicId(question.topic || 'General');
    question.question_key = buildStableQuestionKey(question, question.topic_id);
    question.question_id ||= `q_${hash(`${paper.paper_id}:${question.question_key}`).slice(0, 10)}`;
    while (seenQuestionIds.has(question.question_id)) {
      question.question_id = `q_${hash(`${paper.paper_id}:${question.question_key}:${Math.random()}`).slice(0, 10)}`;
    }
    seenQuestionIds.add(question.question_id);
    if (question.source_type === 'tech_readonly') question.source_type = 'note_readonly';
    question.source_type = ['bagu_local', 'note_readonly', 'expanded'].includes(question.source_type) ? question.source_type : 'expanded';
    question.expected_points = Array.isArray(question.expected_points) ? question.expected_points : [];
    question.source_chunks = Array.isArray(question.source_chunks) ? question.source_chunks : [];
    question.quality_flags = Array.isArray(question.quality_flags) ? question.quality_flags : [];
  }
  return paper;
}

async function normalizePaperWithRepair(generated, payload, paperId, originalPrompt, schema, task = null) {
  try {
    return normalizePaper(generated, payload, paperId);
  } catch (error) {
    const locallyRepaired = tryNormalizePaperLocally(generated, payload, paperId);
    if (locallyRepaired) return locallyRepaired;
    const repairPrompt = [
      '下面是一份试卷 JSON，但它不符合系统要求。请修复为合法 JSON。',
      `要求总问题数必须等于 ${payload.question_count}，模式必须是 ${payload.mode}。`,
      'normal 使用 questions；followup 使用 chains，每条 chain 3-5 个 questions；mixed 同时使用 questions 和 chains。',
      '每题必须包含 topic、source_type、difficulty、question、expected_points、reference_answer、source_chunks。',
      'source_type 只能是 bagu_local、note_readonly、expanded。',
      '只输出 JSON 对象，不要解释。',
      `原始错误：${error.message}`,
      '原始生成结果：',
      JSON.stringify(generated),
      '原始任务要求：',
      originalPrompt.slice(0, 12000)
    ].join('\n\n');
    const repaired = await runCodexJson(repairPrompt, schema, task).catch(() => runCodexJsonLoose(repairPrompt, task));
    return normalizePaper(repaired, payload, paperId);
  }
}

async function repairPaperStyleIfNeeded(paper, payload, originalPrompt, schema, task = null) {
  const issues = paperStyleIssues(paper);
  if (!issues.length) return paper;
  const repairPrompt = [
    '下面这份试卷的问题太开放或组合性太强，请改写为更具体的八股面试题。',
    '硬性要求：',
    '1. 保持总问题数不变。',
    '2. 保持 paper 的 mode 结构不变：normal 仍用 questions；followup/mixed 保持 chains 结构。',
    '3. 每个问题只考一个核心知识点。',
    '4. 禁止开放式问法：你会怎么、你怎么、如何判断、优先考虑哪些、线上遇到、接口服务、项目中、方案、权衡、排查、设计一个。',
    '5. 避免“概括 Python 这门语言”这种过大问题。',
    '6. 改成明确可背诵的问题，例如：GIL 为什么会影响 CPU 密集型多线程？list 和 tuple 的可变性区别是什么？range 返回的是迭代器吗？',
    '7. 同步修正 expected_points 和 reference_answer。',
    '8. 只输出 JSON 对象。',
    `风格问题：${issues.join('；')}`,
    '原试卷：',
    JSON.stringify(paper),
    '原始生成任务：',
    originalPrompt.slice(0, 8000)
  ].join('\n\n');
  const repaired = await runCodexJson(repairPrompt, schema, task).catch(() => runCodexJsonLoose(repairPrompt, task));
  const normalized = normalizePaper(repaired, payload, paper.paper_id);
  const remaining = paperStyleIssues(normalized);
  if (remaining.length) {
    throw new Error(`Generated paper still has open-ended questions: ${remaining.slice(0, 5).join('; ')}`);
  }
  return normalized;
}

function paperStyleIssues(paper) {
  const badPatterns = [
    /你会怎么/,
    /你怎么/,
    /你会如何/,
    /如何判断/,
    /优先考虑哪些/,
    /线上/,
    /接口服务/,
    /项目中/,
    /方案/,
    /权衡/,
    /排查/,
    /设计一个/,
    /概括.*这门语言/,
    /从.*几个角度/,
    /结合.*展开/
  ];
  const issues = [];
  for (const question of flattenPaperQuestions(paper)) {
    const text = String(question.question || '');
    const matched = badPatterns.find((pattern) => pattern.test(text));
    if (matched) issues.push(`${question.question_id || question.topic || 'question'} contains ${matched}`);
    const separators = (text.match(/[，、；]/g) || []).length;
    if (separators >= 6 && text.length > 85) issues.push(`${question.question_id || question.topic || 'question'} is too composite`);
  }
  return issues;
}

function buildFallbackGrade(paper) {
  const reviews = flattenPaperQuestions(paper).map((question) => {
    const answer = paper.answers?.[question.question_id] || '';
    const expected = question.expected_points || [];
    const covered = expected.filter((point) => isPointCovered(answer, point));
    const missing = expected.filter((point) => !covered.includes(point));
    const coverageRatio = covered.length / Math.max(expected.length, 1);
    const referenceOverlap = tokenOverlapRatio(answer, question.reference_answer || '');
    const answerQuality = Math.min(1, Math.log2(String(answer).trim().length + 1) / 7);
    const baseScore = coverageRatio * 65 + referenceOverlap * 20 + answerQuality * 15;
    let score = Math.round(baseScore);
    if (coverageRatio > 0 && score < 40) score = 40;
    if (coverageRatio >= 0.25 && score < 50) score = 50;
    if (coverageRatio >= 0.5 && score < 60) score = 60;
    score = clamp(score, 0, 100);
    const level = scoreLevel(score);
    return {
      question_id: question.question_id,
      score,
      level,
      covered_points: covered,
      missed_points: missing,
      incorrect_points: [],
      feedback: level === 'correct'
        ? '回答覆盖较完整。'
        : level === 'partial'
          ? '回答有部分正确点，但仍需补充关键机制和边界条件。'
          : '回答与关键要点匹配较低，请聚焦定义、机制和典型追问点。',
      better_answer: question.reference_answer || '',
      follow_up_question: question.follow_up_direction || ''
    };
  });
  return { reviews, chain_reviews: [], knowledge_candidates: [], summary: '规则兜底评分，建议稍后使用 Codex 重新评分。' };
}

function normalizeGrade(input, paper) {
  const reviews = Array.isArray(input.reviews) ? input.reviews : [];
  const ids = new Set(flattenPaperQuestions(paper).map((question) => question.question_id));
  const normalized = reviews.filter((review) => ids.has(review.question_id)).map((review) => ({
    question_id: review.question_id,
    score: clamp(Number(review.score || 0), 0, 100),
    level: ['correct', 'partial', 'wrong'].includes(review.level) ? review.level : scoreLevel(review.score),
    covered_points: arrayOfStrings(review.covered_points),
    missed_points: arrayOfStrings(review.missed_points),
    incorrect_points: arrayOfStrings(review.incorrect_points),
    feedback: String(review.feedback || ''),
    better_answer: String(review.better_answer || ''),
    follow_up_question: String(review.follow_up_question || '')
  })).map(calibrateReviewScore);
  const questionMap = new Map(normalized.map((review) => [review.question_id, review]));
  for (const question of flattenPaperQuestions(paper)) {
    if (!questionMap.has(question.question_id)) {
      normalized.push(buildFallbackGrade({ ...paper, questions: [question], chains: [] }).reviews[0]);
    }
  }
  const chainIds = new Set((paper.chains || []).map((chain) => chain.chain_id));
  const normalizedChains = (Array.isArray(input.chain_reviews) ? input.chain_reviews : [])
    .filter((review) => chainIds.has(review.chain_id))
    .map((review) => ({
      chain_id: review.chain_id,
      chain_score: clamp(Number(review.chain_score || 0), 0, 100),
      breakdown_question_index: clamp(Number(review.breakdown_question_index || 0), 0, 20),
      weakest_follow_up_type: String(review.weakest_follow_up_type || ''),
      feedback: String(review.feedback || '')
    }));
  const average = normalized.reduce((sum, review) => sum + review.score, 0) / Math.max(normalized.length, 1);
  return {
    average_score: Math.round(average),
    reviews: normalized,
    chain_reviews: normalizedChains,
    topic_summary: input.topic_summary || {},
    knowledge_candidates: Array.isArray(input.knowledge_candidates) ? input.knowledge_candidates : [],
    summary: String(input.summary || '')
  };
}

async function updateMemoryFromPaper(paper) {
  const memory = await readJson(FILES.memory, {});
  memory.version = 1;
  memory.updated_at = new Date().toISOString();
  memory.topics ||= {};
  memory.knowledge ||= {};
  memory.questions ||= {};
  memory.chains ||= {};
  const reviewById = new Map(paper.grade.reviews.map((review) => [review.question_id, review]));
  const chainReviewById = new Map((paper.grade.chain_reviews || []).map((review) => [review.chain_id, review]));
  for (const question of flattenPaperQuestions(paper)) {
    const review = reviewById.get(question.question_id);
    if (!review) continue;
    const topicIdValue = question.topic_id || topicId(question.topic || 'General');
    const questionKey = question.question_key || buildStableQuestionKey(question, topicIdValue);
    const knowledgeId = hash(`${topicIdValue}:${questionKey}`);
    updateStats(memory.topics, topicIdValue, review.score, { name: question.topic || topicIdValue });
    updateStats(memory.knowledge, knowledgeId, review.score, {
      topic_id: topicIdValue,
      topic: question.topic,
      source_type: question.source_type,
      question_key: questionKey,
      question: question.question,
      expected_points: question.expected_points || [],
      source_chunks: question.source_chunks || [],
      last_feedback: review.feedback,
      can_write_back_to_bagu: question.source_type !== 'note_readonly'
    });
    updateStats(memory.questions, questionKey, review.score, {
      topic_id: topicIdValue,
      topic: question.topic,
      source_type: question.source_type,
      question_key: questionKey,
      last_question_id: question.question_id,
      question: question.question,
      last_answer: paper.answers?.[question.question_id] || '',
      expected_points: question.expected_points || [],
      source_chunks: question.source_chunks || [],
      last_feedback: review.feedback
    });
  }
  for (const chain of paper.chains || []) {
    const chainReviews = chain.questions.map((question) => reviewById.get(question.question_id)).filter(Boolean);
    if (!chainReviews.length) continue;
    const score = Math.round(chainReviews.reduce((sum, review) => sum + review.score, 0) / chainReviews.length);
    const chainReview = chainReviewById.get(chain.chain_id);
    updateStats(memory.chains, chain.chain_id, score, {
      topic: chain.topic,
      topic_id: topicId(chain.topic || 'General'),
      root_knowledge_point: chain.root_knowledge_point,
      breakdown_question_index: chainReview?.breakdown_question_index || 0,
      weakest_follow_up_type: chainReview?.weakest_follow_up_type || '',
      last_chain_feedback: chainReviews.map((review) => review.feedback).join('\n')
    });
  }
  await writeJson(FILES.memory, memory);
}

function updateStats(bucket, id, score, patch) {
  const current = bucket[id] || {
    attempt_count: 0,
    correct_count: 0,
    wrong_count: 0,
    streak_correct: 0,
    streak_wrong: 0,
    best_score: 0,
    last_score: 0,
    recent_scores: []
  };
  current.attempt_count += 1;
  current.last_score = score;
  current.best_score = Math.max(current.best_score, score);
  current.recent_scores = [...(current.recent_scores || []), score].slice(-5);
  if (score >= 85) {
    current.correct_count += 1;
    current.streak_correct += 1;
    current.streak_wrong = 0;
  } else if (score < 60) {
    current.wrong_count += 1;
    current.streak_wrong += 1;
    current.streak_correct = 0;
  } else {
    current.streak_correct = 0;
    current.streak_wrong = 0;
  }
  current.mastery_level = masteryLevel(current);
  current.next_review_priority = reviewPriority(current);
  current.updated_at = new Date().toISOString();
  bucket[id] = { ...current, ...patch };
}

function masteryLevel(stats) {
  if (stats.streak_correct >= 3 && stats.best_score >= 85) return 'mastered';
  if (stats.attempt_count === 0) return 'new';
  if (stats.streak_wrong >= 2 || stats.last_score < 60) return 'weak';
  if (stats.last_score < 85 || stats.wrong_count > 0) return 'unstable';
  return 'familiar';
}

function reviewPriority(stats) {
  if (stats.mastery_level === 'weak') return 100;
  if (stats.mastery_level === 'unstable') return 80;
  if (stats.mastery_level === 'new') return 60;
  if (stats.mastery_level === 'familiar') return 35;
  return 10;
}

async function writeFeedback(paper) {
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(DIRS.feedback, `${date}_${paper.paper_id}.md`);
  const reviewById = new Map(paper.grade.reviews.map((review) => [review.question_id, review]));
  const lines = [];
  lines.push(`# 试卷反馈：${paper.paper_id}`);
  lines.push('');
  lines.push(`- 时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`- 模式：${paper.mode}`);
  lines.push(`- 题量：${paper.question_count}`);
  lines.push(`- 平均分：${paper.grade.average_score}`);
  lines.push('');
  lines.push('## 总结');
  lines.push(paper.grade.summary || '本次试卷已完成评分。');
  lines.push('');
  if (paper.chains?.length) {
    lines.push('## 追问链表现');
    for (const chain of paper.chains) {
      const scores = chain.questions.map((question) => reviewById.get(question.question_id)?.score ?? 0);
      const avg = Math.round(scores.reduce((sum, score) => sum + score, 0) / Math.max(scores.length, 1));
      lines.push(`- ${chain.topic} / ${chain.root_knowledge_point}：${avg} 分`);
    }
    lines.push('');
  }
  lines.push('## 每题详情');
  for (const question of flattenPaperQuestions(paper)) {
    const review = reviewById.get(question.question_id);
    lines.push(`### ${question.topic || 'General'}：${question.question}`);
    lines.push('');
    lines.push(`- 来源：${question.source_type}`);
    lines.push(`- 得分：${review?.score ?? 0}`);
    lines.push(`- 等级：${review?.level || 'unknown'}`);
    lines.push('');
    lines.push('**你的回答**');
    lines.push('');
    lines.push(paper.answers?.[question.question_id] || '未作答');
    lines.push('');
    lines.push('**遗漏要点**');
    lines.push('');
    lines.push((review?.missed_points || []).map((point) => `- ${point}`).join('\n') || '- 无');
    lines.push('');
    lines.push('**改进答案**');
    lines.push('');
    lines.push(review?.better_answer || question.reference_answer || '');
    lines.push('');
  }
  const weak = paper.grade.reviews.filter((review) => review.score < 85);
  lines.push('## 错题与不稳定题');
  lines.push(weak.map((review) => `- ${review.question_id}：${review.score} 分，${review.feedback}`).join('\n') || '- 无');
  lines.push('');
  if (paper.grade.knowledge_candidates?.length) {
    lines.push('## 可沉淀到八股的候选知识');
    for (const item of paper.grade.knowledge_candidates) {
      lines.push(`- ${item.topic || 'General'}：${item.title || item.summary || '候选知识点'}`);
    }
  }
  await fs.writeFile(file, lines.join('\n'), 'utf8');
  return file;
}

async function writeKnowledgeCandidates(paper) {
  const candidates = paper.grade?.knowledge_candidates || [];
  for (const item of candidates) {
    const id = item.candidate_id || `cand_${hash(JSON.stringify(item)).slice(0, 10)}`;
    const file = path.join(DIRS.candidates, `${id}.md`);
    const lines = [
      `# ${item.title || item.topic || '扩展高频面试知识'}`,
      '',
      `- 来源试卷：${paper.paper_id}`,
      `- Topic：${item.topic || 'General'}`,
      '',
      item.content || item.summary || ''
    ];
    await fs.writeFile(file, lines.join('\n'), 'utf8');
  }
}

async function applyCandidate(id) {
  const candidatePath = path.join(DIRS.candidates, `${id}.md`);
  if (!existsSync(candidatePath)) throw new Error('Candidate not found');
  const content = await fs.readFile(candidatePath, 'utf8');
  const target = path.join(BAGU_DIR, '扩展高频面试知识.md');
  const block = `\n\n---\n\n${content}\n`;
  await fs.appendFile(target, block, 'utf8');
  return { ok: true, target: path.relative(REPO_DIR, target) };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cleanPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, cleanPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  if (!existsSync(filePath)) return sendText(res, 404, 'Not found');
  const ext = path.extname(filePath);
  const content = await fs.readFile(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(content);
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk.toString();
  return data ? JSON.parse(data) : {};
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

async function readPaper(paperId) {
  const file = path.join(DIRS.papers, `${paperId}.json`);
  if (!existsSync(file)) throw new Error('Paper not found');
  return readJson(file, null);
}

async function writePaper(paper) {
  await writeJson(path.join(DIRS.papers, `${paper.paper_id}.json`), paper);
}

function flattenPaperQuestions(paper) {
  return [
    ...(paper.questions || []),
    ...(paper.chains || []).flatMap((chain) => chain.questions || [])
  ];
}

function countPaperQuestions(paper) {
  return flattenPaperQuestions(paper).length;
}

function summarizeMemory(memory) {
  const weakTopics = Object.entries(memory.topics || {})
    .filter(([, item]) => ['weak', 'unstable'].includes(item.mastery_level))
    .slice(0, 20)
    .map(([id, item]) => ({ id, name: item.name, last_score: item.last_score, mastery_level: item.mastery_level }));
  const weakKnowledgePoints = Object.entries(memory.knowledge || {})
    .filter(([, item]) => ['weak', 'unstable'].includes(item.mastery_level))
    .sort((a, b) => (b[1].next_review_priority || 0) - (a[1].next_review_priority || 0))
    .slice(0, 12)
    .map(([id, item]) => ({
      id,
      topic: item.topic,
      question: item.question,
      last_score: item.last_score,
      mastery_level: item.mastery_level
    }));
  const weakChains = Object.entries(memory.chains || {})
    .filter(([, item]) => ['weak', 'unstable'].includes(item.mastery_level))
    .sort((a, b) => (b[1].next_review_priority || 0) - (a[1].next_review_priority || 0))
    .slice(0, 8)
    .map(([id, item]) => ({
      id,
      topic: item.topic,
      root_knowledge_point: item.root_knowledge_point,
      weakest_follow_up_type: item.weakest_follow_up_type || '',
      breakdown_question_index: item.breakdown_question_index || 0
    }));
  return { weak_topics: weakTopics, weak_knowledge_points: weakKnowledgePoints, weak_chains: weakChains };
}

function tryNormalizePaperLocally(input, payload, paperId) {
  const expectedCount = Number(payload.question_count);
  const flat = flattenInputQuestions(input).filter((question) => String(question?.question || '').trim());
  if (flat.length < expectedCount) return null;
  const trimmed = flat.slice(0, expectedCount).map((question) => ({ ...question }));
  if (payload.mode === 'followup') {
    return normalizePaper({
      ...input,
      paper_id: input.paper_id || paperId,
      questions: [],
      chains: questionsToChains(trimmed),
      generation_method: input.generation_method || 'codex_rag_local_shape_repair'
    }, payload, paperId);
  }
  if (payload.mode === 'mixed') {
    const split = Math.max(1, Math.floor(trimmed.length / 2));
    return normalizePaper({
      ...input,
      paper_id: input.paper_id || paperId,
      questions: trimmed.slice(0, split),
      chains: questionsToChains(trimmed.slice(split)),
      generation_method: input.generation_method || 'codex_rag_local_shape_repair'
    }, payload, paperId);
  }
  return normalizePaper({
    ...input,
    paper_id: input.paper_id || paperId,
    questions: trimmed,
    chains: [],
    generation_method: input.generation_method || 'codex_rag_local_shape_repair'
  }, payload, paperId);
}

function flattenInputQuestions(input) {
  return [
    ...(Array.isArray(input?.questions) ? input.questions : []),
    ...(Array.isArray(input?.chains) ? input.chains.flatMap((chain) => Array.isArray(chain?.questions) ? chain.questions : []) : [])
  ];
}

function topicId(name) {
  return name.toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || hash(name).slice(0, 8);
}

function hash(text) {
  return createHash('sha1').update(String(text)).digest('hex');
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '_' + randomUUID().slice(0, 8);
}

function compact(text) {
  return String(text).replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeQuestionText(text) {
  return String(text || '')
    .replace(/^追问\s*\d+\s*[：:]\s*/u, '')
    .replace(/^第\s*\d+\s*问\s*[：:]\s*/u, '')
    .replace(/[“”"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildStableQuestionKey(question, topicIdValue = null) {
  const stableTopicId = topicIdValue || question.topic_id || topicId(question.topic || 'General');
  return hash(`${stableTopicId}:${normalizeQuestionText(question.question || '')}`);
}

function buildChunkExcerpt(chunk, baseKeywords = [], weakKnowledgeSignals = [], weakChainSignals = []) {
  const signalKeywords = [
    ...baseKeywords,
    ...weakKnowledgeSignals.flatMap((item) => [...item.keywords].slice(0, 6)),
    ...weakChainSignals.flatMap((item) => [...item.keywords].slice(0, 4))
  ].map((item) => String(item).toLowerCase()).filter(Boolean);
  const sentences = String(chunk.content || '')
    .split(/(?<=[。！？!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!sentences.length) return chunk.summary || '';
  const ranked = sentences
    .map((sentence, index) => ({
      sentence,
      score: rankSentence(sentence, signalKeywords) - index * 0.02
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((item) => item.sentence);
  const excerpt = compact(ranked.join(' ')).slice(0, 280);
  return excerpt || String(chunk.summary || '').slice(0, 220);
}

function extractKeywords(text) {
  const words = String(text)
    .toLowerCase()
    .match(/[a-z][a-z0-9+#.-]{1,30}|[\u4e00-\u9fa5]{2,12}/g) || [];
  const stop = new Set(['这个', '如果', '什么', '如何', '为什么', '一个', '以及', '进行', '可以', '需要', '使用', '实现', '面试']);
  const counts = new Map();
  for (const word of words) {
    if (stop.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([word]) => word);
}

function rankSentence(sentence, keywords) {
  const lower = String(sentence || '').toLowerCase();
  let score = lower.length > 18 ? 1 : 0;
  for (const keyword of keywords || []) {
    if (keyword && lower.includes(keyword)) score += 3;
  }
  return score;
}

function overlapCount(left, right) {
  const leftSet = left instanceof Set ? left : new Set(left || []);
  const rightSet = right instanceof Set ? right : new Set(right || []);
  let count = 0;
  for (const value of rightSet) {
    if (leftSet.has(value)) count += 1;
  }
  return count;
}

function buildWeakKnowledgeSignals(memory, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  return Object.entries(memory.knowledge || {})
    .filter(([, item]) => ['weak', 'unstable'].includes(item.mastery_level))
    .filter(([, item]) => {
      const signalTopicId = item.topic_id || topicId(item.topic || 'General');
      return !selected.size || selected.has(signalTopicId);
    })
    .sort((a, b) => (b[1].next_review_priority || 0) - (a[1].next_review_priority || 0))
    .slice(0, 16)
    .map(([id, item]) => ({
      id,
      topic_id: item.topic_id || topicId(item.topic || 'General'),
      priority: item.next_review_priority || 0,
      source_chunks: new Set(Array.isArray(item.source_chunks) ? item.source_chunks : []),
      keywords: new Set(extractKeywords(`${item.question || ''} ${(item.expected_points || []).join(' ')} ${item.last_feedback || ''}`))
    }));
}

function buildWeakChainSignals(memory, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  return Object.entries(memory.chains || {})
    .filter(([, item]) => ['weak', 'unstable'].includes(item.mastery_level))
    .filter(([, item]) => {
      const signalTopicId = item.topic_id || topicId(item.topic || 'General');
      return !selected.size || selected.has(signalTopicId);
    })
    .sort((a, b) => (b[1].next_review_priority || 0) - (a[1].next_review_priority || 0))
    .slice(0, 10)
    .map(([id, item]) => ({
      id,
      topic_id: item.topic_id || topicId(item.topic || 'General'),
      priority: item.next_review_priority || 0,
      keywords: new Set(extractKeywords(`${item.root_knowledge_point || ''} ${item.weakest_follow_up_type || ''} ${item.last_chain_feedback || ''}`))
    }));
}

function sanitizeFileTitle(title) {
  return String(title || '高频面试知识')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || '高频面试知识';
}

async function uniqueBaguDocPath(fileName) {
  const first = path.join(BAGU_DIR, fileName);
  if (!existsSync(first)) return first;
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  return path.join(BAGU_DIR, `${base}_${timestampId()}${ext || '.md'}`);
}

function normalizeMarkdownDoc(markdown, keywords, questionCount) {
  const body = String(markdown || '').trim();
  if (!body) throw new Error('Codex returned empty markdown for bagu doc');
  const title = body.startsWith('# ') ? '' : `# ${keywords.join(' / ')} 高频面试知识\n\n`;
  const meta = [
    '<!-- generated_by: interview-trainer -->',
    `<!-- question_count: ${questionCount} -->`,
    `<!-- generated_at: ${new Date().toISOString()} -->`,
    ''
  ].join('\n');
  return `${title}${meta}${body}\n`;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function scoreLevel(score) {
  const value = Number(score || 0);
  if (value >= 80) return 'correct';
  if (value >= 40) return 'partial';
  return 'wrong';
}

function calibrateReviewScore(review) {
  const covered = review.covered_points.length;
  const missed = review.missed_points.length;
  const incorrect = review.incorrect_points.length;
  const total = Math.max(covered + missed, 1);
  const ratio = covered / total;
  let score = clamp(Number(review.score || 0), 0, 100);
  if (review.level === 'partial') {
    if (score < 40) score = 40;
    if (ratio >= 0.25 && score < 50) score = 50;
    if (ratio >= 0.5 && score < 60) score = 60;
  }
  if (review.level === 'correct' && score < 80) score = 80;
  if (review.level === 'wrong' && covered > 0 && score < 30) score = 30;
  if (incorrect >= 2) score = Math.max(0, score - 8);
  score = clamp(score, 0, 100);
  return { ...review, score, level: scoreLevel(score) };
}

function isPointCovered(answer, point) {
  const answerText = String(answer || '').toLowerCase();
  const pointText = String(point || '').toLowerCase();
  if (!answerText || !pointText) return false;
  if (answerText.includes(pointText.slice(0, Math.min(8, pointText.length)))) return true;
  const keywords = extractKeywords(pointText).filter((item) => item.length >= 2);
  if (!keywords.length) return false;
  const hits = keywords.filter((kw) => answerText.includes(kw)).length;
  return hits >= Math.max(1, Math.ceil(keywords.length * 0.4));
}

function tokenOverlapRatio(answer, reference) {
  const answerTokens = new Set(extractKeywords(answer).filter((item) => item.length >= 2));
  const refTokens = extractKeywords(reference).filter((item) => item.length >= 2);
  if (!answerTokens.size || !refTokens.length) return 0;
  const hit = refTokens.filter((token) => answerTokens.has(token)).length;
  return clamp(hit / Math.max(refTokens.length, 1), 0, 1);
}
