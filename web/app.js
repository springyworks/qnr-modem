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

  function job(request) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = ensureWorker(); } catch (e) { reject(new Error('Web Workers unavailable: ' + e.message)); return; }
      var id = ++jobId;
      jobs[id] = function (msg) { msg.ok ? resolve(msg) : reject(new Error(msg.error)); };
      request.id = id;
      w.postMessage(request);
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

  function context() {
    if (!audio) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('this browser has no Web Audio support');
      audio = new Ctor({ sampleRate: RATE });
      rateEl.textContent = 'audio: ' + audio.sampleRate + ' Hz';
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
    analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    receiver = M.liveReceiver(function (text) {
      write('  >> "' + text + '"   [CRC OK]  ' + new Date().toLocaleTimeString(), 'c-rx');
    });

    var size = 4096;
    if (ac.audioWorklet && window.AudioWorkletNode) {
      var code = 'class P extends AudioWorkletProcessor{process(i){if(i[0]&&i[0][0])this.port.postMessage(i[0][0].slice());return true}}registerProcessor("qnr-tap",P)';
      var url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await ac.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      micNode = new AudioWorkletNode(ac, 'qnr-tap');
      micNode.port.onmessage = function (e) { onBlock(e.data); };
      source.connect(micNode);
      write('mic on (AudioWorklet, ' + ac.sampleRate + ' Hz) - listening for bursts', 'c-green');
    } else {
      micNode = ac.createScriptProcessor(size, 1, 1);
      micNode.onaudioprocess = function (e) { onBlock(new Float32Array(e.inputBuffer.getChannelData(0))); };
      source.connect(micNode);
      micNode.connect(ac.destination);
      write('mic on (ScriptProcessor fallback, ' + ac.sampleRate + ' Hz)', 'c-amber');
    }
  }

  var freqScratch = null;
  function onBlock(block) {
    showLevel(inBar, inDb, dbOf(block));
    if (receiver) receiver.push(block);
    if (analyser) {
      if (!freqScratch) freqScratch = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(freqScratch);
      drawSpectrum(freqScratch);
    }
  }

  function micOff() {
    if (!micStream) { write('mic is not on', 'c-amber'); return; }
    if (micNode) { try { micNode.disconnect(); } catch (e) { /* already gone */ } }
    micStream.getTracks().forEach(function (t) { t.stop(); });
    micStream = null; micNode = null; receiver = null; analyser = null;
    showLevel(inBar, inDb, -60);
    drawSpectrum(null);
    write('mic off', 'c-amber');
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

  def('mic', 'mic on | mic off - live receive from the microphone', function (arg) {
    if (arg === 'off') return micOff();
    return micOn();
  });

  var fec = 2;
  def('fec', 'fec <n> - repeats per message (1..' + M.info.repeats + ')', function (arg) {
    if (arg) {
      var n = Math.max(1, Math.min(M.info.repeats, parseInt(arg, 10) || 1));
      fec = n;
    }
    write('FEC strength x' + fec + '  (' + (fec * M.info.periodSeconds).toFixed(0) + ' s on air)', 'c-cyan');
  });

  def('tx', 'tx <message> - transmit through the speakers', async function (arg) {
    if (!arg) throw new Error('usage: tx CQ CQ DE QNR');
    var text = M.clean(arg);
    if (!text) throw new Error('need at least one printable ASCII character');
    setBusy(true, 'tx');
    await setSink();
    var one = M.burst(text);
    write('TX "' + text + '"  x' + fec + '  (' + M.info.burstSeconds.toFixed(1) + ' s per burst)', 'c-amber');
    for (var i = 1; i <= fec; i++) {
      write('  burst ' + i + '/' + fec + '  <tx>', 'c-dim');
      await play(one);
      if (i < fec) {
        // One rx-sized turn between repeats, mirroring the burst itself -- <tx> then <rx>,
        // not <tx> then a whole extra shared-grid reply slot (that's what made the old
        // period-length gap sound like two listening turns instead of one).
        write('  turn ' + i + '/' + fec + '  <rx>  (~' + M.info.burstSeconds.toFixed(0) + ' s)', 'c-dim');
        await new Promise(function (r) { setTimeout(r, M.info.burstSeconds * 1000); });
      }
    }
    write('TX done', 'c-green');
    setBusy(false);
  });

  def('tone', 'play a 1 kHz test tone to check audio routing', async function () {
    var ac = context();
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
  write('Type "help" for commands, or "selftest" to prove the DSP works right now.', 'c-cyan');
  write('For live receive use "mic on"; to transmit, "tx CQ CQ DE QNR".');
  write('');
  showLevel(inBar, inDb, -60);
  showLevel(outBar, outDb, -60);
  drawSpectrum(null);
  redraw();
  termEl.focus();
})();
