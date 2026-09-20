import {
  buildClarification,
  buildRecordPreview,
  normalizeAssistantCommand,
} from './saldo-assistant-contract.mjs';

const STATES = new Set(['closed', 'idle', 'submitting', 'preview', 'clarification', 'recording', 'error', 'quota']);
const VOICE_MIME = 'audio/webm;codecs=opus';
const RECORDING_LIMIT_MS = 60_000;
// Fala normal ao telefone fica por volta de .05 nessa medida. Multiplicando por
// 6, isso vira uma onda de tres quartos da altura — cheia sem encostar no teto.
const NIVEL_GANHO = 6;

const COPY = Object.freeze({
  auth: 'Entre na sua conta para usar o assistente. Os lançamentos manuais continuam disponíveis.',
  offline: 'Você está offline. O assistente precisa de internet, mas os formulários manuais continuam funcionando.',
  quota: 'O limite gratuito do assistente acabou por hoje. Você ainda pode registrar tudo manualmente.',
  providerLimit: 'O assistente está instável agora. Tente novamente quando quiser ou use o registro manual.',
  providerError: 'Não foi possível processar esse pedido agora. O registro manual continua disponível.',
  invalid: 'Não consegui transformar esse pedido com segurança. Escreva com mais detalhes ou registre manualmente.',
  permission: 'Não consegui acessar o microfone. Você ainda pode digitar seu pedido ou registrar manualmente.',
  unsupported: 'Gravação de voz indisponível neste navegador. O campo de texto continua funcionando.',
  semAudio: 'Não captei nenhum som nessa gravação. Fale mais perto do microfone e tente de novo, ou escreva o pedido.',
  semImagem: 'Não consegui ler esse arquivo como imagem. Tente outro print.',
});

function cloneState(state) {
  return {
    status: state.status,
    message: state.message,
    command: state.command,
    previewText: state.previewText,
    reportOutput: state.reportOutput,
    errorCode: state.errorCode,
    recordingMs: state.recordingMs,
    // O que o aparelho ouviu e se a leitura foi fraca: sem estes dois a tela
    // nunca sabia mostrar a fala do motorista nem o aviso de conferir.
    transcript: state.transcript,
    incerto: state.incerto,
    // Campo novo tem de entrar aqui tambem: o que nao esta nesta lista e
    // descartado em silencio e nunca chega na tela.
    detalhe: state.detalhe,
    // O que a conta da propria tela do print disse. Campo novo tem de entrar
    // aqui: o que nao esta nesta lista e descartado em silencio.
    conferencia: state.conferencia,
    // A frase que gerou o estado atual. Sem ela, responder "99" a uma pergunta
    // do assistente comecava um pedido novo do zero, sem o print nem os
    // numeros — e a resposta do motorista se perdia.
    pedido: state.pedido,
  };
}

// O servidor manda { motivo: [...], leitura: '...' }. Vira uma linha so, curta,
// e qualquer formato inesperado simplesmente nao aparece.
function detalheLegivel(bruto) {
  if (!bruto || typeof bruto !== 'object') return '';
  const motivo = Array.isArray(bruto.motivo) ? bruto.motivo.filter((m) => typeof m === 'string') : [];
  const leitura = typeof bruto.leitura === 'string' ? bruto.leitura.trim() : '';
  if (!motivo.length && !leitura) return '';
  const cabeca = motivo.length ? motivo.join('; ') : 'recusado sem motivo declarado';
  return leitura ? `${cabeca} · o modelo respondeu: ${leitura.slice(0, 300)}` : cabeca;
}

function safeNow(now) {
  const value = Number(now());
  return Number.isFinite(value) ? value : Date.now();
}

function defaultEndpoint() {
  const url = globalThis.SALDO_FINAL_CONFIG?.url;
  return url ? `${url}/functions/v1/ai-assistant` : '';
}

function recorderSupported(MediaRecorderCtor) {
  return typeof MediaRecorderCtor === 'function';
}

function normalizeDuration(ms) {
  return String(Math.max(1, Math.min(RECORDING_LIMIT_MS, Math.round(ms || 1))));
}

