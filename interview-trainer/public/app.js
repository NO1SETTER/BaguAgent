const state = {
  topics: [],
  tasks: [],
  currentPaper: null,
  currentPaperSource: 'auto',
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
  try {
    const description = el('topicDescription').value.trim();
    if (!description) return notify('请输入技术栈关键词或自然语言描述', 'error');
    const task = await api('/api/topics/update', {
      method: 'POST',
      body: {
        description,
        concept_count: Number(el('topicConceptCount').value || 20)
      }
    });
    notify(`Topic 更新任务已排队：${task.task_id}`);
    await loadTasks();
  } catch (error) {
    notify(error.message || 'Topic 更新失败', 'error');
  }
}

async function createPaper() {
  try {
    const selected = [...document.querySelectorAll('.topic-check:checked')].map((node) => node.value);
    if (!selected.length) return notify('至少选择一个 Topic', 'error');
    const questionCount = Number(el('questionCount').value);
    const limit = topicLimitForQuestionCount(questionCount);
    if (Number.isFinite(limit) && selected.length > limit) {
      return notify(`${questionCount}题试卷最多选择${limit}个Topic，当前选择了${selected.length}个。请减少Topic数量或选择更大题量。`, 'error');
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
  } catch (error) {
    notify(error.message || '生成试卷失败', 'error');
  }
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
  if (
    latestPaperTask
    && state.currentPaperSource !== 'manual'
    && (!state.currentPaper || state.currentPaper.paper_id !== latestPaperTask.result.paper_id)
  ) {
    await loadPaper(latestPaperTask.result.paper_id, 'auto');
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
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    notify('任务已删除');
    await loadTasks();
  } catch (error) {
    notify(error.message || '删除任务失败', 'error');
  }
}

function renderTaskProgress(task) {
  const progress = Math.max(0, Math.min(100, Number(task.progress || 0)));
  const estimate = task.estimated_seconds ? formatDuration(task.estimated_seconds) : '未知';
  const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
  const endTime = terminal ? Date.parse(task.finished_at || task.updated_at || task.started_at || Date.now()) : Date.now();
  const elapsedSeconds = task.started_at ? Math.max(0, (endTime - Date.parse(task.started_at)) / 1000) : 0;
  const elapsed = formatDuration(elapsedSeconds);
  const stage = task.stage || (task.status === 'queued' ? '排队中' : task.status);
  const estimateSource = task.estimate_source === 'history' ? '历史估时' : '规则估时';
  const overtime = !terminal && task.estimated_seconds && elapsedSeconds > task.estimated_seconds * 1.2;
  const timingText = overtime
    ? `已用 ${escapeHtml(elapsed)} · 超过${escapeHtml(estimateSource)}`
    : `预计 ${escapeHtml(estimate)} · 已用 ${escapeHtml(elapsed)} · ${escapeHtml(estimateSource)}`;
  return `
    <div class="progress-wrap">
      <div class="progress-meta">
        <span>${escapeHtml(stage)}</span>
        <span>${Math.round(progress)}% · ${timingText}</span>
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

async function loadPaper(paperId, source = 'manual') {
  state.currentPaper = await api(`/api/papers/${paperId}`);
  state.currentPaperSource = source;
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
  try {
    if (!state.currentPaper) return notify('还没有试卷', 'error');
    await api(`/api/papers/${state.currentPaper.paper_id}/answers`, {
      method: 'POST',
      body: { answers: collectAnswers() }
    });
    notify('答案已保存');
    await loadPaper(state.currentPaper.paper_id);
  } catch (error) {
    notify(error.message || '保存答案失败', 'error');
  }
}

async function gradePaper() {
  try {
    if (!state.currentPaper) return notify('还没有试卷', 'error');
    const answers = collectAnswers();
    const missing = flattenCurrentPaperQuestions().filter((question) => !String(answers[question.question_id] || '').trim());
    if (missing.length) {
      return notify(`试卷尚未完整作答，还有 ${missing.length} 题未回答，不能提交评分。`, 'error');
    }
    await api(`/api/papers/${state.currentPaper.paper_id}/answers`, {
      method: 'POST',
      body: { answers }
    });
    const task = await api(`/api/papers/${state.currentPaper.paper_id}/grade`, { method: 'POST', body: {} });
    notify(`评分任务已排队：${task.task_id}`);
    await loadTasks();
  } catch (error) {
    notify(error.message || '提交评分失败', 'error');
  }
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
  const box = document.querySelector(`[data-answer="${CSS.escape(questionId)}"]`);
  if (!box) return;
  stopVoice();
  startTencentVoice(questionId, box).catch((error) => {
    stopVoice();
    notify(error.message || '语音录制失败', 'error');
  });
}

function stopVoice() {
  if (state.recognition) {
    const session = state.recognition;
    state.recognition = null;
    state.recordingQuestionId = null;
    session.stop?.();
    notify('已停止语音输入');
  }
}

async function startTencentVoice(questionId, box) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持麦克风录音');
  }
  const question = flattenCurrentPaperQuestions().find((item) => item.question_id === questionId);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const buffers = [];
  processor.onaudioprocess = (event) => {
    if (state.recordingQuestionId !== questionId) return;
    const channel = event.inputBuffer.getChannelData(0);
    buffers.push(new Float32Array(channel));
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
  state.recognition = {
    stop: async () => {
      const pcm = mergeFloat32(buffers);
      const wavBytes = encodeWavFromFloat32(pcm, audioContext.sampleRate, 16000);
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close();
      const audioBase64 = bytesToBase64(wavBytes);
      const result = await api('/api/speech/transcribe', {
        method: 'POST',
        body: {
          audio_base64: audioBase64,
          voice_format: 'wav',
          data_len: wavBytes.byteLength,
          topic: question?.topic || '',
          concept: question?.concept || '',
          expected_points: question?.expected_points || []
        }
      });
      const text = String(result.result || '').trim();
      if (text) {
        box.value = `${box.value}${box.value ? '\n' : ''}${text}`.trim();
        notify('语音转写完成');
      } else {
        notify('语音转写完成，但没有识别出文本', 'error');
      }
    },
    disconnect: () => processor.disconnect(),
    stream,
    audioContext
  };
  state.recordingQuestionId = questionId;
  box.placeholder = '正在录音...';
  notify('开始录音');
}

function mergeFloat32(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function encodeWavFromFloat32(float32, inputSampleRate, targetSampleRate) {
  const mono = downsampleBuffer(float32, inputSampleRate, targetSampleRate);
  const buffer = new ArrayBuffer(44 + mono.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + mono.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, mono.length * 2, true);
  let offset = 44;
  for (let i = 0; i < mono.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function downsampleBuffer(buffer, inputSampleRate, targetSampleRate) {
  if (targetSampleRate >= inputSampleRate) return buffer;
  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
      accum += buffer[i];
      count += 1;
    }
    result[offsetResult] = count ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function notify(message, level = 'info') {
  el('topicStatus').textContent = message;
  if (state.currentPaper && el('paperInfo')) {
    const prefix = level === 'error' ? '错误' : '提示';
    el('paperInfo').textContent = `${prefix}：${message}`;
  }
  if (level === 'error') {
    console.error(message);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
