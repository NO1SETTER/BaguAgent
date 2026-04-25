import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  buildGeneratePaperPrompt,
  buildGradePaperPrompt,
  buildUpdateTopicConceptsPrompt
} from './task-prompts.js';

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
  agentsGuide: path.join(DIRS.memory, 'agents.md'),
  memoryEvents: path.join(DIRS.memory, 'memory_events.jsonl'),
  topicMemory: path.join(DIRS.memory, 'topic_memory.json'),
  conceptMemory: path.join(DIRS.memory, 'concept_memory.json'),
  weakMemory: path.join(DIRS.memory, 'weak_memory.json'),
  memorySummary: path.join(DIRS.memory, 'memory_summary.json'),
  tasks: path.join(DIRS.tasks, 'tasks.json'),
  taskMetrics: path.join(DIRS.tasks, 'task_metrics.json'),
  chunks: path.join(DIRS.rag, 'chunks.json'),
  topicIndex: path.join(DIRS.rag, 'topic_index.json'),
  questionBank: path.join(DIRS.rag, 'question_bank.json')
};
const TOPIC_INDEX_VERSION = 3;
const CODEX_MODEL = 'gpt-5.2';
const PAPER_CODEX_MODEL = 'gpt-5.4';
const TENCENT_ASR_SECRET_ID = process.env.TENCENT_ASR_SECRET_ID || process.env.TENCENT_SECRET_ID || '';
const TENCENT_ASR_SECRET_KEY = process.env.TENCENT_ASR_SECRET_KEY || process.env.TENCENT_SECRET_KEY || '';
const TENCENT_ASR_REGION = process.env.TENCENT_ASR_REGION || 'ap-shanghai';
const TENCENT_ASR_ENG_SERVICE_TYPE = process.env.TENCENT_ASR_ENG_SERVICE_TYPE || '16k_zh-PY';
const TENCENT_ASR_HOST = 'asr.tencentcloudapi.com';
const TENCENT_ASR_ACTION = 'SentenceRecognition';
const TENCENT_ASR_VERSION = '2019-06-14';

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
await ensureQuestionBank();
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
  if (!existsSync(FILES.memory)) {
    await writeJson(FILES.memory, {
      version: 1,
      updated_at: new Date().toISOString(),
      topics: {},
      knowledge: {},
      questions: {},
      chains: {}
    });
  }
  if (!existsSync(FILES.conceptMemory)) {
    await writeJson(FILES.conceptMemory, {
      version: 2,
      name: 'Topic-Concept Memory',
      updated_at: new Date().toISOString(),
      concepts: {}
    });
  }
  if (!existsSync(FILES.weakMemory)) {
    await writeJson(FILES.weakMemory, {
      version: 1,
      name: 'Weak Knowledge Memory',
      updated_at: new Date().toISOString(),
      topics: {},
      concepts: {}
    });
  }
  if (!existsSync(FILES.topicMemory)) {
    await writeJson(FILES.topicMemory, {
      version: 1,
      updated_at: new Date().toISOString(),
      topics: {}
    });
  }
  if (!existsSync(FILES.memorySummary)) {
    await writeJson(FILES.memorySummary, {
      version: 1,
      updated_at: new Date().toISOString(),
      weak_topics: [],
      weak_concepts: [],
      unstable_concepts: [],
      recently_mastered: []
    });
  }
  if (!existsSync(FILES.memoryEvents)) {
    await fs.writeFile(FILES.memoryEvents, '', 'utf8');
  }
  if (!existsSync(FILES.taskMetrics)) {
    await writeJson(FILES.taskMetrics, {
      version: 1,
      updated_at: new Date().toISOString(),
      metrics: {}
    });
  }
}

async function ensureQuestionBank() {
  if (!existsSync(FILES.questionBank)) {
    await writeJson(FILES.questionBank, { version: 1, updated_at: new Date().toISOString(), questions: [] });
  }
}

