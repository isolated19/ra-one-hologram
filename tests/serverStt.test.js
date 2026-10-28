import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ServerSttClient } from '../src/audio/ServerSttClient.js';
import { WakeWordDetector } from '../src/audio/WakeWordDetector.js';
import { SpeechRecognitionService } from '../src/audio/SpeechRecognitionService.js';
import { VoiceInteractionController } from '../src/assistant/VoiceInteractionController.js';

class FakeWS {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.last = this;
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() {
    this.readyState = 1;
    this.push({ type: 'ready', mode: 'off', sample_rate: 16000, frame_ms: 20 });
  }
  push(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  modes() {
    return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d));
  }
  lastMode() { return this.modes().at(-1); }
}

function connectedClient() {
  const client = new ServerSttClient({ url: 'ws://test/ws/stt', WebSocketImpl: FakeWS });
  client.connect();
  FakeWS.last.open();
  return { client, ws: FakeWS.last };
}

describe('ServerSttClient', () => {
  it('replays the requested mode once the socket is ready', () => {
    const client = new ServerSttClient({ url: 'ws://test', WebSocketImpl: FakeWS });
    client.connect();
    const seq = client.setMode('wake');
    expect(FakeWS.last.sent).toEqual([]);
    FakeWS.last.open();
    expect(FakeWS.last.lastMode()).toEqual({ cmd: 'mode', value: 'wake', seq });
  });

  it('drops events tagged with an older seq', () => {
    const { client, ws } = connectedClient();
    const finals = [];
    client.on('final', (e) => finals.push(e));
    const old = client.setMode('question');
    client.setMode('off');
    ws.push({ type: 'final', text: 'late', seq: old });
    expect(finals).toEqual([]);
  });

  it('only streams audio while a mode is active', () => {
    const { client, ws } = connectedClient();
    const buf = new ArrayBuffer(640);
    client._sendAudio(buf);
    expect(ws.sent.includes(buf)).toBe(false);
    client.setMode('wake');
    client._sendAudio(buf);
    expect(ws.sent.includes(buf)).toBe(true);
  });

  it('server-initiated mode off stops audio', () => {
    const { client, ws } = connectedClient();
    const seq = client.setMode('wake');
    ws.push({ type: 'mode', mode: 'off', seq });
    expect(client.mode).toBe('off');
  });
});

describe('WakeWordDetector (server provider)', () => {
  it('emits started on ack and wake with remainder', () => {
    const { client, ws } = connectedClient();
    const wake = new WakeWordDetector({ serverClient: client });
    const started = vi.fn();
    const woke = vi.fn();
    wake.on('started', started);
    wake.on('wake', woke);
    wake.start();
    const { seq } = ws.lastMode();
    ws.push({ type: 'mode', mode: 'wake', seq });
    expect(started).toHaveBeenCalled();
    ws.push({ type: 'wake', transcript: 'Hey RA-ONE, what time is it?', remainder: 'what time is it', greeting: 'hey', confidence: 0.8, seq });
    expect(woke).toHaveBeenCalledWith(expect.objectContaining({ remainder: 'what time is it', greeting: 'hey' }));
    expect(wake.running).toBe(false);
  });

  it('a disarmed wake is swallowed and listening resumes', () => {
    const { client, ws } = connectedClient();
    const wake = new WakeWordDetector({ serverClient: client });
    const woke = vi.fn();
    wake.on('wake', woke);
    wake.start();
    wake.setArmed(false);
    ws.push({ type: 'wake', remainder: '', seq: ws.lastMode().seq });
    expect(woke).not.toHaveBeenCalled();
    expect(ws.lastMode().value).toBe('wake');
    expect(wake.running).toBe(true);
  });

  it('stop() does not cancel a question owned by STT', () => {
    const { client, ws } = connectedClient();
    const wake = new WakeWordDetector({ serverClient: client });
    const stt = new SpeechRecognitionService({ serverClient: client });
    wake.start();
    stt.startQuestionCapture();
    wake.stop();
    expect(ws.lastMode().value).toBe('question');
  });
});

