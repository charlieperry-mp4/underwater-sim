(function () {
  'use strict';
  var S = window.Sim;
  var state = Object.assign({}, S.DEFAULTS);

  var canvas = document.getElementById('view');
  canvas.width = S.W; canvas.height = S.H;
  var ctx = canvas.getContext('2d');
  var histCanvas = document.getElementById('hist');

  var fmt = {
    depth: function (v) { return v + ' m'; },
    turb: function (v) { return Math.round(v * 100) + '%'; },
    dist: function (v) { return v.toFixed(2) + ' m'; },
    focus: function (v) { return v.toFixed(2) + ' m'; },
    off: function (v) { return v.toFixed(2) + ' m'; },
    ap: function (i) { return 'f/' + S.APERTURES[i]; },
    sh: function (i) { return '1/' + S.SHUTTERS[i] + ' s'; },
    iso: function (i) { return 'ISO ' + S.ISOS[i]; },
    pow: function (i) { return S.STROBE_STOPS[i] + ' power'; }
  };
  var numericSelects = { lens: true };

  var inputs = Array.prototype.slice.call(document.querySelectorAll('[data-key]'));

  function outputFor(el) {
    var key = el.getAttribute('data-key');
    return document.querySelector('[data-out="' + key + '"]');
  }

  function syncUI() {
    inputs.forEach(function (el) {
      var key = el.getAttribute('data-key');
      if (el.type === 'checkbox') el.checked = !!state[key];
      else el.value = state[key];
      var out = outputFor(el);
      if (out && fmt[key]) out.textContent = fmt[key](state[key]);
    });
    var focusEl = document.querySelector('[data-key="focus"]');
    focusEl.disabled = state.af;
    document.querySelector('[data-key="pow"]').disabled = !state.strobe;
    document.querySelector('[data-key="off"]').disabled = !state.strobe;
  }

  inputs.forEach(function (el) {
    var key = el.getAttribute('data-key');
    var evt = (el.type === 'range') ? 'input' : 'change';
    el.addEventListener(evt, function () {
      if (el.type === 'checkbox') state[key] = el.checked;
      else if (el.type === 'range' || numericSelects[key]) state[key] = parseFloat(el.value);
      else state[key] = el.value;
      if (key === 'af' && !state.af) state.focus = state.dist;
      var out = outputFor(el);
      if (out && fmt[key]) out.textContent = fmt[key](state[key]);
      if (key === 'af' || key === 'strobe') syncUI();
      requestRender();
    });
  });

  /* presets */
  var presetBox = document.getElementById('presets');
  S.PRESETS.forEach(function (p) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.name;
    b.addEventListener('click', function () {
      state = Object.assign({}, S.DEFAULTS, p.s);
      state.focus = state.dist;
      syncUI();
      requestRender();
    });
    presetBox.appendChild(b);
  });

  document.getElementById('reset').addEventListener('click', function () {
    state = Object.assign({}, S.DEFAULTS);
    syncUI(); requestRender();
  });

  /* hold to compare with air */
  var holdBtn = document.getElementById('holdAir');
  var badge = document.getElementById('badge');
  function setRef(on) { state.ref = on; badge.hidden = !on; requestRender(); }
  holdBtn.addEventListener('pointerdown', function (e) { e.preventDefault(); setRef(true); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (n) {
    holdBtn.addEventListener(n, function () { if (state.ref) setRef(false); });
  });
  holdBtn.addEventListener('keydown', function (e) { if ((e.key === ' ' || e.key === 'Enter') && !state.ref) { e.preventDefault(); setRef(true); } });
  holdBtn.addEventListener('keyup', function (e) { if (e.key === ' ' || e.key === 'Enter') setRef(false); });

  document.getElementById('save').addEventListener('click', function () {
    canvas.toBlob(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'underwater-simulation.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
  });

  /* rendering */
  var pending = false;
  function requestRender() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; draw(); });
  }

  function drawHist(h) {
    var c = histCanvas.getContext('2d');
    var w = histCanvas.width, ht = histCanvas.height;
    c.clearRect(0, 0, w, ht);
    c.fillStyle = 'rgba(255,255,255,0.04)';
    c.fillRect(0, 0, w, ht);
    var mx = 1, i, ch;
    for (i = 1; i < 63; i++) for (ch = 0; ch < 3; ch++) mx = Math.max(mx, h[ch * 64 + i]);
    var cols = ['rgb(255,70,70)', 'rgb(60,230,100)', 'rgb(70,120,255)'];
    c.globalCompositeOperation = 'lighter';
    for (ch = 0; ch < 3; ch++) {
      c.fillStyle = cols[ch];
      for (i = 0; i < 64; i++) {
        var v = Math.sqrt(Math.min(h[ch * 64 + i], mx) / mx);
        var bh = v * (ht - 4);
        c.globalAlpha = 0.75;
        c.fillRect(i * (w / 64), ht - bh, w / 64 - 0.5, bh);
      }
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  function draw() {
    var m = S.render(state, ctx);
    var cfg = m.cfg;

    document.getElementById('hud').textContent =
      cfg.f + 'mm  f/' + cfg.N + '  1/' + cfg.den + '  ISO ' + cfg.iso + '  ' +
      (cfg.strobeOn ? 'strobe ' + S.STROBE_STOPS[state.pow] : (state.ref ? '' : 'no strobe'));

    var ev = Math.log(m.lum / 0.18 + 1e-9) / Math.LN2;
    var expEl = document.getElementById('mExp');
    expEl.textContent = state.ref ? '-' : (ev >= 0 ? '+' : '') + ev.toFixed(1) + ' EV';
    expEl.className = (!state.ref && (ev < -1.3 || ev > 1)) ? 'bad' : '';
    var clipEl = document.getElementById('mClip');
    clipEl.textContent = state.ref ? '-' : (m.clip * 100).toFixed(1) + '%';
    clipEl.className = (!state.ref && m.clip > 0.08) ? 'bad' : '';
    document.getElementById('mVis').textContent = state.ref ? '-' : (3.5 / cfg.c[1] > 40 ? '40+' : (3.5 / cfg.c[1]).toFixed(1)) + ' m';
    var red = Math.exp(-cfg.kd[0] * state.depth) * 100;
    document.getElementById('mRed').textContent = state.light === 'night' ? '0%' : (red < 1 ? '<1%' : Math.round(red) + '%');

    drawHist(m.hist);

    var list = document.getElementById('notes');
    list.innerHTML = '';
    S.describe(state, cfg, m).forEach(function (n) {
      var li = document.createElement('li');
      li.className = n.tone;
      li.textContent = n.text;
      list.appendChild(li);
    });
  }

  syncUI();
  requestRender();
})();