async function ensureLegacyMemory() {
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
  const metrics = await readTaskMetrics();
  for (const task of tasks) {
    task.progress ??= task.status === 'completed' ? 100 : 0;
    task.stage ||= task.status === 'queued' ? '排队中' : task.status;
    task.estimated_seconds = estimateTaskSeconds(task.type, task.payload || {}, metrics);
    task.estimate_source = estimateSource(task.type, task.payload || {}, metrics);
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
  const metrics = await readTaskMetrics();
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
    estimated_seconds: estimateTaskSeconds(type, payload, metrics),
    estimate_source: estimateSource(type, payload, metrics),
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
      task.finished_at = null;
      task.updated_at = task.started_at;
      await saveTasks();
      try {
        assertTaskNotCancelled(task);
        if (task.type === 'update_topic_concepts') task.result = await taskUpdateTopicConcepts(task.payload, task);
        else if (task.type === 'rebuild_topics') task.result = await taskUpdateTopicConcepts(task.payload || {}, task);
        else if (task.type === 'rebuild_index') task.result = await taskUpdateTopicConcepts(task.payload || {}, task);
        else if (task.type === 'generate_paper') task.result = await taskGeneratePaper(task.payload, task);
        else if (task.type === 'grade_paper') task.result = await taskGradePaper(task.payload, task);
        else throw new Error(`Unsupported task type: ${task.type}`);
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
      task.finished_at = task.updated_at;
      await recordTaskMetric(task);
      const metrics = await readTaskMetrics();
      task.estimated_seconds = estimateTaskSeconds(task.type, task.payload || {}, metrics);
      task.estimate_source = estimateSource(task.type, task.payload || {}, metrics);
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
  if (task.type === 'update_topic_concepts' || task.type === 'rebuild_topics' || task.type === 'rebuild_index') {
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
  throw new Error(`任务类型 ${task.type} 不支持归档。`);
}

function archiveKeptArtifact(task) {
  if (task.result?.paper_id) return task.result.paper_id;
  if (task.result?.feedback_file) return task.result.feedback_file;
  if (task.result?.file) return task.result.file;
  if (task.result?.topics_file) return task.result.topics_file;
  return null;
}

function estimateTaskSeconds(type, payload = {}, metrics = null) {
  const historical = pickTaskMetric(type, payload, metrics);
  if (historical?.median_seconds) return Math.max(10, Math.round(historical.median_seconds));
  if (type === 'generate_paper') {
    const count = Number(payload.question_count || 10);
    const topicCount = Array.isArray(payload.selected_topics) ? payload.selected_topics.length : 1;
    const modeFactor = payload.mode === 'followup' ? 1.25 : payload.mode === 'mixed' ? 1.15 : 1;
    return Math.round((50 + count * 7 + topicCount * 8) * modeFactor);
  }
  if (type === 'grade_paper') return 90;
  if (type === 'update_topic_concepts' || type === 'rebuild_topics' || type === 'rebuild_index') return 70;
  return 60;
}

function estimateSource(type, payload = {}, metrics = null) {
  return pickTaskMetric(type, payload, metrics)?.median_seconds ? 'history' : 'rule';
}

async function readTaskMetrics() {
  return readJson(FILES.taskMetrics, { version: 1, updated_at: null, metrics: {} });
}

function metricKey(type, payload = {}) {
  if (type === 'generate_paper') {
    return [type, PAPER_CODEX_MODEL, Number(payload.question_count || 10), payload.mode || 'normal'].join(':');
  }
  if (type === 'grade_paper') return [type, CODEX_MODEL].join(':');
  if (type === 'update_topic_concepts' || type === 'rebuild_topics' || type === 'rebuild_index') {
    return ['update_topic_concepts', CODEX_MODEL].join(':');
  }
  return [type, CODEX_MODEL].join(':');
}

function pickTaskMetric(type, payload = {}, metrics) {
  return metrics?.metrics?.[metricKey(type, payload)] || null;
}

async function recordTaskMetric(task) {
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) return;
  if (!task.started_at || !task.finished_at) return;
  const durationSeconds = Math.max(1, Math.round((Date.parse(task.finished_at) - Date.parse(task.started_at)) / 1000));
  if (!Number.isFinite(durationSeconds)) return;
  const data = await readTaskMetrics();
  const key = metricKey(task.type, task.payload || {});
  const entry = data.metrics[key] || { key, type: task.type, samples: [] };
  entry.samples = [...(entry.samples || []), durationSeconds].slice(-12);
  entry.sample_count = entry.samples.length;
  entry.median_seconds = median(entry.samples);
  entry.average_seconds = Math.round(entry.samples.reduce((sum, item) => sum + item, 0) / Math.max(entry.samples.length, 1));
  entry.updated_at = new Date().toISOString();
  data.metrics[key] = entry;
  data.updated_at = entry.updated_at;
  await writeJson(FILES.taskMetrics, data);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;

  if (req.method === 'GET' && route === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      port: PORT,
      speech_to_text: {
        provider: 'tencent-asr',
        configured: Boolean(TENCENT_ASR_SECRET_ID && TENCENT_ASR_SECRET_KEY),
        engine: TENCENT_ASR_ENG_SERVICE_TYPE
      }
    });
    return;
  }

  if (req.method === 'POST' && route === '/api/topics/update') {
    const body = await readBody(req);
    validateTopicUpdateRequest(body);
    sendJson(res, 202, await enqueueTask('update_topic_concepts', body));
    return;
  }

  if (req.method === 'POST' && route === '/api/topics/rebuild') {
    const body = await readBody(req);
    validateTopicUpdateRequest(body);
    sendJson(res, 202, await enqueueTask('update_topic_concepts', body));
    return;
  }

  if (req.method === 'POST' && route === '/api/index/rebuild') {
    sendJson(res, 410, { error: '本地知识库索引已停用，请使用 /api/topics/update 手动更新 Topic。' });
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
    sendJson(res, 410, { error: '本地知识库读取已停用。' });
    return;
  }

  if (req.method === 'POST' && route === '/api/papers') {
    const body = await readBody(req);
    validatePaperRequest(body);
    sendJson(res, 202, await enqueueTask('generate_paper', body));
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

  if (req.method === 'POST' && route === '/api/speech/transcribe') {
    const body = await readBody(req);
    sendJson(res, 200, await transcribeSpeech(body));
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
    sendJson(res, 200, await readMemoryView());
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

function validateTopicUpdateRequest(body) {
  const description = String(body.description || body.keywords_or_description || '').trim();
  if (!description || description.length < 2) {
    throw new Error('description is required');
  }
  const count = Number(body.concept_count || 20);
  if (!Number.isInteger(count) || count < 3 || count > 100) {
    throw new Error('concept_count must be an integer between 3 and 100');
  }
}

async function taskUpdateTopicConcepts(payload, task = null) {
  await updateTaskProgress(task, 10, '读取现有 Memory');
  const description = String(payload.description || payload.keywords_or_description || '').trim();
  const conceptCount = Number(payload.concept_count || 20);
  const existing = await readTopicConceptMemory();
  await updateTaskProgress(task, 35, '调用 Codex 理解描述并生成 Topic/Concept');
  const schema = path.join(SCHEMA_DIR, 'topics.schema.json');
  const prompt = buildUpdateTopicConceptsPrompt({
    description,
    conceptCount,
    existingTopics: serializeExistingTopicsForPrompt(existing)
  });
  const result = await runCodexJson(prompt, schema, task);
  await updateTaskProgress(task, 80, '合并 Topic-Concept Memory');
  const merged = await mergeTopicConcepts(result);
  await refreshMemorySummary();
  return {
    topics_count: Object.keys(merged.topicMemory.topics || {}).length,
    concepts_count: Object.keys(merged.conceptMemory.concepts || {}).length,
    topics_file: path.relative(REPO_DIR, FILES.topicMemory)
  };
}

async function taskGeneratePaper(payload, task = null) {
  await updateTaskProgress(task, 8, '准备 Memory');
  const paperId = `paper_${timestampId()}`;
  await updateTaskProgress(task, 16, '读取 Topic 和记忆');
  const topics = await readAvailableTopics();
  const memory = await readMemoryView();
  const selectedTopics = topics.topics.filter((topic) => payload.selected_topics.includes(topic.topic_id));
  await updateTaskProgress(task, 25, '召回 KnowledgeMemory');
  const knowledgeHints = buildKnowledgeHintsForPaper(payload, selectedTopics, memory);
  const finalSchema = path.join(SCHEMA_DIR, 'paper.schema.json');
  const prompt = buildGeneratePaperPrompt({
    payload,
    selectedTopics: serializeSelectedTopicsForPrompt(selectedTopics),
    memorySummary: serializeMemorySummaryForPrompt(summarizeMemory(memory)),
    knowledgeHints: serializeKnowledgeHintsForPrompt(knowledgeHints)
  });
  await updateTaskProgress(task, 35, 'Codex 生成试卷');
  const generated = await runCodexJson(prompt, finalSchema, task, { model: PAPER_CODEX_MODEL });
  await updateTaskProgress(task, 84, '整理试卷');
  const paper = normalizePaper(generated, payload, paperId);
  paper.generation_method = 'codex_memory';
  await updateTaskProgress(task, 94, '保存试卷和题库缓存');
  paper.knowledge_hint_ids = knowledgeHints.concepts.map((concept) => concept.concept_id);
  paper.context_chunk_ids = [];
  await writePaper(paper);
  await updateQuestionBankFromPaper(paper);
  return { paper_id: paper.paper_id, question_count: countPaperQuestions(paper) };
}

async function taskGradePaper(payload, task = null) {
  await updateTaskProgress(task, 10, '读取试卷答案');
  const paper = await readPaper(payload.paper_id);
  assertPaperFullyAnswered(paper);
  const schema = path.join(SCHEMA_DIR, 'grade.schema.json');
  const prompt = buildGradePaperPrompt({ paper });
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

async function runCodexJson(prompt, schemaPath, task = null, options = {}) {
  return new Promise((resolve, reject) => {
    assertTaskNotCancelled(task);
    const outputFile = path.join('/tmp', `interview-trainer-codex-${randomUUID()}.json`);
    const model = options.model || CODEX_MODEL;
    const args = [
      'exec',
      '--model',
      model,
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
    child.stdin.end(attachAgentsGuide(prompt));
  });
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
  await writeJson(FILES.topicMemory, buildTopicMemory(topics, chunks));
  const conceptMemory = await buildKnowledgeMemory(topics, chunks, options.generatedConcepts || []);
  await writeJson(FILES.conceptMemory, conceptMemory);
  await writeJson(FILES.memorySummary, buildMemorySummary(buildTopicMemory(topics, chunks), conceptMemory));
  await writeJson(FILES.chunks, { version: 1, source_signature: sourceSignature, updated_at: new Date().toISOString(), chunks });
  await writeJson(FILES.topicIndex, { version: 1, updated_at: new Date().toISOString(), topics: topicIndex });
  if (!existsSync(FILES.questionBank)) {
    await writeJson(FILES.questionBank, { version: 1, updated_at: new Date().toISOString(), questions: [] });
  }
  return { ...library, chunks, concepts_count: Object.keys(conceptMemory.concepts || {}).length };
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
  const questionBank = await readJson(FILES.questionBank, { questions: [] });
  const memory = await readTopicConceptMemory();
  return {
    topics_count: topics.topics.length,
    concepts_count: Object.keys(memory.conceptMemory.concepts || {}).length,
    chunks_count: 0,
    question_bank_count: questionBank.questions.length,
    topics_recorded: Object.keys(memory.topicMemory.topics || {}).length > 0,
    knowledge_source: 'Codex + Memory',
    local_knowledge_reading: false
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
  const weakTopicIds = new Set((memory.weak_topics || []).map((item) => item.topic_id || item.id).filter(Boolean));
  const conceptSignals = buildConceptSignals(memory, selectedIds);
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
        conceptSignals
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
      excerpt: buildChunkExcerpt(chunk, keywords, conceptSignals)
    }));
}

function scoreChunk(chunk, selectedIds, keywords, weakTopicIds, topicWeights, randomness, conceptSignals = []) {
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
  for (const signal of conceptSignals) {
    if (signal.topic_id && topicIds.includes(signal.topic_id)) score += 6;
    if (signal.source_chunks.has(chunk.chunk_id)) score += 28 + Math.round(signal.priority / 8);
    const overlap = overlapCount(chunkKeywords, signal.keywords);
    if (overlap > 0) score += Math.min(18, overlap * 4 + Math.round(signal.priority / 20));
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
  return { version: 1, parser_version: TOPIC_INDEX_VERSION, updated_at: new Date().toISOString(), topics: [] };
}

async function readAvailableTopics(library = null) {
  const memory = await readTopicConceptMemory();
  const conceptCounts = {};
  for (const concept of Object.values(memory.conceptMemory.concepts || {})) {
    const key = concept.topic_id || topicId(concept.topic || 'General');
    conceptCounts[key] = (conceptCounts[key] || 0) + 1;
  }
  const topics = Object.values(memory.topicMemory.topics || {}).map((topic) => ({
    topic_id: topic.topic_id,
    name: topic.name,
    aliases: arrayOfStrings(topic.aliases),
    category: topic.category || 'general',
    confidence: Number(topic.confidence || 1),
    enabled: topic.enabled !== false,
    can_write_back_to_bagu: false,
    source_files: [],
    covered_sections: [],
    concept_count: conceptCounts[topic.topic_id] || 0
  }));
  return { version: 1, parser_version: TOPIC_INDEX_VERSION, updated_at: memory.topicMemory.updated_at || new Date().toISOString(), topics };
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

function serializeExistingTopicsForPrompt(memory) {
  const topics = Object.values(memory.topicMemory.topics || {}).map((topic) => ({
    topic_id: topic.topic_id,
    name: topic.name,
    aliases: arrayOfStrings(topic.aliases).slice(0, 6),
    category: topic.category || 'general',
    concept_count: topic.concept_count || 0
  }));
  const concepts = Object.values(memory.conceptMemory.concepts || {}).slice(0, 200).map((concept) => ({
    concept_id: concept.concept_id,
    topic_id: concept.topic_id,
    name: concept.name
  }));
  return { topics, concepts };
}

async function mergeTopicConcepts(result) {
  const [topicMemory, conceptMemory] = await Promise.all([
    readJson(FILES.topicMemory, { version: 1, updated_at: null, topics: {} }),
    readJson(FILES.conceptMemory, { version: 2, name: 'Topic-Concept Memory', updated_at: null, concepts: {} })
  ]);
  const normalized = normalizeTopics({ topics: result?.topics || [] });
  for (const topic of normalized.topics) {
    const existing = topicMemory.topics[topic.topic_id] || {};
    topicMemory.topics[topic.topic_id] = {
      topic_id: topic.topic_id,
      name: topic.name,
      aliases: uniqueStrings([...(existing.aliases || []), ...(topic.aliases || []), topic.name]).slice(0, 12),
      category: topic.category || existing.category || 'general',
      description: existing.description || `${topic.name} 面试 Topic`,
      source: 'manual_description',
      enabled: topic.enabled !== false,
      concept_count: existing.concept_count || 0,
      created_at: existing.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }
  for (const raw of result?.concepts || []) {
    const topicIdValue = raw.topic_id || topicId(raw.topic || raw.name || 'General');
    const topic = topicMemory.topics[topicIdValue] || {
      topic_id: topicIdValue,
      name: raw.topic || topicIdValue,
      aliases: [],
      category: 'general',
      description: `${raw.topic || topicIdValue} 面试 Topic`,
      source: 'manual_description',
      enabled: true,
      created_at: new Date().toISOString()
    };
    topicMemory.topics[topicIdValue] = topic;
    ensureTopicConcept(conceptMemory.concepts, {
      ...raw,
      topic_id: topicIdValue,
      topic: topic.name,
      source_type: 'generated'
    });
  }
  for (const topic of Object.values(topicMemory.topics)) {
    topic.concept_count = Object.values(conceptMemory.concepts || {}).filter((concept) => concept.topic_id === topic.topic_id).length;
    topic.updated_at ||= new Date().toISOString();
  }
  topicMemory.version = 1;
  topicMemory.updated_at = new Date().toISOString();
  conceptMemory.version = 2;
  conceptMemory.name = 'Topic-Concept Memory';
  conceptMemory.updated_at = new Date().toISOString();
  await writeJson(FILES.topicMemory, topicMemory);
  await writeJson(FILES.conceptMemory, conceptMemory);
  return { topicMemory, conceptMemory };
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
    question.concept = normalizeConceptName(question.concept || question.root_knowledge_point || question.question || question.topic || 'General');
    question.expected_points = Array.isArray(question.expected_points) ? question.expected_points : [];
    question.source_chunks = Array.isArray(question.source_chunks) ? question.source_chunks : [];
    question.quality_flags = Array.isArray(question.quality_flags) ? question.quality_flags : [];
  }
  return paper;
}

function completeDraftPaperLocally(input, payload, paperId, context = []) {
  const hydrated = structuredClone({
    ...input,
    questions: Array.isArray(input.questions) ? input.questions : [],
    chains: Array.isArray(input.chains) ? input.chains : []
  });
  for (const question of flattenPaperQuestions(hydrated)) {
    const matchedChunks = matchContextForQuestion(question, context);
    question.source_chunks = Array.isArray(question.source_chunks) && question.source_chunks.length
      ? uniqueStrings(question.source_chunks).slice(0, 3)
      : matchedChunks.map((chunk) => chunk.chunk_id).slice(0, 3);
    question.quality_flags = Array.isArray(question.quality_flags) ? question.quality_flags : [];
    const expectedPoints = buildFallbackExpectedPoints(question);
    question.expected_points = Array.isArray(question.expected_points) && question.expected_points.length
      ? arrayOfStrings(question.expected_points).slice(0, 5)
      : expectedPoints;
    question.reference_answer = String(question.reference_answer || '').trim();
    question.follow_up_direction = String(question.follow_up_direction || '').trim();
  }
  return normalizePaper(hydrated, payload, paperId);
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
    const answerQuality = Math.min(1, Math.log2(String(answer).trim().length + 1) / 7);
    const baseScore = coverageRatio * 80 + answerQuality * 20;
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
      better_answer: buildFallbackBetterAnswer(question),
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
  const legacy = await readJson(FILES.memory, {});
  legacy.version = 1;
  legacy.updated_at = new Date().toISOString();
  legacy.topics ||= {};
  legacy.knowledge ||= {};
  legacy.questions ||= {};
  legacy.chains ||= {};
  const topicConceptMemory = await readJson(FILES.conceptMemory, { version: 2, name: 'Topic-Concept Memory', updated_at: null, concepts: {} });
  const weakMemory = await readJson(FILES.weakMemory, { version: 1, name: 'Weak Knowledge Memory', updated_at: null, topics: {}, concepts: {} });
  const reviewById = new Map(paper.grade.reviews.map((review) => [review.question_id, review]));
  const chainReviewById = new Map((paper.grade.chain_reviews || []).map((review) => [review.chain_id, review]));
  const events = [];
  for (const question of flattenPaperQuestions(paper)) {
    const review = reviewById.get(question.question_id);
    if (!review) continue;
    const topicIdValue = question.topic_id || topicId(question.topic || 'General');
    const questionKey = question.question_key || buildStableQuestionKey(question, topicIdValue);
    const conceptName = normalizeConceptName(question.concept || question.question || question.topic || topicIdValue);
    const conceptId = hash(`${topicIdValue}:${conceptName.toLowerCase()}`);
    events.push(buildConceptEvent(paper, question, review, conceptId, questionKey));
    updateStats(legacy.topics, topicIdValue, review.score, { name: question.topic || topicIdValue });
    updateStats(legacy.knowledge, conceptId, review.score, {
      topic_id: topicIdValue,
      topic: question.topic,
      source_type: question.source_type,
      concept: conceptName,
      question_key: questionKey,
      question: question.question,
      expected_points: question.expected_points || [],
      source_chunks: question.source_chunks || [],
      last_feedback: review.feedback,
      can_write_back_to_bagu: question.source_type !== 'note_readonly'
    });
    updateStats(legacy.questions, questionKey, review.score, {
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
    ensureTopicConcept(topicConceptMemory.concepts, {
      concept_id: conceptId,
      topic_id: topicIdValue,
      topic: question.topic || topicIdValue,
      name: conceptName,
      aliases: [conceptName],
      source_type: 'generated',
      source_files: [],
      linked_chunks: []
    });
    updateWeakConceptState(weakMemory.concepts, conceptId, review, { ...question, concept: conceptName }, questionKey, topicIdValue);
  }
  for (const chain of paper.chains || []) {
    const chainReviews = chain.questions.map((question) => reviewById.get(question.question_id)).filter(Boolean);
    if (!chainReviews.length) continue;
    const score = Math.round(chainReviews.reduce((sum, review) => sum + review.score, 0) / chainReviews.length);
    const chainReview = chainReviewById.get(chain.chain_id);
    updateStats(legacy.chains, chain.chain_id, score, {
      topic: chain.topic,
      topic_id: topicId(chain.topic || 'General'),
      root_knowledge_point: chain.root_knowledge_point,
      breakdown_question_index: chainReview?.breakdown_question_index || 0,
      weakest_follow_up_type: chainReview?.weakest_follow_up_type || '',
      last_chain_feedback: chainReviews.map((review) => review.feedback).join('\n')
    });
    events.push({
      type: 'followup_breakdown',
      created_at: new Date().toISOString(),
      paper_id: paper.paper_id,
      chain_id: chain.chain_id,
      topic_id: topicId(chain.topic || 'General'),
      topic: chain.topic || 'General',
      chain_score: score,
      breakdown_question_index: chainReview?.breakdown_question_index || 0,
      weakest_follow_up_type: chainReview?.weakest_follow_up_type || '',
      feedback: chainReview?.feedback || ''
    });
  }
  topicConceptMemory.updated_at = new Date().toISOString();
  weakMemory.updated_at = new Date().toISOString();
  weakMemory.topics = buildWeakTopicIndex(weakMemory.concepts);
  await appendJsonl(FILES.memoryEvents, events);
  await writeJson(FILES.memory, legacy);
  await writeJson(FILES.conceptMemory, topicConceptMemory);
  await writeJson(FILES.weakMemory, weakMemory);
  await refreshMemorySummary();
}

function updateStats(bucket, id, score, patch) {
  const current = advanceReviewStats(bucket[id], score);
  current.updated_at = new Date().toISOString();
  bucket[id] = { ...current, ...patch };
}

function advanceReviewStats(existing, score) {
  const current = existing || {
    attempt_count: 0,
    correct_count: 0,
    wrong_count: 0,
    streak_correct: 0,
    streak_wrong: 0,
    best_score: 0,
    last_score: 0,
    recent_scores: [],
    failure_streak: 0,
    recovery_streak: 0
  };
  current.attempt_count += 1;
  current.last_score = score;
  current.best_score = Math.max(current.best_score, score);
  current.recent_scores = [...(current.recent_scores || []), score].slice(-5);
  if (score >= 85) {
    current.correct_count += 1;
    current.streak_correct += 1;
    current.streak_wrong = 0;
    current.failure_streak = 0;
    current.recovery_streak = (current.recovery_streak || 0) + 1;
  } else if (score < 60) {
    current.wrong_count += 1;
    current.streak_wrong += 1;
    current.streak_correct = 0;
    current.failure_streak = (current.failure_streak || 0) + 1;
    current.recovery_streak = 0;
  } else {
    current.streak_correct = 0;
    current.streak_wrong = 0;
    current.failure_streak = 0;
    current.recovery_streak = Math.max(0, current.recovery_streak || 0);
  }
  current.mastery_level = masteryLevel(current);
  current.next_review_priority = reviewPriority(current);
  return current;
}

function updateWeakConceptState(bucket, id, review, question, questionKey, topicIdValue) {
  const updated = advanceReviewStats(bucket[id], review.score);
  Object.assign(updated, {
    concept_id: id,
    topic_id: topicIdValue,
    topic: question.topic || topicIdValue,
    name: normalizeConceptName(question.concept || question.question || question.topic || topicIdValue),
    question_key: questionKey,
    aliases: uniqueStrings([...(updated.aliases || []), normalizeConceptName(question.concept || question.question || '')]).slice(-6),
    detail: buildWeakConceptDetail(question, review),
    linked_chunks: uniqueStrings([...(updated.linked_chunks || []), ...(question.source_chunks || [])]).slice(-20),
    source_files: uniqueStrings([...(updated.source_files || []), ...(question.source_files || [])]).slice(-8),
    last_feedback: review.feedback || '',
    source_type: question.source_type,
    expected_points: question.expected_points || [],
    last_reviewed_at: new Date().toISOString()
  });
  updated.mastery_score = computeMasteryScore(updated);
  updated.stability = computeStabilityScore(updated);
  updated.pool = classifyConceptPool(updated);
  updated.updated_at = new Date().toISOString();
  bucket[id] = updated;
}

function ensureTopicConcept(bucket, concept) {
  const name = normalizeConceptName(concept.name);
  if (!isUsableConceptName(name)) return null;
  const topicIdValue = concept.topic_id || topicId(concept.topic || 'General');
  const id = concept.concept_id || hash(`${topicIdValue}:${name.toLowerCase()}`);
  const existing = bucket[id] || {};
  bucket[id] = {
    concept_id: id,
    topic_id: topicIdValue,
    topic: concept.topic || existing.topic || topicIdValue,
    name,
    aliases: uniqueStrings([...(existing.aliases || []), ...(concept.aliases || []), name]).slice(0, 8),
    source_type: concept.source_type || existing.source_type || 'generated',
    source_files: uniqueStrings([...(existing.source_files || []), ...(concept.source_files || [])]).slice(0, 8),
    linked_chunks: uniqueStrings([...(existing.linked_chunks || []), ...(concept.linked_chunks || [])]).slice(0, 8),
    created_at: existing.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  return bucket[id];
}

function buildWeakConceptDetail(question, review) {
  return {
    question: question.question || '',
    missed_points: review.missed_points || [],
    incorrect_points: review.incorrect_points || [],
    feedback: review.feedback || '',
    better_answer: review.better_answer || ''
  };
}

function buildWeakTopicIndex(concepts) {
  const topics = {};
  for (const concept of Object.values(concepts || {})) {
    const topicIdValue = concept.topic_id || topicId(concept.topic || 'General');
    topics[topicIdValue] ||= {
      topic_id: topicIdValue,
      name: concept.topic || topicIdValue,
      weak_count: 0,
      unstable_count: 0,
      average_score: 0,
      last_reviewed_at: null,
      priority: 0
    };
    const item = topics[topicIdValue];
    if (concept.pool === 'wrong_pool') item.weak_count += 1;
    if (concept.pool === 'unstable_pool') item.unstable_count += 1;
    item.average_score += Number(concept.last_score || 0);
    item.priority = Math.max(item.priority, Number(concept.next_review_priority || 0));
    if (!item.last_reviewed_at || Date.parse(concept.last_reviewed_at || 0) > Date.parse(item.last_reviewed_at || 0)) {
      item.last_reviewed_at = concept.last_reviewed_at || concept.updated_at || null;
    }
    item._count = (item._count || 0) + 1;
  }
  for (const item of Object.values(topics)) {
    item.average_score = Math.round(item.average_score / Math.max(item._count || 1, 1));
    delete item._count;
  }
  return topics;
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

function computeMasteryScore(stats) {
  return clamp(Math.round((stats.best_score || 0) * 0.35 + (stats.last_score || 0) * 0.45 + ((stats.correct_count || 0) / Math.max(stats.attempt_count || 1, 1)) * 20), 0, 100);
}

function computeStabilityScore(stats) {
  const scores = stats.recent_scores || [];
  if (!scores.length) return 0;
  const avg = scores.reduce((sum, item) => sum + item, 0) / scores.length;
  const variance = scores.reduce((sum, item) => sum + ((item - avg) ** 2), 0) / scores.length;
  return clamp(Math.round(100 - Math.sqrt(variance) * 4 - (stats.wrong_count || 0) * 6), 0, 100);
}

function classifyConceptPool(stats) {
  if ((stats.failure_streak || stats.streak_wrong || 0) >= 1 || (stats.last_score || 0) < 60) return 'wrong_pool';
  if ((stats.last_score || 0) < 85 || (stats.wrong_count || 0) > 0) return 'unstable_pool';
  return 'mastered_pool';
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

function readAgentsGuideText() {
  try {
    if (!existsSync(FILES.agentsGuide)) return '';
    return processAgentsGuide(readFileSync(FILES.agentsGuide, 'utf8'));
  } catch {
    return '';
  }
}

function processAgentsGuide(text) {
  return String(text || '').trim();
}

async function transcribeSpeech(body) {
  if (!(TENCENT_ASR_SECRET_ID && TENCENT_ASR_SECRET_KEY)) {
    throw new Error('语音转写未配置。请设置 TENCENT_ASR_SECRET_ID 和 TENCENT_ASR_SECRET_KEY。');
  }
  const audioBase64 = String(body.audio_base64 || '').trim();
  const voiceFormat = String(body.voice_format || 'wav').trim().toLowerCase();
  const dataLen = Number(body.data_len || 0);
  if (!audioBase64) {
    throw new Error('audio_base64 is required');
  }
  if (!Number.isFinite(dataLen) || dataLen <= 0) {
    throw new Error('data_len is required');
  }
  const hotwordList = buildTencentHotwordList(body);
  const payload = {
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: TENCENT_ASR_ENG_SERVICE_TYPE,
    SourceType: 1,
    VoiceFormat: voiceFormat,
    Data: audioBase64,
    DataLen: dataLen,
    WordInfo: 0,
    FilterDirty: 0,
    FilterModal: 0,
    FilterPunc: 0,
    ConvertNumMode: 1
  };
  if (hotwordList) payload.HotwordList = hotwordList;
  const response = await callTencentAsr(payload);
  return {
    provider: 'tencent-asr',
    engine: TENCENT_ASR_ENG_SERVICE_TYPE,
    result: response.Result || '',
    audio_duration: response.AudioDuration || 0,
    request_id: response.RequestId || null,
    hotword_list: hotwordList || ''
  };
}

function buildTencentHotwordList(body) {
  const seeds = [
    String(body.topic || ''),
    String(body.concept || ''),
    ...(Array.isArray(body.expected_points) ? body.expected_points.map((item) => String(item || '')) : [])
  ];
  const normalized = new Map();
  for (const seed of seeds) {
    const parts = seed
      .split(/[\s,，。；;：:（）()、/]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    for (const part of parts) {
      if (part.length < 2 || part.length > 30) continue;
      const key = part.toLowerCase();
      if (!normalized.has(key)) normalized.set(key, part);
    }
  }
  return [...normalized.values()].slice(0, 24).map((term) => `${term}|10`).join(',');
}

async function callTencentAsr(payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const service = 'asr';
  const algorithm = 'TC3-HMAC-SHA256';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${TENCENT_ASR_HOST}\n`;
  const signedHeaders = 'content-type;host';
  const body = JSON.stringify(payload);
  const hashedRequestPayload = sha256Hex(body);
  const canonicalRequest = [
    'POST',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload
  ].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    algorithm,
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n');
  const secretDate = hmac(`TC3${TENCENT_ASR_SECRET_KEY}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');
  const authorization = `${algorithm} Credential=${TENCENT_ASR_SECRET_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${TENCENT_ASR_HOST}/`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: TENCENT_ASR_HOST,
      'X-TC-Action': TENCENT_ASR_ACTION,
      'X-TC-Version': TENCENT_ASR_VERSION,
      'X-TC-Region': TENCENT_ASR_REGION,
      'X-TC-Timestamp': String(timestamp)
    },
    body
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`腾讯云语音识别返回了不可解析响应：${text.slice(0, 200)}`);
  }
  if (!response.ok || data.Response?.Error) {
    const error = data.Response?.Error;
    throw new Error(error ? `腾讯云语音识别失败：${error.Code} ${error.Message}` : `腾讯云语音识别 HTTP ${response.status}`);
  }
  return data.Response || {};
}

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function hmac(key, content, encoding) {
  const digest = crypto.createHmac('sha256', key).update(content, 'utf8').digest();
  return encoding ? digest.toString(encoding) : digest;
}

function attachAgentsGuide(prompt) {
  const guide = readAgentsGuideText();
  if (!guide) return prompt;
  return [
    '以下内容是本项目的全局 Agent 规则与全局记忆摘要。它统领当前任务的行为约束、知识来源权限、记忆层级和出题/评分原则。你必须在整个任务中遵守它。',
    '',
    '=== BEGIN AGENTS.MD ===',
    guide,
    '=== END AGENTS.MD ===',
    '',
    '=== CURRENT TASK ===',
    prompt
  ].join('\n');
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

async function appendJsonl(file, entries) {
  const items = (entries || []).filter(Boolean);
  if (!items.length) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload = items.map((item) => JSON.stringify(item)).join('\n') + '\n';
  await fs.appendFile(file, payload, 'utf8');
}

async function readTopicConceptMemory() {
  const [topicMemory, conceptMemory] = await Promise.all([
    readJson(FILES.topicMemory, { version: 1, topics: {} }),
    readJson(FILES.conceptMemory, { version: 2, name: 'Topic-Concept Memory', concepts: {} })
  ]);
  return { topicMemory, conceptMemory };
}

async function readMemoryView() {
  const [legacy, topicMemory, conceptState, weakMemory, summary] = await Promise.all([
    readJson(FILES.memory, { topics: {}, knowledge: {}, questions: {}, chains: {} }),
    readJson(FILES.topicMemory, { topics: {} }),
    readJson(FILES.conceptMemory, { concepts: {} }),
    readJson(FILES.weakMemory, { topics: {}, concepts: {} }),
    readJson(FILES.memorySummary, null)
  ]);
  const effectiveWeakState = Object.keys(weakMemory.concepts || {}).length
    ? weakMemory
    : buildWeakMemoryFromLegacy(legacy);
  const hasSummaryData = summary && (
    (summary.weak_topics || []).length ||
    (summary.weak_concepts || []).length ||
    (summary.unstable_concepts || []).length ||
    (summary.recently_mastered || []).length
  );
  const generatedSummary = hasSummaryData ? summary : buildMemorySummary(topicMemory, effectiveWeakState);
  return {
    version: 2,
    updated_at: generatedSummary.updated_at || new Date().toISOString(),
    agents_guide: { path: path.relative(REPO_DIR, FILES.agentsGuide) },
    topics: legacy.topics || {},
    knowledge: legacy.knowledge || {},
    questions: legacy.questions || {},
    chains: legacy.chains || {},
    topic_index: topicMemory.topics || {},
    concepts: conceptState.concepts || {},
    weak_knowledge: effectiveWeakState,
    weak_topics: generatedSummary.weak_topics || [],
    weak_concepts: generatedSummary.weak_concepts || [],
    unstable_concepts: generatedSummary.unstable_concepts || [],
    recently_mastered: generatedSummary.recently_mastered || []
  };
}

function buildMemorySummary(topicMemory, conceptState) {
  const allConcepts = Object.values(conceptState.concepts || {});
  const weakConcepts = allConcepts
    .filter((item) => item.pool === 'wrong_pool')
    .sort((a, b) => (b.next_review_priority || 0) - (a.next_review_priority || 0))
    .slice(0, 12)
    .map((item) => ({
      concept_id: item.concept_id,
      topic_id: item.topic_id,
      topic: item.topic,
      question: item.name,
      last_score: item.last_score,
      mastery_level: item.mastery_level,
      pool: item.pool
    }));
  const unstableConcepts = allConcepts
    .filter((item) => item.pool === 'unstable_pool')
    .sort((a, b) => (b.next_review_priority || 0) - (a.next_review_priority || 0))
    .slice(0, 12)
    .map((item) => ({
      concept_id: item.concept_id,
      topic_id: item.topic_id,
      topic: item.topic,
      question: item.name,
      last_score: item.last_score,
      mastery_level: item.mastery_level,
      pool: item.pool
    }));
  const recentlyMastered = allConcepts
    .filter((item) => item.pool === 'mastered_pool')
    .sort((a, b) => Date.parse(b.last_reviewed_at || 0) - Date.parse(a.last_reviewed_at || 0))
    .slice(0, 8)
    .map((item) => ({
      concept_id: item.concept_id,
      topic_id: item.topic_id,
      topic: item.topic,
      question: item.name,
      last_score: item.last_score
    }));
  const topicAgg = {};
  for (const item of allConcepts) {
    const key = item.topic_id || topicId(item.topic || 'General');
    topicAgg[key] ||= { topic_id: key, weak: 0, unstable: 0, total: 0, score: 0 };
    topicAgg[key].total += 1;
    topicAgg[key].score += Number(item.last_score || 0);
    if (item.pool === 'wrong_pool') topicAgg[key].weak += 1;
    if (item.pool === 'unstable_pool') topicAgg[key].unstable += 1;
  }
  const topicIndex = topicMemory.topics || {};
  const weakTopics = Object.values(topicAgg)
    .filter((item) => item.weak > 0 || item.unstable > 0)
    .sort((a, b) => (b.weak * 3 + b.unstable * 2) - (a.weak * 3 + a.unstable * 2))
    .slice(0, 12)
    .map((item) => ({
      topic_id: item.topic_id,
      name: topicIndex[item.topic_id]?.name || item.topic_id,
      weak_count: item.weak,
      unstable_count: item.unstable,
      average_score: Math.round(item.score / Math.max(item.total, 1))
    }));
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    weak_topics: weakTopics,
    weak_concepts: weakConcepts,
    unstable_concepts: unstableConcepts,
    recently_mastered: recentlyMastered
  };
}

function buildWeakMemoryFromLegacy(legacy) {
  const concepts = {};
  for (const [id, item] of Object.entries(legacy.knowledge || {})) {
    concepts[id] = {
      concept_id: id,
      topic_id: item.topic_id || topicId(item.topic || 'General'),
      topic: item.topic || 'General',
      name: normalizeConceptName(item.concept || item.question || id),
      mastery_level: item.mastery_level || 'weak',
      next_review_priority: item.next_review_priority || 80,
      last_score: item.last_score || 0,
      attempt_count: item.attempt_count || 0,
      wrong_count: item.wrong_count || 0,
      pool: (item.last_score || 0) < 60 ? 'wrong_pool' : (item.last_score || 0) < 85 ? 'unstable_pool' : 'mastered_pool',
      linked_chunks: item.source_chunks || [],
      last_feedback: item.last_feedback || '',
      expected_points: item.expected_points || [],
      last_reviewed_at: item.updated_at || new Date().toISOString()
    };
  }
  return { version: 1, name: 'Weak Knowledge Memory', updated_at: new Date().toISOString(), topics: {}, concepts };
}

async function refreshMemorySummary() {
  const [topicMemory, weakMemory] = await Promise.all([
    readJson(FILES.topicMemory, { topics: {} }),
    readJson(FILES.weakMemory, { topics: {}, concepts: {} })
  ]);
  const summary = buildMemorySummary(topicMemory, weakMemory);
  await writeJson(FILES.memorySummary, summary);
  return summary;
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
  return {
    weak_topics: memory.weak_topics || [],
    weak_knowledge_points: memory.weak_concepts || [],
    unstable_concepts: memory.unstable_concepts || [],
    recently_mastered: memory.recently_mastered || []
  };
}

function serializeSelectedTopicsForPrompt(selectedTopics) {
  return (selectedTopics || []).map((topic) => ({
    topic_id: topic.topic_id,
    name: topic.name,
    aliases: arrayOfStrings(topic.aliases).slice(0, 5),
    category: topic.category || 'general'
  }));
}

function serializeMemorySummaryForPrompt(summary) {
  return {
    weak_topics: (summary.weak_topics || []).slice(0, 6).map((item) => ({
      topic_id: item.topic_id || item.id,
      name: item.name,
      weak_count: item.weak_count || 0,
      unstable_count: item.unstable_count || 0
    })),
    weak_knowledge_points: (summary.weak_knowledge_points || []).slice(0, 8).map((item) => ({
      concept_id: item.concept_id,
      topic_id: item.topic_id,
      topic: item.topic,
      question: String(item.question || '').slice(0, 90),
      pool: item.pool || 'wrong_pool'
    })),
    unstable_concepts: (summary.unstable_concepts || []).slice(0, 6).map((item) => ({
      concept_id: item.concept_id,
      topic_id: item.topic_id,
      topic: item.topic,
      question: String(item.question || '').slice(0, 90),
      pool: item.pool || 'unstable_pool'
    })),
    recently_mastered: (summary.recently_mastered || []).slice(0, 4).map((item) => ({
      topic_id: item.topic_id,
      topic: item.topic,
      question: String(item.question || '').slice(0, 72)
    }))
  };
}

function serializeContextForPrompt(context) {
  return (context || []).map((chunk) => ({
    chunk_id: chunk.chunk_id,
    source_type: chunk.source_type,
    file: path.basename(chunk.file || ''),
    summary: String(chunk.summary || '').slice(0, 180),
    excerpt: String(chunk.excerpt || '').slice(0, 180)
  }));
}

function buildKnowledgeHintsForPaper(payload, selectedTopics, memory) {
  const selectedIds = new Set(selectedTopics.map((topic) => topic.topic_id).concat(payload.selected_topics || []));
  const baseConcepts = Object.values(memory.concepts || {})
    .filter((concept) => !selectedIds.size || selectedIds.has(concept.topic_id || topicId(concept.topic || 'General')))
    .map((concept) => ({ ...concept, pool: 'exploration_pool', mastery_level: 'new', next_review_priority: 20 }));
  const weakConcepts = Object.values(memory.weak_knowledge?.concepts || {})
    .filter((concept) => !selectedIds.size || selectedIds.has(concept.topic_id || topicId(concept.topic || 'General')))
    .map((concept) => ({ ...concept, weak_detail: concept.detail || null }));
  const byId = new Map(baseConcepts.map((concept) => [concept.concept_id, concept]));
  for (const concept of weakConcepts) {
    byId.set(concept.concept_id, { ...(byId.get(concept.concept_id) || {}), ...concept });
  }
  const concepts = [...byId.values()]
    .sort((a, b) => {
      const priorityDelta = (b.next_review_priority || 0) - (a.next_review_priority || 0);
      if (priorityDelta) return priorityDelta;
      return Date.parse(b.last_reviewed_at || b.updated_at || 0) - Date.parse(a.last_reviewed_at || a.updated_at || 0);
    })
    .slice(0, 48);
  return {
    topics: selectedTopics.map((topic) => {
      const entry = memory.topic_index?.[topic.topic_id] || {};
      return {
        topic_id: topic.topic_id,
        name: topic.name,
        description: entry.description || `${topic.name} 面试知识入口`,
        concept_count: entry.concept_count || concepts.filter((concept) => concept.topic_id === topic.topic_id).length
      };
    }),
    concepts
  };
}

function serializeKnowledgeHintsForPrompt(hints) {
  return {
    topics: (hints.topics || []).map((topic) => ({
      topic_id: topic.topic_id,
      name: topic.name,
      description: topic.description,
      concept_count: topic.concept_count || 0
    })),
    concepts: (hints.concepts || []).slice(0, 36).map((concept) => ({
      concept_id: concept.concept_id,
      topic_id: concept.topic_id,
      name: concept.name,
      pool: concept.pool || 'exploration_pool',
      mastery_level: concept.mastery_level || 'new',
      priority: concept.next_review_priority || 0,
      source_type: concept.source_type || 'generated',
      weak_detail: concept.weak_detail ? {
        last_score: concept.last_score || 0,
        missed_points: arrayOfStrings(concept.weak_detail.missed_points).slice(0, 3),
        feedback: String(concept.weak_detail.feedback || '').slice(0, 120)
      } : null
    }))
  };
}

function matchContextForQuestion(question, context) {
  const queryKeywords = new Set(extractKeywords(`${question.topic || ''} ${question.question || ''}`));
  return (context || [])
    .map((chunk) => {
      const hayKeywords = new Set(extractKeywords(`${chunk.summary || ''} ${chunk.excerpt || ''}`));
      const overlap = overlapCount(queryKeywords, hayKeywords);
      const topicBonus = String(chunk.summary || '').toLowerCase().includes(String(question.topic || '').toLowerCase()) ? 2 : 0;
      return { chunk, score: overlap * 4 + topicBonus };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.chunk);
}

function buildFallbackExpectedPoints(question) {
  return [
    '能直接回答题干中的核心概念或机制',
    '能说明关键原因，而不是只背结论',
    '能指出常见边界、误区或适用场景'
  ];
}

function buildFallbackBetterAnswer(question) {
  const expectedPoints = Array.isArray(question.expected_points) ? question.expected_points : [];
  return [
    `这道题需要围绕「${question.question || question.topic || '该知识点'}」作答。`,
    `建议至少覆盖：${expectedPoints.slice(0, 3).join('；')}。`,
    '可以按“定义/机制/边界或易错点”的顺序组织答案。'
  ].join('');
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

function buildChunkExcerpt(chunk, baseKeywords = [], conceptSignals = []) {
  const signalKeywords = [
    ...baseKeywords,
    ...conceptSignals.flatMap((item) => [...item.keywords].slice(0, 6))
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

function buildConceptSignals(memory, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const prioritized = new Set([
    ...(memory.weak_concepts || []).map((item) => item.concept_id),
    ...(memory.unstable_concepts || []).map((item) => item.concept_id)
  ].filter(Boolean));
  return Object.entries(memory.concepts || {})
    .filter(([id, item]) => prioritized.has(id) || ['weak', 'unstable'].includes(item.mastery_level))
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
      source_chunks: new Set(Array.isArray(item.linked_chunks) ? item.linked_chunks : []),
      keywords: new Set(extractKeywords(`${item.name || item.question || ''} ${item.summary || ''} ${(item.expected_points || []).join(' ')} ${item.last_feedback || ''}`))
    }));
}

function uniqueStrings(items) {
  return [...new Set((items || []).map((item) => String(item)).filter(Boolean))];
}

function buildConceptEvent(paper, question, review, conceptId, questionKey) {
  const eventType = review.level === 'correct' ? 'concept_correct' : review.level === 'partial' ? 'concept_partial' : 'concept_wrong';
  return {
    type: eventType,
    created_at: new Date().toISOString(),
    paper_id: paper.paper_id,
    concept_id: conceptId,
    question_key: questionKey,
    question_id: question.question_id,
    topic_id: question.topic_id || topicId(question.topic || 'General'),
    topic: question.topic || 'General',
    score: review.score,
    level: review.level,
    missed_points: review.missed_points || [],
    incorrect_points: review.incorrect_points || [],
    source_chunks: question.source_chunks || []
  };
}

function buildTopicMemory(topics, chunks) {
  const chunkMap = {};
  for (const chunk of chunks || []) {
    for (const id of chunk.topic_ids || []) {
      chunkMap[id] ||= [];
      chunkMap[id].push(chunk);
    }
  }
  const data = {};
  for (const topic of topics.topics || []) {
    const related = chunkMap[topic.topic_id] || [];
    data[topic.topic_id] = {
      topic_id: topic.topic_id,
      name: topic.name,
      description: `${topic.name} 面试知识入口`,
      source_files: uniqueStrings(topic.source_files || related.map((item) => item.file)).slice(0, 20),
      entry_chunks: uniqueStrings(related.slice(0, 20).map((item) => item.chunk_id)),
      concept_count: related.length,
      last_updated_at: new Date().toISOString()
    };
  }
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    topics: data
  };
}

async function buildKnowledgeMemory(topics, chunks, generatedConcepts = []) {
  const existing = await readJson(FILES.conceptMemory, { concepts: {} });
  const byId = new Map(Object.entries(existing.concepts || {}));
  const topicNames = new Map((topics.topics || []).map((topic) => [topic.topic_id, topic.name]));
  const upsertConcept = (item) => {
    const topicIdValue = item.topic_id || topicId(item.topic || 'General');
    const name = normalizeConceptName(item.name || item.concept || item.title || '');
    if (!isUsableConceptName(name)) return;
    const conceptId = item.concept_id && !String(item.concept_id).includes('?')
      ? String(item.concept_id)
      : hash(`${topicIdValue}:${name.toLowerCase()}`);
    const previous = byId.get(conceptId) || {};
    byId.set(conceptId, {
      concept_id: conceptId,
      topic_id: topicIdValue,
      topic: topicNames.get(topicIdValue) || item.topic || topicIdValue,
      name,
      aliases: uniqueStrings([...(previous.aliases || []), ...(item.aliases || []), name]).slice(0, 8),
      summary: '',
      source_type: item.source_type || previous.source_type || 'bagu_local',
      source_files: uniqueStrings([...(previous.source_files || []), ...(item.source_files || [])]).slice(0, 12),
      linked_chunks: uniqueStrings([...(previous.linked_chunks || []), ...(item.linked_chunks || [])]).slice(0, 20),
      expected_points: previous.expected_points || [],
      question_key: previous.question_key || null,
      attempt_count: previous.attempt_count || 0,
      correct_count: previous.correct_count || 0,
      wrong_count: previous.wrong_count || 0,
      streak_correct: previous.streak_correct || 0,
      streak_wrong: previous.streak_wrong || 0,
      failure_streak: previous.failure_streak || 0,
      recovery_streak: previous.recovery_streak || 0,
      best_score: previous.best_score || 0,
      last_score: previous.last_score || 0,
      recent_scores: previous.recent_scores || [],
      mastery_level: previous.mastery_level || 'new',
      next_review_priority: previous.next_review_priority || 30,
      mastery_score: previous.mastery_score || 0,
      stability: previous.stability || 0,
      pool: previous.pool || 'exploration_pool',
      last_feedback: previous.last_feedback || '',
      last_reviewed_at: previous.last_reviewed_at || null,
      updated_at: new Date().toISOString()
    });
  };

  for (const chunk of chunks || []) {
    const topicIds = chunk.topic_ids?.length ? chunk.topic_ids : [];
    for (const topicIdValue of topicIds) {
      for (const name of conceptNamesFromChunk(chunk, topicNames.get(topicIdValue) || topicIdValue)) {
        upsertConcept({
          topic_id: topicIdValue,
          topic: topicNames.get(topicIdValue) || topicIdValue,
          name,
          source_type: chunk.source_type,
          source_files: [chunk.file],
          linked_chunks: [chunk.chunk_id]
        });
      }
    }
  }
  for (const concept of generatedConcepts || []) {
    upsertConcept(concept);
  }
  return {
    version: 2,
    name: 'KnowledgeMemory',
    updated_at: new Date().toISOString(),
    concepts: Object.fromEntries([...byId.entries()].sort((a, b) => a[1].topic_id.localeCompare(b[1].topic_id) || a[1].name.localeCompare(b[1].name)))
  };
}

function conceptNamesFromChunk(chunk, topicName) {
  const names = [];
  const pathParts = arrayOfStrings(chunk.path).filter(Boolean);
  const candidates = [
    chunk.title,
    pathParts.slice(-2).join(' - '),
    pathParts.slice(-1)[0]
  ];
  for (const candidate of candidates) {
    const name = normalizeConceptName(candidate || '');
    if (isUsableConceptName(name)) names.push(name);
  }
  if (!names.length && topicName) names.push(`${topicName} 核心机制`);
  return uniqueStrings(names).slice(0, 2);
}

function normalizeConceptName(value) {
  let text = String(value || '')
    .replace(/^追问\s*\d+\s*[：:]\s*/u, '')
    .replace(/^第\s*\d+\s*问\s*[：:]\s*/u, '')
    .replace(/[?？].*$/u, '')
    .replace(/^(请|说明|解释|为什么|如何|怎么|什么是|谈谈|分析)\s*/u, '')
    .replace(/(是什么|为什么|如何|怎么).*/u, '')
    .replace(/[“”"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/[，,。；;：:]+$/u, '').trim();
  if (text.length > 42) text = text.slice(0, 42).replace(/[，,。；;：:].*$/u, '').trim();
  return text || '通用知识点';
}

function isUsableConceptName(name) {
  const text = String(name || '').trim();
  if (text.length < 2 || text.length > 48) return false;
  if (/[?？]/.test(text)) return false;
  if (/因为|所以|例如|比如|答案|返回|报错|实现函数/.test(text)) return false;
  if (/^#+$/.test(text)) return false;
  return true;
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