describe('SpeechRecognitionService (server provider)', () => {
  let client;
  let ws;
  let stt;
  beforeEach(() => {
    ({ client, ws } = connectedClient());
    stt = new SpeechRecognitionService({ serverClient: client });
  });

  it('sends question mode with grace/max and emits partial + final', () => {
    const partial = vi.fn();
    const final = vi.fn();
    stt.on('partial', partial);
    stt.on('final', final);
    expect(stt.startQuestionCapture({ timeoutMs: 9000, initialGraceMs: 4000 })).toBe(true);
    const req = ws.lastMode();
    expect(req).toMatchObject({ value: 'question', grace_ms: 4000, max_ms: 9000 });
    ws.push({ type: 'partial', mode: 'question', text: 'what time', seq: req.seq });
    ws.push({ type: 'final', text: 'What time is it?', reason: 'silence', seq: req.seq });
    expect(partial).toHaveBeenCalledWith(expect.objectContaining({ text: 'what time' }));
    expect(final).toHaveBeenCalledWith({ text: 'What time is it?', reason: 'silence' });
    expect(stt.listening).toBe(false);
  });

  it('maps server empty to empty', () => {
    const empty = vi.fn();
    stt.on('empty', empty);
    stt.startQuestionCapture();
    ws.push({ type: 'empty', reason: 'no-speech', seq: ws.lastMode().seq });
    expect(empty).toHaveBeenCalledWith({ reason: 'no-speech' });
  });

  it('refuses to start while the backend is unreachable', () => {
    const offline = new SpeechRecognitionService({
      serverClient: new ServerSttClient({ url: 'ws://x', WebSocketImpl: FakeWS }),
    });
    const err = vi.fn();
    offline.on('error', err);
    expect(offline.startQuestionCapture()).toBe(false);
    expect(err).toHaveBeenCalledWith(expect.objectContaining({ error: 'server-unreachable' }));
  });

  it('disconnect mid-question ends the capture', () => {
    const err = vi.fn();
    const empty = vi.fn();
    stt.on('error', err);
    stt.on('empty', empty);
    stt.startQuestionCapture();
    ws.close();
    expect(err).toHaveBeenCalledWith({ error: 'server-disconnected' });
    expect(empty).toHaveBeenCalledWith({ reason: 'disconnected' });
  });

  it('cancel() turns the server off and ignores the late final', () => {
    const final = vi.fn();
    stt.on('final', final);
    stt.startQuestionCapture();
    const { seq } = ws.lastMode();
    stt.cancel();
    expect(ws.lastMode().value).toBe('off');
    ws.push({ type: 'final', text: 'late', seq });
    expect(final).not.toHaveBeenCalled();
  });
});

describe('VoiceInteractionController with offline STT', () => {
  it('clap → server question → mock answer → standby', async () => {
    const { client, ws } = connectedClient();
    const voice = new VoiceInteractionController({
      assistant: { setState: vi.fn(), playEnergyPulse: vi.fn() },
      speech: { setExternalAmplitude: vi.fn(), mode: 'off' },
      character: { setSleeping: vi.fn(), triggerWake: vi.fn() },
      sttClient: client,
      sttProvider: 'server',
    });
    Object.defineProperty(voice.session, 'isActive', { get: () => true, configurable: true });
    voice.clap.start = vi.fn();
    voice.ttsEnabled = false;
    voice.useOfflineTts = false;
    voice.useMockResponses = true;
    voice.handsFree = true;
    voice.phase = 'sleeping';

    await voice._onActivation({ source: 'clap' });
    const req = ws.lastMode();
    expect(req.value).toBe('question');
    expect(voice.phase).toBe('listening');

    ws.push({ type: 'final', text: 'What can you do?', reason: 'silence', seq: req.seq });
    await vi.waitFor(() => expect(voice.lastSource).toBe('mock'));
    expect(voice.transcript).toBe('What can you do?');
    await vi.waitFor(() => expect(voice.phase).toBe('standby'));
    // Follow-up window opens a fresh question request
    expect(ws.lastMode().value).toBe('question');
    expect(ws.lastMode().seq).toBeGreaterThan(req.seq);
  });
});
