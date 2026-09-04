/* QNR-144 web station: self-contained terminal + Web Audio front end for the bundled modem. */
(function () {
  'use strict';

  // One copy of the modem source boots this thread and the decode worker.
  var MODEM_SRC = document.getElementById('qnr-modem').textContent;
  new Function(MODEM_SRC)();

  var M = self.QNR;
  var RATE = M.info.sampleRate;

  /* ------------------------------------------------------------ decode worker */

  /**
   * The folded search is hundreds of milliseconds to tens of seconds of straight-line maths.
   * Running it on the main thread froze the page, so it runs in a Worker built from the same
   * inlined source -- no second file, no network fetch.
   */
  var worker = null, jobId = 0, jobs = {};

  function workerGlue() {
    self.onmessage = function (e) {
      var m = e.data, t0 = Date.now();
      try {
        var Q = self.QNR, samples;
        if (m.cmd === 'decode') samples = new Float32Array(m.samples);
        else {
          samples = Q.schedule(m.message, m.repeats);
          if (m.cmd === 'sim') samples = Q.simulate(samples, Q.burst(m.message), { snrDb: m.snrDb, profile: m.profile, seed: m.seed });
        }
        self.postMessage({ id: m.id, ok: true, hits: Q.decode(samples), ms: Date.now() - t0 });
      } catch (err) {
        self.postMessage({ id: m.id, ok: false, error: String(err && err.message ? err.message : err) });
      }
    };
  }

  function ensureWorker() {
    if (worker) return worker;
    var src = MODEM_SRC + '\n(' + workerGlue.toString() + ')();';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
    worker.onmessage = function (e) {
      var job = jobs[e.data.id];
      if (!job) return;
      delete jobs[e.data.id];
      job(e.data);
    };
    return worker;
  }

  function job(request, transfer) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = ensureWorker(); } catch (e) { reject(new Error('Web Workers unavailable: ' + e.message)); return; }
      var id = ++jobId;
      jobs[id] = function (msg) { msg.ok ? resolve(msg) : reject(new Error(msg.error)); };
      request.id = id;
      w.postMessage(request, transfer || []);
    });
  }

  /* ---------------------------------------------------------------- terminal */

  var outEl = document.getElementById('out');
  var inputEl = document.getElementById('input');
  var termEl = document.getElementById('term');
  var promptEl = document.getElementById('prompt');
  var buffer = '';
  var history = [];
  var histAt = 0;
  var busy = false;

  function write(text, cls) {
    var line = document.createElement('span');
    line.className = 'l' + (cls ? ' ' + cls : '');
    line.textContent = text;
    outEl.appendChild(line);
    // Keep the DOM bounded; a long session should not grow without limit.
    while (outEl.childNodes.length > 800) outEl.removeChild(outEl.firstChild);
    termEl.scrollTop = termEl.scrollHeight;
  }

  function redraw() { inputEl.textContent = buffer; }

  function setBusy(state, label) {
    busy = state;
    promptEl.textContent = state ? (label || 'working') + '...' : 'qnr>';
  }

  /** Live elapsed counter on its own line, so a long decode never looks like a hang. */
  function ticker(label) {
    var el = document.createElement('span');
    el.className = 'l c-dim';
    outEl.appendChild(el);
    var t0 = Date.now();
    var paint = function () { el.textContent = label + ' ... ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s'; };
    paint();
    termEl.scrollTop = termEl.scrollHeight;
    var timer = setInterval(paint, 100);
    return { stop: function () { clearInterval(timer); paint(); } };
  }

  var COMMANDS = {};

  function run(text) {
    var trimmed = text.trim();
    write('qnr> ' + text, 'c-dim');
    if (!trimmed) return;
    history.push(trimmed);
    if (history.length > 100) history.shift();
    histAt = history.length;

    var space = trimmed.indexOf(' ');
    var name = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
    var rest = space < 0 ? '' : trimmed.slice(space + 1).trim();
    var cmd = COMMANDS[name];
    if (!cmd) { write("unknown command '" + name + "' - try: help", 'c-red'); return; }
    try {
      var result = cmd.run(rest);
      if (result && typeof result.catch === 'function') {
        result.catch(function (e) { write('error: ' + (e && e.message ? e.message : e), 'c-red'); setBusy(false); });
      }
    } catch (e) {
      write('error: ' + (e && e.message ? e.message : e), 'c-red');
      setBusy(false);
    }
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey) {
      if (e.key === 'l') { e.preventDefault(); outEl.textContent = ''; }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      var text = buffer; buffer = ''; redraw(); run(text);
    } else if (e.key === 'Backspace') {
      e.preventDefault(); buffer = buffer.slice(0, -1); redraw();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (histAt > 0) { histAt--; buffer = history[histAt] || ''; redraw(); }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histAt < history.length - 1) { histAt++; buffer = history[histAt] || ''; }
      else { histAt = history.length; buffer = ''; }
      redraw();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      var hits = Object.keys(COMMANDS).filter(function (k) { return k.indexOf(buffer) === 0; });
      if (hits.length === 1) { buffer = hits[0] + ' '; redraw(); }
      else if (hits.length > 1) write(hits.join('  '), 'c-dim');
    } else if (e.key.length === 1) {
      buffer += e.key; redraw();
    }
  });

  termEl.addEventListener('click', function () { termEl.focus(); });
  Array.prototype.forEach.call(document.querySelectorAll('footer button'), function (b) {
    b.addEventListener('click', function () { termEl.focus(); run(b.dataset.cmd); });
  });

  /* ------------------------------------------------------------------ meters */

  var inBar = document.getElementById('inbar'), inDb = document.getElementById('indb');
  var outBar = document.getElementById('outbar'), outDb = document.getElementById('outdb');
  var rateEl = document.getElementById('ctxrate');
  var canvas = document.getElementById('spectrum');
  var ctx2d = canvas.getContext('2d');

  function showLevel(bar, label, db) {
    var norm = Math.max(0, Math.min(1, (db + 60) / 60));
    bar.style.width = (norm * 100).toFixed(1) + '%';
    label.textContent = db <= -60 ? '-inf' : db.toFixed(1) + ' dB';
  }

  function dbOf(block) {
    var sum = 0;
    for (var i = 0; i < block.length; i++) sum += block[i] * block[i];
    return 20 * Math.log10(Math.max(Math.sqrt(sum / Math.max(block.length, 1)), 1e-6));
  }

  function drawSpectrum(freqData) {
    var w = canvas.width, h = canvas.height;
    ctx2d.fillStyle = '#070a0c';
    ctx2d.fillRect(0, 0, w, h);
    if (!freqData) return;
    // Show only the modem's own passband, so the display matches the tone comb.
    var lo = Math.floor((M.info.lowHz / (RATE / 2)) * freqData.length);
    var hi = Math.ceil((M.info.highHz / (RATE / 2)) * freqData.length);
    var span = Math.max(1, hi - lo);
    for (var x = 0; x < w; x++) {
      var v = freqData[lo + Math.floor((x / w) * span)];
      if (v === undefined) continue;
      var mag = Math.max(0, Math.min(1, (v + 100) / 70));
      ctx2d.fillStyle = 'rgb(' + Math.round(60 + mag * 40) + ',' + Math.round(80 + mag * 160) + ',' + Math.round(100 + mag * 60) + ')';
      ctx2d.fillRect(x, h - mag * h, 1, mag * h);
    }
  }

  /* ------------------------------------------------------------------- audio */

  var audio = null, micStream = null, micNode = null, analyser = null, receiver = null, sinkId = null;
  var micSink = null, meterRaf = null, micWatchdog = null, blocksSeen = 0;

  /**
   * Continuous receive state. The station listens all the time -- to a remote WebSDR, to the
   * air, and to its own transmissions -- so there are two decoders running side by side, the
   * same split the command-line station uses:
   *   direct : streaming, single burst, cheap, catches loud/off-grid signals immediately
   *   folded : periodic weak-signal search over a ring of past audio, run in the Worker
   */
  var foldDepth = 2;
  var ring = null, ringWrite = 0, ringFilled = 0, ringOrigin = 0;
  var foldTimer = null, folding = false, monitor = true, autoStarted = false;
  var seen = Object.create(null);

  function ringCapacity() { return Math.round(M.info.periodSeconds * (foldDepth + 1) * RATE); }

  function resetRing() {
    ring = new Float32Array(ringCapacity());
    ringWrite = 0; ringFilled = 0; ringOrigin = 0;
  }

  function ringPush(block) {
    if (!ring) resetRing();
    for (var i = 0; i < block.length; i++) {
      ring[ringWrite] = block[i];
      ringWrite = (ringWrite + 1) % ring.length;
    }
    ringFilled = Math.min(ring.length, ringFilled + block.length);
  }

  function ringOrdered() {
    var out = new Float32Array(ringFilled);
    var start = (ringWrite - ringFilled + ring.length) % ring.length;
    for (var i = 0; i < ringFilled; i++) out[i] = ring[(start + i) % ring.length];
    return out;
  }

  /** Suppresses the same message arriving twice (mic bleed plus self-monitor, or repeats). */
  function report(text, how) {
    var now = Date.now();
    if (seen[text] && now - seen[text] < M.info.periodSeconds * 2000) return;
    seen[text] = now;
    write('  >> "' + text + '"   [CRC OK]  ' + how + '  ' + new Date().toLocaleTimeString(), 'c-rx');
  }

  function setRxState(label) {
    var el = document.getElementById('rxstate');
    if (el) el.textContent = 'rx: ' + label;
  }

  function foldNow() {
    if (folding || !ring || ringFilled < M.info.burstSeconds * RATE) return;
    folding = true;
    setRxState('folding ' + (ringFilled / RATE).toFixed(0) + ' s');
    var samples = ringOrdered();
    job({ cmd: 'decode', samples: samples.buffer }, [samples.buffer])
      .then(function (r) {
        r.hits.forEach(function (h) { report(h.text, h.bursts + 'x LLR folded'); });
        setRxState('listening');
      }, function () { setRxState('listening'); })
      .then(function () { folding = false; });
  }

  function startFolding() {
    if (foldTimer) return;
    foldTimer = setInterval(foldNow, M.info.periodSeconds * 1000);
  }

  /** Runs an outgoing burst through its own decoder instance, so self-monitoring never
   * disturbs the streaming state machine that is tracking the microphone. */
  function selfMonitor(samples) {
    var rx = M.liveReceiver(function (text) { report(text, 'self'); });
    var step = 4096;
    for (var i = 0; i < samples.length; i += step) {
      rx.push(samples.subarray(i, Math.min(i + step, samples.length)));
    }
  }

  function context() {
    if (!audio) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('this browser has no Web Audio support');
      audio = new Ctor({ sampleRate: RATE });
      rateEl.textContent = 'audio: ' + audio.sampleRate + ' Hz';
      // One permanent input analyser: the IN meter shows everything entering the receive
      // chain -- a microphone or WebSDR feed, and our own transmissions when monitoring --
      // rather than going dead whenever there is no live capture device.
      analyser = audio.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.3;
      startMeter();
      if (Math.abs(audio.sampleRate - RATE) > 1) {
        write('warning: browser gave ' + audio.sampleRate + ' Hz, not ' + RATE + ' Hz.', 'c-amber');
        write('  tones are generated at the context rate, so two browsers at different rates', 'c-amber');
        write('  will still interoperate, but a WAV exported here is at ' + audio.sampleRate + ' Hz.', 'c-amber');
      }
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }

  function play(samples) {
    var ac = context();
    return new Promise(function (resolve, reject) {
      var buf = ac.createBuffer(1, samples.length, ac.sampleRate);
      buf.copyToChannel(samples, 0);
      var src = ac.createBufferSource();
      src.buffer = buf;
      var gain = ac.createGain();
      src.connect(gain).connect(ac.destination);
      // Our own transmission is audio entering the station too, so it drives the IN meter and
      // spectrum as well -- this is the "always listen to ourselves" path made visible.
      if (monitor && analyser) src.connect(analyser);
      var peak = 0;
      for (var i = 0; i < samples.length; i += 64) peak = Math.max(peak, Math.abs(samples[i]));
      showLevel(outBar, outDb, 20 * Math.log10(Math.max(peak, 1e-6)));
      src.onended = function () { showLevel(outBar, outDb, -60); resolve(); };
      try { src.start(); } catch (e) { reject(e); }
    });
  }

  function setSink() {
    if (!sinkId || !audio || typeof audio.setSinkId !== 'function') return Promise.resolve(false);
    return audio.setSinkId(sinkId).then(function () { return true; }, function () { return false; });
  }

  async function micOn() {
    if (micStream) { write('mic already on', 'c-amber'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no microphone API in this browser');
    var ac = context();
    // Every one of these would destroy a weak MFSK signal, so they are all disabled.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: 1, sampleRate: RATE
      }
    });
    var source = ac.createMediaStreamSource(micStream);

    // A Web Audio node only runs if it reaches the destination. Without this muted sink the
    // AudioWorklet's process() is never called, so neither the meter nor the decoder sees
    // anything. The gain is zero so the microphone is never fed back to the speakers.
    micSink = ac.createGain();
    micSink.gain.value = 0;
    micSink.connect(ac.destination);
    source.connect(analyser);
    analyser.connect(micSink);

    receiver = M.liveReceiver(function (text) { report(text, 'direct'); });
    resetRing();
    startFolding();
    blocksSeen = 0;

    if (ac.audioWorklet && window.AudioWorkletNode) {
      var code = 'class P extends AudioWorkletProcessor{process(i){if(i[0]&&i[0][0])this.port.postMessage(i[0][0].slice());return true}}registerProcessor("qnr-tap",P)';
      var url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await ac.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      micNode = new AudioWorkletNode(ac, 'qnr-tap');
      micNode.port.onmessage = function (e) { onBlock(e.data); };
      source.connect(micNode);
      micNode.connect(micSink);
      write('mic on (AudioWorklet, ' + ac.sampleRate + ' Hz) - listening continuously', 'c-green');
    } else {
      micNode = ac.createScriptProcessor(4096, 1, 1);
      micNode.onaudioprocess = function (e) { onBlock(new Float32Array(e.inputBuffer.getChannelData(0))); };
      source.connect(micNode);
      micNode.connect(micSink);
      write('mic on (ScriptProcessor fallback, ' + ac.sampleRate + ' Hz)', 'c-amber');
    }

    // If the tap never fires, the meter would sit at -inf forever with no explanation.
    clearTimeout(micWatchdog);
    micWatchdog = setTimeout(function () {
      if (micStream && blocksSeen === 0) {
        write('warning: audio is open but no samples are arriving.', 'c-red');
        write('  check the OS mixer: the input may be muted, or a different device is selected.', 'c-amber');
      }
    }, 2000);
  }

  /**
   * Drives the IN meter and spectrum straight from the analyser on an animation frame, so the
   * display reflects real input even if the decoder tap is starved.
   */
  function startMeter() {
    if (meterRaf) return;
    var time = new Float32Array(analyser.fftSize);
    var freq = new Float32Array(analyser.frequencyBinCount);
    var step = function () {
      if (!analyser) { meterRaf = null; return; }
      meterRaf = requestAnimationFrame(step);
      if (analyser.getFloatTimeDomainData) {
        analyser.getFloatTimeDomainData(time);
        showLevel(inBar, inDb, dbOf(time));
      }
      analyser.getFloatFrequencyData(freq);
      drawSpectrum(freq);
    };
    step();
  }

  function onBlock(block) {
    blocksSeen++;
    if (receiver) receiver.push(block);
    ringPush(block);
  }

  function micOff() {
    if (!micStream) { write('mic is not on', 'c-amber'); return; }
    clearTimeout(micWatchdog);
    // The analyser is owned by the context and stays connected, so the IN meter keeps
    // showing our own transmissions after capture stops.
    [micNode, micSink].forEach(function (n) { if (n) { try { n.disconnect(); } catch (e) { /* already gone */ } } });
    micStream.getTracks().forEach(function (t) { t.stop(); });
    micStream = null; micNode = null; receiver = null; micSink = null;
    if (foldTimer) { clearInterval(foldTimer); foldTimer = null; }
    setRxState('off (self-monitor only)');
    write('mic off - no longer listening to the outside', 'c-amber');
  }

  /**
   * Browsers refuse microphone access without a user gesture, so "always listening" means
   * "from the first interaction onwards". Failure here is not fatal: the page still simulates,
   * decodes files and transmits.
   */
  function autoStart() {
    if (autoStarted) return;
    autoStarted = true;
    micOn().then(function () { setRxState('listening'); }, function (e) {
      write('continuous receive not started: ' + e.message, 'c-amber');
      write('run "mic on" to retry once you have granted microphone access.', 'c-dim');
      setRxState('off');
    });
  }

  /* ---------------------------------------------------------------- commands */

  function def(name, help, fn) { COMMANDS[name] = { help: help, run: fn }; }

  def('help', 'this list', function () {
    write('');
    Object.keys(COMMANDS).forEach(function (k) { write('  ' + k.padEnd(22) + COMMANDS[k].help); });
    write('');
    write('  The DSP here is the same TypeScript that runs the command-line station:', 'c-dim');
    write('  144-tone MFSK, K=7 rate-1/3 convolutional coding, soft-decision Viterbi,', 'c-dim');
    write('  CRC-16, and folded repeat correlation. Nothing is loaded from a network.', 'c-dim');
    write('');
  });

  def('info', 'protocol parameters', function () {
    write('');
    M.info.summary.split('\n').forEach(function (l) { write('  ' + l, 'c-cyan'); });
    write('');
    write('  burst ' + M.info.burstSeconds.toFixed(2) + ' s   slot ' + M.info.slotSeconds.toFixed(2) +
      ' s   period ' + M.info.periodSeconds.toFixed(2) + ' s');
    write('  payload up to ' + M.info.payloadBytes + ' printable ASCII characters');
    write('');
  });

  def('clear', 'clear the screen', function () { outEl.textContent = ''; });

  def('qr', 'qr [audio] - show a scannable QR code for this page\'s URL, or hear it as a modem burst', async function (arg) {
    if (arg && arg.trim() === 'audio') {
      setBusy(true, 'qr');
      await setSink();
      write('QR AUDIO "' + M.pageUrl + '"', 'c-amber');
      try {
        await play(M.qrAudio());
      } finally {
        setBusy(false);
      }
      return;
    }
    write('');
    M.qrLines().forEach(function (l) { write(l, 'c-cyan'); });
    write('  ' + M.pageUrl, 'c-dim');
    write('  run "qr audio" to hear it as a modem burst', 'c-dim');
    write('');
  });

  def('devices', 'list audio inputs and outputs', async function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) throw new Error('no device API in this browser');
    var list = await navigator.mediaDevices.enumerateDevices();
    var named = list.some(function (d) { return d.label; });
    if (!named) write('labels are hidden until microphone permission is granted - run: mic on', 'c-amber');
    write('');
    list.filter(function (d) { return d.kind === 'audioinput' || d.kind === 'audiooutput'; })
      .forEach(function (d) {
        write('  ' + d.kind.replace('audio', '').padEnd(7) + (d.label || '(unnamed)') + '   id=' + d.deviceId.slice(0, 12));
      });
    write('');
    if (audio && typeof audio.setSinkId !== 'function') {
      write('  note: this browser cannot pick an output device from script (Firefox/Safari).', 'c-amber');
      write('  choose the output in the OS mixer instead; input selection still works.', 'c-amber');
    }
  });

  def('out', 'out <deviceId> - choose output device (Chromium only)', async function (arg) {
    if (!arg) throw new Error('usage: out <deviceId prefix from "devices">');
    var list = await navigator.mediaDevices.enumerateDevices();
    var hit = list.filter(function (d) { return d.kind === 'audiooutput' && d.deviceId.indexOf(arg) === 0; })[0];
    if (!hit) throw new Error('no output device id starting with ' + arg);
    sinkId = hit.deviceId;
    context();
    var ok = await setSink();
    write(ok ? 'output -> ' + (hit.label || hit.deviceId) : 'this browser cannot switch output from script', ok ? 'c-green' : 'c-amber');
  });

  def('mic', 'mic on | mic off - live receive from the microphone or WebSDR feed', function (arg) {
    if (arg === 'off') return micOff();
    return micOn().then(function () { setRxState('listening'); });
  });

  def('monitor', 'monitor on | off - decode our own transmissions (default on)', function (arg) {
    if (arg === 'on') monitor = true;
    else if (arg === 'off') monitor = false;
    write('self-monitor ' + (monitor ? 'ON - every burst we send is also decoded' : 'OFF'), 'c-cyan');
  });

  def('deep', 'deep <periods> - how much past audio the folded search uses', function (arg) {
    if (arg) {
      foldDepth = Math.max(1, Math.min(8, parseInt(arg, 10) || 1));
      resetRing();
    }
    write('folded search uses ' + foldDepth + ' periods (' +
      (M.info.periodSeconds * (foldDepth + 1)).toFixed(0) + ' s of audio, retried every ' +
      M.info.periodSeconds.toFixed(0) + ' s)', 'c-cyan');
  });

  def('fold', 'run the folded weak-signal search right now', function () {
    if (!ring || ringFilled === 0) throw new Error('no captured audio yet - run "mic on", or "inject" to test without a mic');
    foldNow();
    write('folded search queued over ' + (ringFilled / RATE).toFixed(0) + ' s of captured audio', 'c-dim');
  });

  def('inject', 'inject [snrDb] - push a burst into the receive chain, no microphone needed', function (arg) {
    var snr = arg ? parseFloat(arg) : NaN;
    var msg = 'INJECTED TEST';
    var signal = M.schedule(msg, 2);
    if (isFinite(snr)) signal = M.simulate(signal, M.burst(msg), { snrDb: snr, profile: null, seed: 1 });
    write('injecting "' + msg + '"' + (isFinite(snr) ? ' at ' + snr + ' dB SNR' : ' clean') +
      ' into the receive chain (' + (signal.length / RATE).toFixed(0) + ' s)', 'c-dim');

    // Exercises exactly the path live audio takes -- meter, direct decoder and fold ring --
    // so the receive chain can be verified where no capture device exists at all.
    if (!ring) resetRing();
    if (!receiver) receiver = M.liveReceiver(function (text) { report(text, 'direct'); });
    var step = 4096;
    for (var i = 0; i < signal.length; i += step) {
      var block = signal.subarray(i, Math.min(i + step, signal.length));
      showLevel(inBar, inDb, dbOf(block));
      onBlock(block);
    }
    write('injected ' + blocksSeen + ' blocks; IN peaked at ' + dbOf(signal).toFixed(1) + ' dB', 'c-dim');
    write('now run "fold" to search the ring for it.', 'c-cyan');
  });

  var fec = 2;
  def('fec', 'fec <n> - repeats per message (1..' + M.info.repeats + ')', function (arg) {
    if (arg) {
      var n = Math.max(1, Math.min(M.info.repeats, parseInt(arg, 10) || 1));
      fec = n;
    }
    // tx alternates <tx> and <rx> turns of one burst each, so air time is 2n-1 bursts.
    write('FEC strength x' + fec + '  (' + ((2 * fec - 1) * M.info.burstSeconds).toFixed(0) +
      ' s of tx/rx turns)', 'c-cyan');
  });

  var offGrid = false;
  def('offgrid', 'offgrid on | off - transmit immediately instead of on the world clock', function (arg) {
    if (arg === 'on') offGrid = true;
    else if (arg === 'off') offGrid = false;
    if (offGrid) {
      write('off-grid ON - transmit starts the moment you press Enter', 'c-amber');
      write('  no shared-grid alignment, so a far station gets no repeat-fold gain;', 'c-dim');
      write('  intended for good-SNR local exchanges. Receive is unaffected.', 'c-dim');
    } else {
      write('off-grid OFF - transmit waits for the next world-clock tx slot', 'c-cyan');
      write('  next slot in ' + (M.grid.msUntilTx() / 1000).toFixed(1) + ' s', 'c-dim');
    }
  });

  def('grid', 'show the hard-coded world-clock frame grid', function () {
    write('');
    write('  world grid is anchored to the Unix epoch (UTC) and never negotiated:', 'c-cyan');
    write('  two stations line up by both having a correct clock, nothing is sent to sync.', 'c-dim');
    write('');
    write('  period      ' + M.grid.periodSeconds.toFixed(2) + ' s   =  <tx> ' +
      M.grid.slotSeconds.toFixed(2) + ' s  +  <rx> ' + M.grid.slotSeconds.toFixed(2) + ' s');
    write('  UTC now     ' + new Date().toISOString());
    write('  phase       ' + M.grid.phaseSeconds().toFixed(2) + ' s into the period');
    write('  this turn   <' + M.grid.lane() + '>');
    write('  next tx in  ' + (M.grid.msUntilTx() / 1000).toFixed(2) + ' s');
    write('  mode        ' + (offGrid ? 'OFF-GRID (immediate)' : 'ON-GRID (world clock)'), offGrid ? 'c-amber' : 'c-green');
    write('');
  });

  def('tx', 'tx <message> - transmit (on the world clock unless "offgrid on")', async function (arg) {
    if (!arg) throw new Error('usage: tx CQ CQ DE QNR');
    var text = M.clean(arg);
    if (!text) throw new Error('need at least one printable ASCII character');
    setBusy(true, 'tx');
    await setSink();
    var one = M.burst(text);
    write('TX "' + text + '"  x' + fec + '  (' + M.info.burstSeconds.toFixed(1) + ' s per burst)  ' +
      (offGrid ? '[off-grid]' : '[world clock]'), 'c-amber');

    // On-grid: line up with the world-clock tx slot so a distant receiver can fold our repeats
    // against the same absolute grid. Decoding continues throughout either way.
    if (!offGrid) {
      var waitMs = M.grid.msUntilTx();
      write('  waiting ' + (waitMs / 1000).toFixed(1) + ' s for the world-clock tx slot', 'c-dim');
      var tick = ticker('  <rx> until our slot');
      await new Promise(function (r) { setTimeout(r, waitMs); });
      tick.stop();
    }

    for (var i = 1; i <= fec; i++) {
      write('  burst ' + i + '/' + fec + '  <tx>', 'c-dim');
      // Always listen to ourselves: the burst goes through a decoder directly, so a
      // transmission is confirmed even with no acoustic path back and no mic permission.
      if (monitor) selfMonitor(one);
      await play(one);
      if (i < fec) {
        // On-grid repeats must land on the next period's tx phase, so the receiver folds them
        // on top of each other. Off-grid just takes one rx-length turn and goes again.
        var gapMs = offGrid ? M.info.burstSeconds * 1000 : M.grid.msUntilTx();
        write('  turn ' + i + '/' + fec + '  <rx>  (' + (gapMs / 1000).toFixed(1) + ' s)', 'c-dim');
        await new Promise(function (r) { setTimeout(r, gapMs); });
      }
    }
    write('TX done', 'c-green');
    setBusy(false);
  });

  def('tone', 'play a 1 kHz test tone to check audio routing', async function () {    var ac = context();
    var n = Math.round(ac.sampleRate * 0.5), s = new Float32Array(n);
    for (var i = 0; i < n; i++) s[i] = 0.4 * Math.sin((2 * Math.PI * 1000 * i) / ac.sampleRate);
    await setSink();
    await play(s);
    write('test tone done', 'c-green');
  });

  def('selftest', 'encode then decode in memory, no audio', function () {
    var msg = 'CQ CQ DE QNR';
    setBusy(true, 'selftest');
    var tick = ticker('  folding 2 bursts');
    return job({ cmd: 'selftest', message: msg, repeats: 2 }).then(function (r) {
      tick.stop();
      var hit = r.hits.filter(function (h) { return h.text === msg; })[0];
      write((hit ? 'PASS' : 'FAIL') + '  round trip "' + msg + '"  ' +
        (hit ? '(' + hit.bursts + 'x LLR) ' : '') + r.ms + ' ms', hit ? 'c-green' : 'c-red');
      setBusy(false);
    }, function (e) { tick.stop(); setBusy(false); throw e; });
  });

  def('sim', 'sim <snrDb> [profile] - decode through a simulated HF channel', function (arg) {
    var parts = arg.split(/\s+/).filter(Boolean);
    var snr = parseFloat(parts[0]);
    if (!isFinite(snr)) throw new Error('usage: sim -18 poor   (profiles: ' + M.info.profiles.join(', ') + ')');
    var profile = parts[1] || null;
    if (profile && M.info.profiles.indexOf(profile) < 0) throw new Error('unknown profile ' + profile);
    var msg = 'CQ CQ DE QNR';
    write('simulating ' + snr + ' dB SNR' + (profile ? ', CCIR ' + profile + ' fading' : ', AWGN only') + ', 4 bursts', 'c-dim');
    setBusy(true, 'sim');
    var tick = ticker('  searching tuning and clock drift');
    return job({ cmd: 'sim', message: msg, repeats: 4, snrDb: snr, profile: profile, seed: 1 }).then(function (r) {
      tick.stop();
      var hit = r.hits.filter(function (h) { return h.text === msg; })[0];
      if (hit) write('PASS  "' + hit.text + '"  ' + hit.bursts + 'x LLR, ' +
        hit.offsetHz.toFixed(1) + ' Hz, ' + hit.driftPpm.toFixed(0) + ' ppm   ' + r.ms + ' ms', 'c-green');
      else write('no decode at ' + snr + ' dB (' + r.ms + ' ms) - try a higher SNR', 'c-red');
      setBusy(false);
    }, function (e) { tick.stop(); setBusy(false); throw e; });
  });

  def('about', 'what this page is', function () {
    write('');
    write('  QNR-144 is a weak-signal chat modem for HF radio.', 'c-cyan');
    write('  Point this page\'s audio at a transceiver (or just play it across a room)');
    write('  and another station running the same page, or the qnr command-line');
    write('  program, can decode it.');
    write('');
    write('  Everything runs locally: no server, no upload, no network requests.', 'c-dim');
    write('');
  });

  /* -------------------------------------------------------------------- boot */

  write('QNR-144  144-tone MFSK weak-signal chat modem', 'c-green');
  write(M.info.tones + ' tones, ' + M.info.lowHz.toFixed(0) + '-' + M.info.highHz.toFixed(0) + ' Hz, ' +
    M.info.baud + ' Bd, K=7 rate-1/3 + Viterbi, CRC-16', 'c-dim');
  write('');
  write('The station listens continuously once you interact with the page:', 'c-cyan');
  write('  direct   every burst, immediately, at any timing (loud / off-grid)', 'c-dim');
  write('  folded   weak-signal search over the last ' + (M.info.periodSeconds * (foldDepth + 1)).toFixed(0) +
    ' s, retried every ' + M.info.periodSeconds.toFixed(0) + ' s', 'c-dim');
  write('  self     our own transmissions are decoded too, always', 'c-dim');
  write('');
  write('Type "help" for commands, or "selftest" to prove the DSP works right now.');
  write('Point this at a WebSDR feed and leave it running; "tx CQ CQ DE QNR" to send.');
  write('');
  showLevel(inBar, inDb, -60);
  showLevel(outBar, outDb, -60);
  drawSpectrum(null);
  setRxState('waiting for a click');
  redraw();
  termEl.focus();

  // The world grid runs off the wall clock, so it ticks whether or not we are transmitting.
  var gridEl = document.getElementById('gridstate');
  setInterval(function () {
    if (!gridEl) return;
    var lane = M.grid.lane();
    gridEl.textContent = 'grid: <' + lane + '> ' + (M.grid.msUntilTx() / 1000).toFixed(0) + 's to tx' +
      (offGrid ? ' (off)' : '');
    gridEl.style.color = offGrid ? 'var(--amber)' : (lane === 'tx' ? 'var(--green)' : 'var(--dim)');
  }, 250);

  // Browsers only allow audio capture after a gesture, so continuous receive begins at the
  // first click or keypress rather than on load.
  ['click', 'keydown'].forEach(function (type) {
    document.addEventListener(type, autoStart, { once: true });
  });
})();