export function createAssistantClient({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  endpoint = defaultEndpoint(),
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderCtor = globalThis.MediaRecorder,
  AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext,
  now = () => Date.now(),
  today = () => new Date().toISOString().slice(0, 10),
  bridge = {},
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl obrigatório');

  let state = {
    status: 'closed',
    message: '',
    command: null,
    previewText: '',
    reportOutput: '',
    errorCode: '',
    recordingMs: 0,
    transcript: '',
    incerto: false,
    detalhe: '',
    conferencia: null,
    pedido: '',
  };
  let recorder = null;
  let recordingStream = null;
  let audioContext = null;
  let analisador = null;
  let amostras = null;
  let recordingStartedAt = 0;
  let recordingMime = '';
  let chunks = [];
  let capTimer = null;
  let tickTimer = null;
  let confirming = false;
  let confirmedPreview = null;

  const setTimeoutFn = bridge.setTimeout ?? globalThis.setTimeout?.bind(globalThis);
  const clearTimeoutFn = bridge.clearTimeout ?? globalThis.clearTimeout?.bind(globalThis);
  const setIntervalFn = bridge.setInterval ?? globalThis.setInterval?.bind(globalThis);
  const clearIntervalFn = bridge.clearInterval ?? globalThis.clearInterval?.bind(globalThis);

  function setState(patch) {
    const next = { ...state, ...patch };
    if (!STATES.has(next.status)) throw new Error(`Estado inválido: ${next.status}`);
    state = next;
    bridge.onStateChange?.(cloneState(state));
    return cloneState(state);
  }

  function clearTimers() {
    if (capTimer && clearTimeoutFn) clearTimeoutFn(capTimer);
    if (tickTimer && clearIntervalFn) clearIntervalFn(tickTimer);
    capTimer = null;
    tickTimer = null;
  }

  // A onda na tela mexia sozinha o tempo todo, mesmo no silencio: era animacao
  // de CSS, nao o microfone. Quem escuta de verdade e este analisador.
  //
  // Falhar aqui nao pode derrubar nada: a onda e enfeite, o audio nao. Por isso
  // todo o bloco vive dentro de try e, se cair, a gravacao segue igual — so com
  // a onda parada.
  function ouvirNivel(stream) {
    if (typeof AudioContextCtor !== 'function') return;
    try {
      audioContext = new AudioContextCtor();
      audioContext.resume?.();
      const fonte = audioContext.createMediaStreamSource(stream);
      analisador = audioContext.createAnalyser();
      analisador.fftSize = 512;
      amostras = new Uint8Array(analisador.fftSize);
      fonte.connect(analisador);
    } catch {
      pararDeOuvir();
    }
  }

  function pararDeOuvir() {
    try { audioContext?.close?.(); } catch {}
    audioContext = null;
    analisador = null;
    amostras = null;
  }

  // 0 no silencio, 1 num grito. A conta e a distancia media da onda ate o
  // centro (128) — o volume medio do trecho, nao o pico, que dispara com
  // qualquer estalo e faria a onda tremer sem ninguem falar.
  function getMicLevel() {
    if (!analisador || !amostras || state.status !== 'recording') return 0;
    analisador.getByteTimeDomainData(amostras);
    let soma = 0;
    for (const amostra of amostras) soma += Math.abs(amostra - 128);
    const media = soma / amostras.length / 128;
    return Math.max(0, Math.min(1, media * NIVEL_GANHO));
  }

  function releaseTracks() {
    for (const track of recordingStream?.getTracks?.() ?? []) track.stop?.();
    recordingStream = null;
    pararDeOuvir();
  }

  function resetPreview(status = 'idle') {
    confirming = false;
    confirmedPreview = null;
    return setState({ status, command: null, previewText: '', message: '', errorCode: '', reportOutput: '', recordingMs: 0, transcript: '', incerto: false, detalhe: '' });
  }

  function safeMessageForCode(code) {
    if (code === 'AI_UNAUTHENTICATED') return COPY.auth;
    if (code === 'AI_OFFLINE') return COPY.offline;
    if (code === 'AI_QUOTA_EXHAUSTED') return COPY.quota;
    if (code === 'AI_PROVIDER_LIMIT') return COPY.providerLimit;
    if (code === 'AI_INVALID_COMMAND') return COPY.invalid;
    return COPY.providerError;
  }

  async function accessToken() {
    const token = await bridge.getAccessToken?.();
    return typeof token === 'string' ? token : '';
  }

  function online() {
    if (typeof bridge.isOnline === 'function') return bridge.isOnline() !== false;
    return globalThis.navigator?.onLine !== false;
  }

  async function preflight() {
    if (!online()) {
      setState({ status: 'error', message: COPY.offline, errorCode: 'AI_OFFLINE' });
      return null;
    }
    const token = await accessToken();
    if (!token) {
      setState({ status: 'error', message: COPY.auth, errorCode: 'AI_UNAUTHENTICATED' });
      return null;
    }
    return token;
  }

  function handleCommand(rawCommand) {
    const normalized = normalizeAssistantCommand(rawCommand, { today: today() });
    if (!normalized.ok) {
      // O servidor aceitou e mandou o comando; quem recusou foi o contrato daqui.
      // Sem dizer qual dos dois barrou, a mesma mensagem cobria duas causas bem
      // diferentes e nao dava para saber onde procurar.
      return setState({ status: 'clarification', message: COPY.invalid, command: null, previewText: '',
        errorCode: 'AI_INVALID_COMMAND',
        detalhe: detalheLegivel({ motivo: normalized.errors ?? ['recusa no aparelho'], leitura: '' }) });
    }
    const command = normalized.command;
    if (command.kind === 'clarification') {
      return setState({ status: 'clarification', message: buildClarification(command), command, previewText: '', errorCode: '' });
    }
    if (command.kind === 'report') {
      if (command.report?.period === 'custom' && !command.report?.date) {
        return setState({
          status: 'clarification',
          message: 'Informe a data exata desse relatório (ex: 10/09 ou 2026-09-10).',
          command: null,
          previewText: '',
          reportOutput: '',
          errorCode: '',
        });
      }
      const snapshot = bridge.getLocalSnapshot?.(command.report) ?? {};
      const reportOutput = bridge.renderReport?.(command, snapshot) ?? command.message;
      return setState({ status: 'idle', message: command.message, command: null, previewText: '', reportOutput, errorCode: '' });
    }
    return setState({ status: 'preview', message: command.message, command,
      previewText: buildRecordPreview(command), reportOutput: '', errorCode: '',
      incerto: command.incerto === true });
  }

  async function handleResponse(response) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      setState({ status: 'error', message: COPY.providerError, errorCode: 'AI_PROVIDER_ERROR' });
      return cloneState(state);
    }
    if (!response.ok || body?.ok === false) {
      const code = body?.code || 'AI_PROVIDER_ERROR';
      return setState({
        transcript: typeof body?.transcript === 'string' ? body.transcript : '',
        // O motivo tecnico da recusa, quando o servidor manda. Sem ele a tela so
        // sabia dizer "nao consegui", e descobrir a causa custava uma ida e
        // volta com o motorista a cada tentativa.
        detalhe: detalheLegivel(body?.detalhe),
        status: code === 'AI_QUOTA_EXHAUSTED' ? 'quota' : 'error',
        message: safeMessageForCode(code),
        errorCode: code,
        command: null,
        previewText: '',
      });
    }
    // A transcricao da voz e a frase montada a partir do print sao o PEDIDO,
    // nao so um texto para mostrar: e ela que o motorista completa quando o
    // assistente pergunta o que faltou.
    if (typeof body?.transcript === 'string' && body.transcript) setState({ transcript: body.transcript, pedido: body.transcript });
    // "13 x 11,99 = 155,87, mas a tela diz 24,20": quando a conta da propria
    // tela nao fecha, o motorista tem de ver isso ANTES de salvar.
    setState({ conferencia: body?.conferencia?.confere === false ? String(body.conferencia.motivo || '') : null });
    return handleCommand(body.command);
  }

  // O print da tela de ganhos. Vai junto com o texto que o motorista escreveu
  // ou falou, porque a tela da 99 nao mostra km nem horas — a imagem da o que
  // ela tem e a frase dele completa o resto.
  async function submitImage(file, text = '') {
    if (!file || typeof file.size !== 'number') {
      return setState({ status: 'error', message: COPY.semImagem, errorCode: 'IMAGE_EMPTY' });
    }
    if (file.size <= 0) {
      return setState({ status: 'error', message: COPY.semImagem, errorCode: 'IMAGE_EMPTY' });
    }
    const token = await preflight();
    if (!token) return cloneState(state);
    const form = new FormData();
    form.set('mode', 'image');
    form.set('image', file, file.name || 'print.jpg');
    if (String(text || '').trim()) form.set('text', String(text).trim());
    setState({ status: 'submitting', message: 'Lendo o print...', errorCode: '', reportOutput: '', conferencia: null });
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      return handleResponse(response);
    } catch {
      return setState({ status: 'error', message: COPY.offline, errorCode: 'AI_OFFLINE' });
    }
  }

  async function sendJson(text) {
    const token = await preflight();
    if (!token) return cloneState(state);
    setState({ status: 'submitting', message: 'Analisando seu pedido...', errorCode: '', reportOutput: '', pedido: text });
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: 'text', text }),
      });
      return handleResponse(response);
    } catch {
      return setState({ status: 'error', message: COPY.offline, errorCode: 'AI_OFFLINE' });
    }
  }

  async function sendVoice(blob, durationMs) {
    const token = await preflight();
    if (!token) return cloneState(state);
    const form = new FormData();
    form.set('mode', 'voice');
    form.set('duration_ms', normalizeDuration(durationMs));
    // O nome do arquivo segue o formato real: o iPhone grava mp4/AAC, nao webm.
    const extensao = /mp4|m4a|aac/i.test(blob.type) ? 'mp4' : (/ogg/i.test(blob.type) ? 'ogg' : 'webm');
    form.set('audio', blob, `assistant.${extensao}`);
    setState({ status: 'submitting', message: 'Transcrevendo áudio...', errorCode: '', reportOutput: '' });
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      return handleResponse(response);
    } catch {
      return setState({ status: 'error', message: COPY.offline, errorCode: 'AI_OFFLINE' });
    }
  }

  function discardRecording() {
    clearTimers();
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try { recorder.stop(); } catch {}
    }
    recorder = null;
    chunks = [];
    releaseTracks();
    recordingStartedAt = 0;
    recordingMime = '';
  }

  async function startRecording() {
    if (!recorderSupported(MediaRecorderCtor) || typeof mediaDevices?.getUserMedia !== 'function') {
      return setState({ status: 'error', message: COPY.unsupported, errorCode: 'VOICE_UNSUPPORTED' });
    }
    try {
      const stream = await mediaDevices.getUserMedia({ audio: true });
      recordingStream = stream;
      ouvirNivel(stream);
      recordingMime = typeof MediaRecorderCtor.isTypeSupported === 'function' && MediaRecorderCtor.isTypeSupported(VOICE_MIME) ? VOICE_MIME : '';
      recorder = recordingMime ? new MediaRecorderCtor(stream, { mimeType: recordingMime }) : new MediaRecorderCtor(stream);
      chunks = [];
      recorder.ondataavailable = (event) => {
        if (event?.data?.size !== 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        discardRecording();
        setState({ status: 'error', message: COPY.providerError, errorCode: 'VOICE_RECORDING_ERROR' });
      };
      recordingStartedAt = safeNow(now);
      // Sem fatia de tempo o audio so e entregue na parada, e no iPhone essa
      // entrega final falha calada: sobra uma gravacao de zero byte. Pedindo
      // um pedaco por segundo, o que ja foi falado esta salvo mesmo se a
      // ultima entrega se perder.
      recorder.start(1000);
      setState({ status: 'recording', message: 'Gravando...', recordingMs: 0, errorCode: '' });
      if (setIntervalFn) {
        tickTimer = setIntervalFn(() => setState({ recordingMs: safeNow(now) - recordingStartedAt }), 250);
      }
      if (setTimeoutFn) capTimer = setTimeoutFn(() => { stopRecording(); }, RECORDING_LIMIT_MS);
      return cloneState(state);
    } catch (error) {
      releaseTracks();
      return setState({
        status: 'error',
        message: COPY.permission,
        errorCode: error?.name === 'NotAllowedError' ? 'VOICE_PERMISSION_DENIED' : 'VOICE_RECORDING_ERROR',
      });
    }
  }

  async function stopRecording() {
    if (!recorder || state.status !== 'recording') return cloneState(state);
    clearTimers();
    const durationMs = safeNow(now) - recordingStartedAt;
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.requestData?.();
    try { recorder.stop(); } catch {}
    await stopped;
    const type = recordingMime || chunks.find((chunk) => chunk?.type)?.type || 'audio/webm';
    const blob = new Blob(chunks, { type });
    recorder = null;
    chunks = [];
    releaseTracks();
    recordingStartedAt = 0;
    recordingMime = '';
    // Gravacao vazia seguia para o servidor e voltava como "nao consegui
    // transformar esse pedido" — a frase de quando a IA nao entende, sendo que
    // ela nem chegou a ser chamada. O motorista tem de saber que o problema foi
    // o microfone, nao o que ele falou.
    if (blob.size <= 0) {
      return setState({
        status: 'error',
        message: COPY.semAudio,
        errorCode: 'VOICE_EMPTY',
        detalhe: detalheLegivel({ motivo: [`a gravacao terminou com 0 byte apos ${Math.round(durationMs)} ms`], leitura: '' }),
      });
    }
    return sendVoice(blob, durationMs);
  }

  function open() {
    if (state.status === 'closed') return resetPreview('idle');
    return cloneState(state);
  }

  function close() {
    discardRecording();
    return resetPreview('closed');
  }

  async function submitText(text) {
    const clean = String(text ?? '').trim();
    if (!clean) return setState({ status: 'idle', message: 'Digite o que você quer registrar.', errorCode: '' });
    return sendJson(clean);
  }

  // Responder o que faltou sem reescrever tudo. A tela de ganhos nunca diz de
  // que aplicativo ela e, entao o print SEMPRE ia parar numa pergunta pela
  // plataforma — e a unica saida era o motorista adivinhar que precisava ter
  // digitado antes de escolher a imagem.
  //
  // Manda o pedido inteiro de novo com a resposta no fim, que e onde o
  // contrato ja trata o que o motorista diz como palavra final.
  async function completarPedido(extra) {
    const resposta = String(extra ?? '').trim();
    const anterior = String(state.pedido || '').trim();
    if (!resposta || !anterior) return cloneState(state);
    return sendJson(`${anterior}. ${resposta}`);
  }

  // Desistir da gravacao no meio: solta o microfone, zera o cronometro e volta
  // para a conversa parada, sem mandar nada. Antes a lixeira chamava
  // cancelPreview, que so age quando ja existe uma previa — entao ela nao fazia
  // nada e so dava para desistir fechando a conversa inteira.
  function cancelRecording() {
    if (state.status !== 'recording') return cloneState(state);
    discardRecording();
    return setState({ status: 'idle', message: '', errorCode: '', recordingMs: 0 });
  }

  function cancelPreview() {
    if (state.status === 'preview' || state.status === 'clarification' || state.status === 'error' || state.status === 'quota') {
      return resetPreview('idle');
    }
    return cloneState(state);
  }

  async function confirmPreview() {
    const command = state.command;
    if (state.status !== 'preview' || command?.kind !== 'records' || confirming || confirmedPreview === command) return cloneState(state);
    confirming = true;
    try {
      await bridge.confirmPreview?.(command);
      confirmedPreview = command;
      return resetPreview('closed');
    } catch {
      confirming = false;
      return setState({ status: 'error', message: 'Não foi possível salvar os registros. Tente novamente.', errorCode: 'SAVE_FAILED' });
    }
  }

  function destroy() {
    discardRecording();
    return resetPreview('closed');
  }

  return {
    open,
    close,
    submitText,
    completarPedido,
    submitImage,
    startRecording,
    stopRecording,
    cancelRecording,
    cancelPreview,
    confirmPreview,
    getState: () => cloneState(state),
    // Fica fora do estado de proposito: a tela le isso 60 vezes por segundo, e
    // um estado que muda 60 vezes por segundo redesenharia a conversa inteira
    // a cada quadro.
    getMicLevel,
    destroy,
  };
}
