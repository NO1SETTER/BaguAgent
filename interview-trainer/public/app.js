const state = {
  topics: [],
  tasks: [],
  currentPaper: null,
  recognition: null,
  recordingQuestionId: null
};

const el = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await loadTopics();
  await loadIndexSummary();
  await loadTasks();
  setInterval(loadTasks, 3000);
});

function bindEvents() {
  el('updateTopicsBtn').addEventListener('click', updateTopics);
  el('updateTopicsSubmitBtn').addEventListener('click', updateTopics);
  el('createPaperBtn').addEventListener('click', createPaper);
  el('saveAnswersBtn').addEventListener('click', saveAnswers);
  el('gradePaperBtn').addEventListener('click', gradePaper);
  el('loadFeedbackBtn').addEventListener('click', loadFeedback);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadTopics() {
  const data = await api('/api/topics');
  state.topics = data.topics || [];
  renderTopics();
}

async function loadIndexSummary() {
  const data = await api('/api/index').catch(() => null);
  if (!data) return;
  el('indexSummary').textContent = `Topic记录：${data.topics_recorded ? '已落盘' : '空'} · Concepts：${data.concepts_count || 0} · 题库缓存：${data.question_bank_count} · 知识来源：${data.knowledge_source || 'Memory'}`;
}

function renderTopics() {
  el('topicStatus').textContent = `${state.topics.length} 个 Topic`;
  el('topics').innerHTML = state.topics.map((topic) => `
    <label class="topic-card">
      <span class="topic-title">
        <span><input type="checkbox" class="topic-check" value="${escapeHtml(topic.topic_id)}" ${topic.enabled ? 'checked' : ''}> ${escapeHtml(topic.name)}</span>
        <span class="status">${escapeHtml(topic.category || 'general')}</span>
      </span>
      <span class="topic-meta">${escapeHtml(String(topic.concept_count || 0))} 个 Concepts</span>
      <select class="topic-weight" data-topic="${escapeHtml(topic.topic_id)}">
        <option value="normal">普通</option>
        <option value="focus">重点</option>
        <option value="weak">弱项优先</option>
      </select>
    </label>
  `).join('');
}

async function updateTopics() {
  const description = el('topicDescription').value.trim();
  if (!description) return notify('请输入技术栈关键词或自然语言描述');
  const task = await api('/api/topics/update', {
    method: 'POST',
    body: {
      description,
      concept_count: Number(el('topicConceptCount').value || 20)
    }
  });
  notify(`Topic 更新任务已排队：${task.task_id}`);
  await loadTasks();
}

async function createPaper() {
  const selected = [...document.querySelectorAll('.topic-check:checked')].map((node) => node.value);
  if (!selected.length) return notify('至少选择一个 Topic');
  const questionCount = Number(el('questionCount').value);
  const limit = topicLimitForQuestionCount(questionCount);
  if (Number.isFinite(limit) && selected.length > limit) {
    return notify(`${questionCount}题试卷最多选择${limit}个Topic，当前选择了${selected.length}个。请减少Topic数量或选择更大题量。`);
  }
  const topicWeights = {};
  for (const node of document.querySelectorAll('.topic-weight')) {
    if (selected.includes(node.dataset.topic)) topicWeights[node.dataset.topic] = node.value;
  }
  const task = await api('/api/papers', {
    method: 'POST',
    body: {
      question_count: Number(el('questionCount').value),
      mode: el('paperMode').value,
      selected_topics: selected,
      topic_weights: topicWeights,
      include_expanded_knowledge: el('includeExpanded').checked,
      randomness: 0.3,
      reuse_cached_questions: true,
      rag_context_limit: 14
    }
  });
  notify(`试卷生成任务已排队：${task.task_id}`);
  await loadTasks();
}

function topicLimitForQuestionCount(questionCount) {
  if (Number(questionCount) === 10) return 3;
  if (Number(questionCount) === 30) return 6;
  return Infinity;
}

async function loadTasks() {
  const tasks = await api('/api/tasks');
  state.tasks = tasks;
  renderTasks();
  const latestPaperTask = tasks.find((task) => task.type === 'generate_paper' && task.status === 'completed' && task.result?.paper_id);
  if (latestPaperTask && (!state.currentPaper || state.currentPaper.paper_id !== latestPaperTask.result.paper_id)) {
    await loadPaper(latestPaperTask.result.paper_id);
  }
}

function renderTasks() {
  el('tasks').innerHTML = state.tasks.slice(0, 10).map((task) => `
    <div class="task">
      <div class="task-main">
        <strong>${escapeHtml(task.type)}</strong>
        <div class="task-meta">${escapeHtml(task.task_id)} · ${escapeHtml(task.updated_at || '')}</div>
        ${renderTaskProgress(task)}
        ${task.error ? `<div class="task-meta">${escapeHtml(task.error.slice(0, 220))}</div>` : ''}
      </div>
      <div>
        ${task.result?.paper_id ? `<button class="secondary" data-paper="${escapeHtml(task.result.paper_id)}">打开试卷</button>` : ''}
        ${task.result?.topics_file ? `<span class="task-meta">${escapeHtml(task.result.topics_file)}</span>` : ''}
        ${canArchiveTask(task) ? `<button class="secondary" data-archive-task="${escapeHtml(task.task_id)}">归档</button>` : ''}
        <button class="secondary danger-text" data-delete-task="${escapeHtml(task.task_id)}">删除</button>
        <span class="status ${task.status === 'failed' ? 'failed' : ''}">${escapeHtml(task.status)}</span>
      </div>
    </div>
  `).join('') || '<div class="muted">暂无任务</div>';
  for (const button of document.querySelectorAll('[data-paper]')) {
    button.addEventListener('click', () => loadPaper(button.dataset.paper));
  }
  for (const button of document.querySelectorAll('[data-delete-task]')) {
    button.addEventListener('click', () => deleteTask(button.dataset.deleteTask));
  }
  for (const button of document.querySelectorAll('[data-archive-task]')) {
    button.addEventListener('click', () => archiveTask(button.dataset.archiveTask));
  }
}

function canArchiveTask(task) {
  return task.status === 'completed' && ['generate_paper', 'grade_paper', 'update_topic_concepts', 'rebuild_topics', 'rebuild_index'].includes(task.type);
}

async function archiveTask(taskId) {
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/archive`, { method: 'POST', body: {} });
    notify('任务已归档');
    await loadTasks();
  } catch (error) {
    notify(error.message || '归档失败');
  }
}

async function deleteTask(taskId) {
  await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
  notify('任务已删除');
  await loadTasks();
}

function renderTaskProgress(task) {
  const progress = Math.max(0, Math.min(100, Number(task.progress || 0)));
  const estimate = task.estimated_seconds ? formatDuration(task.estimated_seconds) : '未知';
  const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
  const endTime = terminal ? Date.parse(task.finished_at || task.updated_at || task.started_at || Date.now()) : Date.now();
  const elapsed = task.started_at ? formatDuration(Math.max(0, (endTime - Date.parse(task.started_at)) / 1000)) : '0秒';
  const stage = task.stage || (task.status === 'queued' ? '排队中' : task.status);
  return `
    <div class="progress-wrap">
      <div class="progress-meta">
        <span>${escapeHtml(stage)}</span>
        <span>${Math.round(progress)}% · 预计 ${escapeHtml(estimate)} · 已用 ${escapeHtml(elapsed)}</span>
      </div>
      <div class="progress-bar" aria-label="任务进度">
        <span style="width: ${progress}%"></span>
      </div>
    </div>
  `;
}

function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total < 60) return `${total}秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${minutes}分${rest}秒` : `${minutes}分钟`;
}

async function loadPaper(paperId) {
  state.currentPaper = await api(`/api/papers/${paperId}`);
  renderPaper();
  await loadFeedback();
}

function renderPaper() {
  const paper = state.currentPaper;
  if (!paper) return;
  el('paperInfo').textContent = `${paper.paper_id} · ${paper.mode} · ${paper.question_count} 题 · ${paper.status}`;
  const normal = (paper.questions || []).map((question, index) => renderQuestion(question, index + 1)).join('');
  const chains = (paper.chains || []).map((chain, chainIndex) => `
    <div class="chain">
      <h3>追问链 ${chainIndex + 1}：${escapeHtml(chain.topic || '')}</h3>
      <div class="muted">${escapeHtml(chain.chain_goal || '')}</div>
      ${(chain.questions || []).map((question, index) => renderQuestion(question, index + 1, chainIndex + 1)).join('')}
    </div>
  `).join('');
  el('paper').innerHTML = normal + chains;
  for (const button of document.querySelectorAll('[data-voice-start]')) {
    button.addEventListener('click', () => startVoice(button.dataset.voiceStart));
  }
  for (const button of document.querySelectorAll('[data-voice-stop]')) {
    button.addEventListener('click', stopVoice);
  }
  for (const button of document.querySelectorAll('[data-clear]')) {
    button.addEventListener('click', () => {
      const box = document.querySelector(`[data-answer="${CSS.escape(button.dataset.clear)}"]`);
      if (box) box.value = '';
    });
  }
}

function renderQuestion(question, index, chainIndex = null) {
  const answer = state.currentPaper.answers?.[question.question_id] || '';
  const review = state.currentPaper.grade?.reviews?.find((item) => item.question_id === question.question_id);
  const label = chainIndex ? `链 ${chainIndex} / 第 ${index} 问` : `第 ${index} 题`;
  return `
    <article class="question">
      <div class="question-head">
        <div>
          <strong>${label}</strong>
          <div>${escapeHtml(question.question || '')}</div>
          <div class="source">${escapeHtml(question.topic || '')} · ${escapeHtml(question.source_type || '')} · ${escapeHtml(question.difficulty || '')}</div>
        </div>
        ${review ? `<span class="status">${review.score} 分 · ${escapeHtml(review.level)}</span>` : ''}
      </div>
      <textarea class="answer" data-answer="${escapeHtml(question.question_id)}" placeholder="语音输入或直接输入答案">${escapeHtml(answer)}</textarea>
      <div class="voice-row">
        <button class="secondary" data-voice-start="${escapeHtml(question.question_id)}">开始说话</button>
        <button class="secondary" data-voice-stop="${escapeHtml(question.question_id)}">停止</button>
        <button class="secondary" data-clear="${escapeHtml(question.question_id)}">清空</button>
      </div>
      ${review ? `
        <div class="review">
          <p><strong>反馈：</strong>${escapeHtml(review.feedback || '')}</p>
          <p><strong>遗漏：</strong>${escapeHtml((review.missed_points || []).join('；') || '无')}</p>
        </div>
      ` : ''}
    </article>
  `;
}

function collectAnswers() {
  const answers = {};
  for (const box of document.querySelectorAll('[data-answer]')) {
    answers[box.dataset.answer] = box.value.trim();
  }
  return answers;
}

async function saveAnswers() {
  if (!state.currentPaper) return notify('还没有试卷');
  await api(`/api/papers/${state.currentPaper.paper_id}/answers`, {
    method: 'POST',
    body: { answers: collectAnswers() }
  });
  notify('答案已保存');
  await loadPaper(state.currentPaper.paper_id);
}

async function gradePaper() {
  if (!state.currentPaper) return notify('还没有试卷');
  const answers = collectAnswers();
  const missing = flattenCurrentPaperQuestions().filter((question) => !answers[question.question_id]);
  if (missing.length) {
    return notify(`试卷尚未完整作答，还有 ${missing.length} 题未回答，不能提交评分。`);
  }
  await api(`/api/papers/${state.currentPaper.paper_id}/answers`, {
    method: 'POST',
    body: { answers }
  });
  const task = await api(`/api/papers/${state.currentPaper.paper_id}/grade`, { method: 'POST', body: {} });
  notify(`评分任务已排队：${task.task_id}`);
  await loadTasks();
}

function flattenCurrentPaperQuestions() {
  const paper = state.currentPaper || {};
  return [
    ...(paper.questions || []),
    ...(paper.chains || []).flatMap((chain) => chain.questions || [])
  ];
}

async function loadFeedback() {
  if (!state.currentPaper) {
    el('feedback').textContent = '';
    return;
  }
  const data = await api(`/api/feedback/${state.currentPaper.paper_id}`).catch(() => ({ markdown: '' }));
  el('feedback').textContent = data.markdown || '评分完成后会生成反馈文件。';
}

function startVoice(questionId) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return notify('当前浏览器不支持 Web Speech API，请使用 Chrome 或直接输入文本。');
  stopVoice();
  const box = document.querySelector(`[data-answer="${CSS.escape(questionId)}"]`);
  if (!box) return;
  const recognition = new SpeechRecognition();
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    let finalText = '';
    let interimText = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += text;
      else interimText += text;
    }
    if (finalText) box.value = `${box.value}${finalText}`;
    box.placeholder = interimText || '正在听...';
  };
  recognition.onerror = (event) => notify(`语音识别错误：${event.error}`);
  recognition.onend = () => {
    if (state.recordingQuestionId === questionId) state.recordingQuestionId = null;
  };
  state.recognition = recognition;
  state.recordingQuestionId = questionId;
  recognition.start();
  notify('开始语音输入');
}

function stopVoice() {
  if (state.recognition) {
    state.recognition.stop();
    state.recognition = null;
    state.recordingQuestionId = null;
    notify('已停止语音输入');
  }
}

function notify(message) {
  el('topicStatus').textContent = message;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
