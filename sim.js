/* Underwater camera simulator - rendering engine.
 *
 * A reef scene is painted as depth layers (albedo = colour under neutral light).
 * Each layer is then "photographed" through a simplified physical model:
 *   - per-channel light absorption with depth and distance (red vanishes first)
 *   - scattering: backscatter veil, loss of contrast, forward-scatter softness
 *   - strobe light: inverse-square falloff, absorbed on the way out and back
 *   - exposure triangle (aperture, shutter, ISO) with strobe vs ambient handled separately
 *   - depth of field, diffraction, camera shake, subject motion blur
 *   - ISO noise, white balance (including red filter), strobe backscatter particles
 */
(function (root) {
  'use strict';

  var W = 640, H = 400, N = W * H;
  var SENSOR_MM = 36, PXMM = W / SENSOR_MM;
  var FLOOR_Y = -0.35;   // seabed is 0.35 m below the camera axis
  var HERO_Y = -0.12;    // hero subject sits slightly below the axis

  var APERTURES = [1.8, 2.8, 4, 5.6, 8, 11, 16, 22, 32];
  var SHUTTERS = [4, 8, 15, 30, 60, 125, 250, 500, 1000];
  var ISOS = [100, 200, 400, 800, 1600, 3200, 6400];
  var STROBE_STOPS = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32'];

  var WATERS = {
    clear: { name: 'Clear tropical blue', k: [0.42, 0.065, 0.028], b: 0.03, tint: [0.03, 0.38, 0.92] },
    green: { name: 'Green temperate', k: [0.62, 0.17, 0.20], b: 0.16, tint: [0.10, 0.62, 0.46] },
    murky: { name: 'Murky / estuary', k: [0.78, 0.45, 0.85], b: 0.50, tint: [0.36, 0.40, 0.20] }
  };
  var LIGHTS = { sun: 1, over: 0.35, dusk: 0.04, night: 0 };

  var DEFAULTS = {
    depth: 10, water: 'clear', turb: 0, light: 'sun', dist: 1.0,
    lens: 24, ap: 4, sh: 5, iso: 1, wb: 'daylight', af: true, focus: 1.0,
    strobe: true, pow: 2, off: 0.35, chart: false, ref: false
  };

  var PRESETS = [
    { name: 'Reef, wide-angle', s: { depth: 8, dist: 0.9, lens: 15, off: 0.4 } },
    { name: 'Macro close-up', s: { depth: 6, dist: 0.45, lens: 100, ap: 6, off: 0.25 } },
    { name: 'Deep, no strobe', s: { depth: 30, dist: 1.5, ap: 3, sh: 4, iso: 2, strobe: false, chart: true } },
    { name: 'Deep + strobe', s: { depth: 30, dist: 1.5, ap: 5, sh: 5, iso: 1, strobe: true, pow: 1, off: 0.4, chart: true } },
    { name: 'Deep, custom white balance', s: { depth: 8, dist: 1.5, ap: 4, sh: 5, iso: 2, strobe: false, wb: 'auto', chart: true } },
    { name: 'Murky: strobes close', s: { water: 'murky', turb: 0.2, depth: 5, dist: 0.8, pow: 1, off: 0.12 } },
    { name: 'Murky: strobes wide', s: { water: 'murky', turb: 0.2, depth: 5, dist: 0.8, pow: 1, off: 0.65 } },
    { name: 'Night dive', s: { light: 'night', depth: 6, dist: 1.0, sh: 4, iso: 2, pow: 1, off: 0.4 } },
    { name: 'Slow shutter + strobe', s: { light: 'dusk', depth: 5, dist: 1.0, ap: 4, sh: 1, iso: 1, pow: 1, off: 0.4 } }
  ];

  var makeCanvas = function (w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };

  function rng(seed) {
    var x = (seed | 0) || 123456789;
    return function () {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      return (x >>> 0) / 4294967296;
    };
  }

  var LIN = new Float32Array(256);
  for (var li = 0; li < 256; li++) LIN[li] = Math.pow(li / 255, 2.2);
  var ENC = new Uint8ClampedArray(2048);
  for (var ei = 0; ei < 2048; ei++) ENC[ei] = Math.round(255 * Math.pow(ei / 2047, 1 / 2.2));

  var pool = {
    A: new Float32Array(N * 4), S: new Float32Array(N * 4), T: new Float32Array(N * 4),
    RA: new Float32Array(N * 4), RM: new Float32Array(N * 4), RS: new Float32Array(N * 4),
    lv: [], out: new Float32Array(N * 3), img: null, imgCtx: null,
    vsum: new Float64Array(W * 4)
  };
  var radA = new Float32Array(H), radS = new Float32Array(H);
  var cache = { key: null, layers: null };
  var ctxs = [];

  function getCtx(i) {
    if (!ctxs[i]) ctxs[i] = makeCanvas(W, H).getContext('2d', { willReadFrequently: true });
    var c = ctxs[i];
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, W, H);
    return c;
  }
  function grab(ctx) { return ctx.getImageData(0, 0, W, H).data; }

  /* ---------- drawing helpers (albedo, i.e. colour under neutral light) ---------- */
  function rgba(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + (a === undefined ? 1 : a) + ')'; }
  function sh(c, f) { return [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)]; }

  function dome(ctx, x, y, rx, ry, col, rnd, texture) {
    ctx.save();
    ctx.beginPath();
    var n = 36, i;
    for (i = 0; i <= n; i++) {
      var t = Math.PI * i / n;
      var wob = 1 + 0.06 * Math.sin(i * 1.9 + 1) + 0.04 * Math.sin(i * 4.1);
      var px = x - Math.cos(t) * rx * wob, py = y - Math.sin(t) * ry * wob;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    var g = ctx.createRadialGradient(x - rx * 0.35, y - ry * 0.8, Math.max(1, rx * 0.05), x, y - ry * 0.3, rx * 1.25);
    g.addColorStop(0, rgba(sh(col, 1.3)));
    g.addColorStop(0.6, rgba(col));
    g.addColorStop(1, rgba(sh(col, 0.5)));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();
    var lw = Math.max(0.8, rx * 0.025);
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    var cnt = Math.min(160, Math.max(10, Math.floor(rx / 3)));
    for (i = 0; i < cnt; i++) {
      var qx = x + (rnd() * 2 - 1) * rx, qy = y - rnd() * ry;
      if (texture === 'dots') {
        ctx.fillStyle = rgba(sh(col, 1.35), 0.8);
        ctx.beginPath(); ctx.arc(qx, qy, lw * 0.8, 0, 6.283); ctx.fill();
      } else {
        ctx.strokeStyle = rgba(sh(col, 0.55), 0.55);
        ctx.beginPath();
        ctx.moveTo(qx, qy);
        ctx.quadraticCurveTo(qx + (rnd() - 0.5) * rx * 0.3, qy + (rnd() - 0.5) * rx * 0.3,
          qx + (rnd() - 0.5) * rx * 0.35, qy + (rnd() - 0.5) * rx * 0.2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function branch(ctx, x, y, ang, len, wid, depth, col, rnd) {
    if (depth <= 0 || len < 0.8) return;
    var x2 = x + Math.cos(ang) * len, y2 = y - Math.sin(ang) * len;
    ctx.strokeStyle = rgba(sh(col, 0.7 + 0.08 * (5 - depth)));
    ctx.lineWidth = Math.max(1, wid);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
    if (depth === 1) {
      ctx.fillStyle = rgba(sh(col, 1.3));
      ctx.beginPath(); ctx.arc(x2, y2, Math.max(1, wid * 0.8), 0, 6.283); ctx.fill();
    }
    var k = rnd() < 0.5 ? 2 : 3;
    for (var i = 0; i < k; i++) branch(ctx, x2, y2, ang + (rnd() - 0.5) * 1.2, len * 0.74, wid * 0.72, depth - 1, col, rnd);
  }

  function seaFan(ctx, x, y, w, h, col, rnd) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(sh(col, 0.8));
    ctx.lineWidth = Math.max(1, w * 0.02);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - h * 0.2); ctx.stroke();
    var by = y - h * 0.2, rays = 26, i, a, L;
    var asp = (w / h) * 0.9;
    for (i = 0; i < rays; i++) {
      a = Math.PI * (0.1 + 0.8 * i / (rays - 1));
      L = h * 0.8 * (0.75 + 0.25 * Math.sin(a));
      ctx.lineWidth = Math.max(0.8, w * 0.012);
      ctx.beginPath();
      ctx.moveTo(x, by);
      ctx.quadraticCurveTo(x + Math.cos(a) * L * 0.5 * asp, by - Math.sin(a) * L * 0.6 + (rnd() - 0.5) * h * 0.04,
        x + Math.cos(a) * L * asp, by - Math.sin(a) * L);
      ctx.stroke();
    }
    ctx.lineWidth = Math.max(0.6, w * 0.006);
    ctx.strokeStyle = rgba(col, 0.7);
    for (var r = 0.3; r <= 1.0; r += 0.14) {
      ctx.beginPath();
      for (i = 0; i <= rays; i++) {
        a = Math.PI * (0.1 + 0.8 * i / rays);
        L = h * 0.8 * r * (0.75 + 0.25 * Math.sin(a));
        var px = x + Math.cos(a) * L * asp, py = by - Math.sin(a) * L;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function anemone(ctx, x, y, r, col, tip, rnd) {
    ctx.save();
    ctx.fillStyle = rgba(sh(col, 0.6));
    ctx.beginPath(); ctx.ellipse(x, y, r * 0.45, r * 0.28, 0, 0, 6.283); ctx.fill();
    var n = Math.min(140, Math.max(30, Math.floor(r / 2)));
    ctx.lineCap = 'round';
    for (var i = 0; i < n; i++) {
      var a = Math.PI * (0.05 + 0.9 * rnd());
      var spread = rnd() * 0.9 + 0.1;
      var sx = x + (rnd() - 0.5) * r * 0.5, sy = y - rnd() * r * 0.1;
      var len = r * (0.5 + 0.7 * rnd());
      var ex = sx + Math.cos(a) * len * spread * 1.1, ey = sy - Math.sin(a) * len * 0.9;
      var cx = sx + Math.cos(a) * len * 0.3 + (rnd() - 0.5) * r * 0.3, cy = sy - Math.sin(a) * len * 0.7;
      ctx.strokeStyle = rgba(col, 0.95);
      ctx.lineWidth = Math.max(1, r * 0.06);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(cx, cy, ex, ey); ctx.stroke();
      ctx.fillStyle = rgba(tip);
      ctx.beginPath(); ctx.arc(ex, ey, Math.max(0.8, r * 0.045), 0, 6.283); ctx.fill();
    }
    ctx.restore();
  }

  function fish(ctx, x, y, L, body, band, facing) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(facing || 1, 1);
    var h = L * 0.17;
    ctx.fillStyle = rgba(sh(body, 0.9));
    ctx.beginPath(); ctx.moveTo(-L * 0.38, 0); ctx.lineTo(-L * 0.62, -h); ctx.quadraticCurveTo(-L * 0.55, 0, -L * 0.62, h); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-L * 0.2, -h * 0.8); ctx.quadraticCurveTo(0, -h * 1.9, L * 0.2, -h * 0.8); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-L * 0.05, h * 0.85); ctx.quadraticCurveTo(L * 0.08, h * 1.5, L * 0.14, h * 0.85); ctx.closePath(); ctx.fill();
    var g = ctx.createLinearGradient(0, -h, 0, h);
    g.addColorStop(0, rgba(sh(body, 1.15)));
    g.addColorStop(1, rgba(sh(body, 0.8)));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, L * 0.42, h, 0, 0, 6.283); ctx.fill();
    if (band) {
      ctx.save();
      ctx.beginPath(); ctx.ellipse(0, 0, L * 0.42, h, 0, 0, 6.283); ctx.clip();
      var bands = [[-0.12, 0.10], [0.16, 0.08], [0.34, 0.05]];
      for (var i = 0; i < bands.length; i++) {
        var bx = bands[i][0], bw = bands[i][1];
        ctx.fillStyle = 'rgb(20,15,15)';
        ctx.fillRect(L * bx - L * bw * 0.7, -h * 1.1, L * bw * 1.4, h * 2.2);
        ctx.fillStyle = rgba(band);
        ctx.fillRect(L * bx - L * bw * 0.5, -h * 1.1, L * bw, h * 2.2);
      }
      ctx.restore();
    }
    ctx.fillStyle = 'rgb(15,15,15)';
    ctx.beginPath(); ctx.arc(L * 0.28, -h * 0.25, Math.max(0.7, L * 0.025), 0, 6.283); ctx.fill();
    ctx.restore();
  }

  function tube(ctx, x, y, w, h, col) {
    ctx.save();
    var g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    g.addColorStop(0, rgba(sh(col, 0.6)));
    g.addColorStop(0.4, rgba(sh(col, 1.25)));
    g.addColorStop(1, rgba(sh(col, 0.55)));
    ctx.fillStyle = g;
    ctx.fillRect(x - w / 2, y - h, w, h);
    ctx.fillStyle = rgba(sh(col, 0.35));
    ctx.beginPath(); ctx.ellipse(x, y - h, w / 2, w * 0.2, 0, 0, 6.283); ctx.fill();
    ctx.restore();
  }

  function blade(ctx, x, y, h, w, col, rnd) {
    var sway = (rnd() - 0.5) * h * 0.3;
    ctx.fillStyle = rgba(col, 0.95);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x - w + sway * 0.5, y - h * 0.5, x + sway, y - h);
    ctx.quadraticCurveTo(x + w + sway * 0.5, y - h * 0.5, x, y);
    ctx.fill();
  }

  function colourChart(ctx, x, y, s, floorY) {
    ctx.fillStyle = 'rgb(55,55,60)';
    ctx.fillRect(x - 0.08 * s, y + 1.1 * s, 0.16 * s, Math.max(0, floorY - (y + 1.1 * s)));
    ctx.fillRect(x - 1.6 * s, y - 1.1 * s, 3.2 * s, 2.2 * s);
    var P = [[205, 30, 30], [240, 130, 20], [245, 220, 40], [40, 160, 60], [40, 80, 205], [200, 200, 200]];
    var g = 0.06 * s;
    for (var i = 0; i < 6; i++) {
      var cx = i % 3, cy = (i / 3) | 0;
      ctx.fillStyle = 'rgb(' + P[i][0] + ',' + P[i][1] + ',' + P[i][2] + ')';
      ctx.fillRect(x - 1.5 * s + cx * s + g, y - s + cy * s + g, s - 2 * g, s - 2 * g);
    }
  }

  /* ---------- scene construction ---------- */
  function buildLayers(st) {
    var f = st.lens, Zs = st.dist;
    var S = function (Z) { return f * PXMM / Z; };
    var ppy = H * 0.5 + HERO_Y * S(Zs);
    var X = function (x, Z) { return W / 2 + x * S(Z); };
    var Y = function (y, Z) { return ppy - y * S(Z); };
    var floorRow = function (Z) { return ppy - FLOOR_Y * S(Z); };
    var layers = [];
    var ctx, rnd, Z, s, i, k;

    // seabed (depth varies by row)
    ctx = getCtx(0); rnd = rng(11);
    var y0 = Math.max(0, Math.floor(ppy) + 1);
    ctx.fillStyle = 'rgb(206,186,142)';
    ctx.fillRect(0, y0, W, H - y0);
    ctx.lineCap = 'round';
    for (Z = 0.2; Z < 60; Z *= 1.04 + rnd() * 0.06) {
      var yr = floorRow(Z);
      if (yr > H + 6 || yr < y0) continue;
      s = S(Z);
      var amp = Math.max(0.3, 0.012 * s * (0.5 + rnd())), wl = Math.max(6, 0.25 * s * (0.6 + rnd() * 0.8));
      ctx.strokeStyle = 'rgba(150,128,92,0.26)';
      ctx.lineWidth = Math.max(0.6, 0.014 * s);
      ctx.beginPath();
      for (var x = -10; x <= W + 10; x += 4) {
        var yy = yr + Math.sin(x / wl * 6.283 + Z * 7) * amp;
        if (x === -10) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(236,220,178,0.22)';
      ctx.lineWidth = Math.max(0.5, 0.008 * s);
      ctx.beginPath();
      for (x = -10; x <= W + 10; x += 4) {
        yy = yr - 0.02 * s + Math.sin(x / wl * 6.283 + Z * 7) * amp;
        if (x === -10) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    for (i = 0; i < 1500; i++) {
      var gy = y0 + rnd() * (H - y0), gx = rnd() * W;
      var Zr = Math.max(0.15, f * PXMM * (-FLOOR_Y) / Math.max(1, gy - ppy));
      var sz = Math.max(0.5, 0.006 * S(Zr));
      ctx.fillStyle = rnd() < 0.5 ? 'rgba(120,100,70,0.3)' : 'rgba(240,228,190,0.3)';
      ctx.fillRect(gx, gy, sz * 1.6, sz);
    }
    for (i = 0; i < 16; i++) {
      var Zp = 0.5 + rnd() * rnd() * 9 + (i < 4 ? Zs * 0.3 : 0);
      var xw = (rnd() - 0.5) * 2.6 * Math.max(1, Zp * 0.5);
      var ps = S(Zp) * (0.025 + rnd() * 0.05);
      ctx.fillStyle = rgba([120 + rnd() * 60, 105 + rnd() * 40, 85 + rnd() * 30]);
      ctx.beginPath(); ctx.ellipse(X(xw, Zp), floorRow(Zp) - ps * 0.3, ps, ps * 0.55, 0, 0, 6.283); ctx.fill();
    }
    var zrow = new Float32Array(H);
    for (i = 0; i < H; i++) {
      zrow[i] = i > ppy ? Math.min(80, Math.max(0.12, f * PXMM * (-FLOOR_Y) / (i - ppy + 0.5))) : 80;
    }
    layers.push({ data: grab(ctx), zrow: zrow, moving: false });

    // distant reef
    ctx = getCtx(1); rnd = rng(22); Z = Zs + 5.5; s = S(Z);
    var by = floorRow(Z);
    var pal = [[96, 78, 112], [124, 96, 80], [72, 104, 100], [110, 70, 90]];
    var items = [[-2.6, 1.4, 1.0], [-1.3, 0.9, 0.7], [0.2, 1.8, 1.3], [1.6, 1.0, 0.8], [2.9, 1.5, 1.1], [-0.6, 0.6, 0.5], [0.9, 0.7, 0.6]];
    for (i = 0; i < items.length; i++) {
      var it = items[i], cx = X(it[0], Z);
      dome(ctx, cx, by, it[1] * 0.5 * s, it[2] * s, pal[i % pal.length], rnd, 'dots');
      for (k = 0; k < 14; k++) {
        var a = rnd() * Math.PI, rr = rnd();
        ctx.fillStyle = rgba(rnd() < 0.5 ? [220, 110, 60] : [220, 160, 60], 0.9);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * it[1] * 0.45 * s * rr, by - Math.abs(Math.sin(a)) * it[2] * s * rr * 0.9, Math.max(1, 0.03 * s), 0, 6.283);
        ctx.fill();
      }
    }
    layers.push({ data: grab(ctx), depth: Z, moving: false });

    // distant school of small fish
    ctx = getCtx(2); rnd = rng(33); Z = Zs + 2.2; s = S(Z);
    for (i = 0; i < 9; i++) {
      fish(ctx, X((rnd() - 0.5) * 2.0, Z), Y(0.15 + rnd() * 0.6, Z), 0.08 * s * (0.8 + rnd() * 0.4),
        i % 3 ? [240, 110, 150] : [250, 170, 60], null, 1);
    }
    layers.push({ data: grab(ctx), depth: Z, moving: true, speed: 0.35 });

    // background corals
    ctx = getCtx(3); rnd = rng(44); Z = Zs + 0.55; s = S(Z);
    by = floorRow(Z);
    for (i = 0; i < 5; i++) {
      tube(ctx, X(0.5 + i * 0.05 + (rnd() - 0.5) * 0.03, Z), by, 0.035 * s, (0.12 + rnd() * 0.14) * s, [150, 60, 140]);
    }
    branch(ctx, X(-0.65, Z), by, Math.PI / 2, 0.12 * s, 0.025 * s, 5, [205, 125, 165], rnd);
    branch(ctx, X(0.85, Z), by, Math.PI / 2, 0.1 * s, 0.02 * s, 5, [225, 190, 70], rnd);
    layers.push({ data: grab(ctx), depth: Z, moving: false });

    // main subject
    ctx = getCtx(4); rnd = rng(55); Z = Zs; s = S(Z);
    by = floorRow(Z);
    dome(ctx, X(-0.42, Z), by, 0.17 * s, 0.14 * s, [196, 164, 92], rnd, 'grooves');
    dome(ctx, X(-0.28, Z), by, 0.10 * s, 0.08 * s, [170, 110, 150], rnd, 'dots');
    seaFan(ctx, X(0.34, Z), by, 0.24 * s, 0.34 * s, [205, 40, 50], rnd);
    anemone(ctx, X(0.0, Z), by - 0.02 * s, 0.17 * s, [196, 96, 150], [245, 215, 235], rnd);
    if (st.chart) colourChart(ctx, X(0.58, Z), Y(-0.12, Z), 0.05 * s, by);
    layers.push({ data: grab(ctx), depth: Z, moving: false });

    // hero clownfish
    ctx = getCtx(5); Z = Math.max(0.12, Zs - 0.03); s = S(Z);
    fish(ctx, X(0.02, Z), Y(HERO_Y, Z), 0.11 * s, [250, 110, 20], [250, 250, 250], 1);
    fish(ctx, X(-0.13, Z), Y(-0.2, Z), 0.075 * s, [245, 105, 25], [250, 250, 250], -1);
    layers.push({ data: grab(ctx), depth: Z, moving: true, speed: 0.45 });

    // foreground (placed by screen position so it frames the shot)
    ctx = getCtx(6); rnd = rng(66);
    Z = Math.max(0.15, Zs - 0.45); if (Zs < 0.6) Z = Math.max(0.12, Zs * 0.5);
    s = S(Z); by = floorRow(Z);
    dome(ctx, W * 0.1, by, 0.08 * s, 0.1 * s, [215, 60, 40], rnd, 'dots');
    for (i = 0; i < 6; i++) {
      blade(ctx, W * (0.88 + i * 0.02), by + 0.02 * s, (0.22 + rnd() * 0.12) * s, 0.012 * s, [120, 150, 50], rnd);
    }
    layers.push({ data: grab(ctx), depth: Z, moving: false });

    return layers;
  }

  /* ---------- optics ---------- */
  function cocPx(z, zf, f, Nap) {
    var zm = z * 1000, zfm = Math.max(zf * 1000, f * 1.1);
    var c = f * f * Math.abs(zm - zfm) / (Nap * zm * (zfm - f));
    return c * PXMM * 1.5;   // blur diameter in px
  }

  function derive(st) {
    var w = WATERS[st.water] || WATERS.clear;
    var ref = !!st.ref;
    var f = st.lens, Nap = APERTURES[st.ap], den = SHUTTERS[st.sh], t = 1 / den, iso = ISOS[st.iso];
    var b = ref ? 0 : w.b + st.turb * 0.55;
    var k = ref ? [0, 0, 0] : w.k.map(function (v) { return v + st.turb * 0.15; });
    var c = k.map(function (v) { return v + b; });
    var kd = ref ? [0, 0, 0] : k.map(function (v, i) { return (v + 0.5 * b) * (i === 0 ? 1.15 : 1.6); });
    var lightMul = LIGHTS[st.light];
    var depth = ref ? 0 : st.depth;
    var Eamb = kd.map(function (v) { return 0.8 * (ref ? 1 : lightMul) * Math.exp(-v * depth); });
    var expoA = ref ? 1 / 0.8 : (t * iso / 100 / (Nap * Nap)) * 9600;
    var sync = den > 200 ? Math.max(0.2, 200 / den) : 1;
    var expoS = (iso / 100 / (Nap * Nap)) * 72 * sync;
    var strobeOn = !ref && !!st.strobe;
    var Binf = ref ? [0.5, 0.66, 0.82] : Eamb.map(function (e, i) { return e * w.tint[i] * 0.22 * expoA; });
    var F = [1, 1, 1];
    if (!ref && st.wb === 'filter') F = [0.95, 0.30, 0.08];
    var gain = [1, 1, 1];
    if (!ref && (st.wb === 'auto' || st.wb === 'filter')) {
      var r = [0, 1, 2].map(function (i) { return Eamb[i] * Math.exp(-c[i] * 1.2) * F[i]; });
      if (r[1] > 1e-5) gain = r.map(function (v) { return Math.min(20, r[1] / Math.max(v, 1e-9)); });
    }
    var lightShaft = 0;
    if (!ref && lightMul >= 0.3) lightShaft = 0.35 * Math.max(0, 1 - depth / 22) * (lightMul > 0.9 ? 1 : 0.4);
    return {
      f: f, N: Nap, den: den, t: t, iso: iso, b: b, k: k, c: c, kd: kd, Eamb: Eamb,
      expoA: expoA, expoS: expoS, sync: sync, P: Math.pow(2, -st.pow), off: st.off,
      strobeOn: strobeOn, Binf: Binf, F: F, gain: gain,
      zf: st.af ? st.dist : st.focus, diff: Math.max(0, Nap - 10) * 0.06,
      shakePx: ref ? 0 : 0.035 * t * f * PXMM, shafts: lightShaft,
      noise: ref ? 0 : Math.sqrt(iso / 100) * 0.9, vr: ref ? 0 : 0.03 + b,
      ref: ref, dist: st.dist, depth: depth,
      ambLevel: Eamb[1] * expoA, lightMul: lightMul, wb: st.wb
    };
  }

  /* ---------- blur ---------- */
  function boxH(src, dst, r) {
    var inv = 1 / (2 * r + 1);
    for (var y = 0; y < H; y++) {
      var row = y * W * 4;
      var s0 = 0, s1 = 0, s2 = 0, s3 = 0, k, x;
      for (k = -r; k <= r; k++) {
        var xi = (k < 0 ? 0 : k >= W ? W - 1 : k) * 4 + row;
        s0 += src[xi]; s1 += src[xi + 1]; s2 += src[xi + 2]; s3 += src[xi + 3];
      }
      for (x = 0; x < W; x++) {
        var o = row + x * 4;
        dst[o] = s0 * inv; dst[o + 1] = s1 * inv; dst[o + 2] = s2 * inv; dst[o + 3] = s3 * inv;
        var a = row + (x + r + 1 >= W ? W - 1 : x + r + 1) * 4;
        var bb = row + (x - r < 0 ? 0 : x - r) * 4;
        s0 += src[a] - src[bb]; s1 += src[a + 1] - src[bb + 1];
        s2 += src[a + 2] - src[bb + 2]; s3 += src[a + 3] - src[bb + 3];
      }
    }
  }

  function boxV(src, dst, r) {
    var inv = 1 / (2 * r + 1), W4 = W * 4, sum = pool.vsum, i, k, y;
    sum.fill(0);
    for (k = -r; k <= r; k++) {
      var yy = k < 0 ? 0 : k >= H ? H - 1 : k, o = yy * W4;
      for (i = 0; i < W4; i++) sum[i] += src[o + i];
    }
    for (y = 0; y < H; y++) {
      var oo = y * W4;
      for (i = 0; i < W4; i++) dst[oo + i] = sum[i] * inv;
      var a = y + r + 1, b = y - r;
      var oa = (a >= H ? H - 1 : a) * W4, ob = (b < 0 ? 0 : b) * W4;
      for (i = 0; i < W4; i++) sum[i] += src[oa + i] - src[ob + i];
    }
  }

  function gauss(src, dst, r) {
    var T = pool.T;
    boxH(src, T, r); boxV(T, dst, r);
    if (r > 2) { boxH(dst, T, r); boxV(T, dst, r); }
  }

  // Blur with a radius that may change per row. Returns src (no blur needed) or dst.
  function blurInto(src, dst, rad) {
    var mn = 1e9, mx = 0, y, j, i;
    for (y = 0; y < H; y++) { var r = rad[y]; if (r < mn) mn = r; if (r > mx) mx = r; }
    if (mx < 0.45) return src;
    if (mx - mn < 0.5) { gauss(src, dst, Math.max(1, Math.round((mn + mx) * 0.4))); return dst; }
    var L = 5, bufs = [];
    for (j = 0; j < L; j++) {
      var ri = Math.round((mn + (mx - mn) * j / (L - 1)) * 0.8);
      if (ri <= 0) bufs.push(src);
      else {
        if (!pool.lv[j]) pool.lv[j] = new Float32Array(N * 4);
        gauss(src, pool.lv[j], ri);
        bufs.push(pool.lv[j]);
      }
    }
    for (y = 0; y < H; y++) {
      var t = (rad[y] - mn) / (mx - mn) * (L - 1);
      var jj = Math.floor(t); if (jj >= L - 1) jj = L - 2; if (jj < 0) jj = 0;
      var fr = t - jj, a = bufs[jj], b = bufs[jj + 1], o = y * W * 4, end = o + W * 4;
      for (i = o; i < end; i++) dst[i] = a[i] + (b[i] - a[i]) * fr;
    }
    return dst;
  }

  /* ---------- light model per layer ---------- */
  function processLayer(L, cfg) {
    var data = L.data, A = pool.A, S = pool.S;
    var split = cfg.strobeOn && (L.moving || cfg.shakePx > 0.8) && cfg.ambLevel > 0.002;
    A.fill(0);
    if (split) S.fill(0);
    var hw = W / 2, hh = H / 2, inv = 1 / (cfg.f * PXMM * cfg.f * PXMM);
    var sumA = 0, sumS = 0, y, x;
    for (y = 0; y < H; y++) {
      var dd = L.zrow ? L.zrow[y] : L.depth;
      var g = 0.7 + 0.7 * (1 - y / H);
      var vf = 1 - Math.exp(-cfg.vr * dd);
      var ds = Math.max(0.15, Math.sqrt(dd * dd + cfg.off * cfg.off));
      var ea0 = cfg.Eamb[0] * Math.exp(-cfg.c[0] * dd) * cfg.expoA;
      var ea1 = cfg.Eamb[1] * Math.exp(-cfg.c[1] * dd) * cfg.expoA;
      var ea2 = cfg.Eamb[2] * Math.exp(-cfg.c[2] * dd) * cfg.expoA;
      var v0 = cfg.Binf[0] * vf * g, v1 = cfg.Binf[1] * vf * g, v2 = cfg.Binf[2] * vf * g;
      var es0 = 0, es1 = 0, es2 = 0;
      if (cfg.strobeOn) {
        var kk = cfg.P * cfg.expoS / (ds * ds);
        es0 = kk * Math.exp(-cfg.c[0] * (ds + dd));
        es1 = kk * Math.exp(-cfg.c[1] * (ds + dd));
        es2 = kk * Math.exp(-cfg.c[2] * (ds + dd));
      }
      var dy2 = (y - hh) * (y - hh);
      var coc = cocPx(dd, cfg.zf, cfg.f, cfg.N) * 0.5;
      var fs = cfg.b * dd * 1.2;
      var rs = Math.min(36, Math.sqrt(coc * coc + cfg.diff * cfg.diff + fs * fs));
      radS[y] = rs;
      radA[y] = Math.sqrt(rs * rs + cfg.shakePx * cfg.shakePx * 0.25);
      var row = y * W;
      for (x = 0; x < W; x++) {
        var p = (row + x) * 4, a8 = data[p + 3];
        if (a8 === 0) continue;
        var al = a8 / 255;
        var r = LIN[data[p]], gg = LIN[data[p + 1]], bb = LIN[data[p + 2]];
        var ar = r * ea0 + v0, ag = gg * ea1 + v1, ab = bb * ea2 + v2;
        if (cfg.strobeOn) {
          var dx = x - hw;
          var beam = Math.max(0.05, 1 - 0.388 * (dx * dx + dy2) * inv);
          var sr = r * es0 * beam, sg = gg * es1 * beam, sb = bb * es2 * beam;
          if (split) {
            S[p] = sr * al; S[p + 1] = sg * al; S[p + 2] = sb * al; S[p + 3] = al;
            sumS += sg * al;
          } else { ar += sr; ag += sg; ab += sb; }
        }
        A[p] = ar * al; A[p + 1] = ag * al; A[p + 2] = ab * al; A[p + 3] = al;
        sumA += ag * al;
      }
    }
    if (!split) return blurInto(A, pool.RA, radA);

    var RA = blurInto(A, pool.RA, radA);
    if (L.moving) {
      var len = L.speed * (cfg.f * PXMM / L.depth) * cfg.t;   // px smeared during exposure
      var mr = Math.round(len * 0.5);
      if (mr >= 1) { boxH(RA, pool.RM, Math.min(mr, 120)); RA = pool.RM; }
    }
    var RS = blurInto(S, pool.RS, radS);
    var share = sumS / (sumA + sumS + 1e-9);
    for (var i = 0; i < N * 4; i += 4) {
      RA[i] += RS[i]; RA[i + 1] += RS[i + 1]; RA[i + 2] += RS[i + 2];
      RA[i + 3] = RA[i + 3] * (1 - share) + RS[i + 3] * share;
    }
    return RA;
  }

  function compositeOver(out, res) {
    for (var i = 0, j = 0; i < N; i++, j += 4) {
      var a = res[j + 3];
      if (a <= 0.0005) continue;
      var ia = 1 - (a > 1 ? 1 : a), o = i * 3;
      out[o] = res[j] + out[o] * ia;
      out[o + 1] = res[j + 1] + out[o + 1] * ia;
      out[o + 2] = res[j + 2] + out[o + 2] * ia;
    }
  }

  function paintWater(out, cfg) {
    for (var y = 0; y < H; y++) {
      var g = 0.7 + 0.7 * (1 - y / H);
      for (var x = 0; x < W; x++) {
        var m = g;
        if (cfg.shafts > 0) {
          var u = x + y * 0.55;
          m *= 1 + cfg.shafts * (0.5 + 0.5 * Math.sin(u * 0.031 + 1)) * (0.5 + 0.5 * Math.sin(u * 0.0113 + 2.1)) * (1 - y / H) * 1.4;
        }
        var i = (y * W + x) * 3;
        out[i] = cfg.Binf[0] * m; out[i + 1] = cfg.Binf[1] * m; out[i + 2] = cfg.Binf[2] * m;
      }
    }
  }

  function paintParticles(out, cfg) {
    if (!cfg.strobeOn) return;
    var rnd = rng(777);
    var geom = 1 / (1 + Math.pow(cfg.off / 0.16, 2.2));
    var n = Math.floor(Math.min(520, 10 + cfg.b * 1000));
    var zmax = Math.max(0.4, Math.min(cfg.dist, 2.5));
    for (var i = 0; i < n; i++) {
      var px = rnd() * W, py = rnd() * H, zp = 0.12 + rnd() * (zmax - 0.12);
      var sz = 0.3 + 1.7 * Math.pow(rnd(), 3);
      var e = 4 * cfg.P * geom * cfg.expoS * sz;
      var R = Math.min(26, Math.max(0.8, cocPx(zp, cfg.zf, cfg.f, cfg.N) * 0.5 + 0.6 * sz));
      var peak = e / (1 + (R / 1.4) * (R / 1.4));
      var t0 = Math.exp(-cfg.c[0] * zp * 2), t1 = Math.exp(-cfg.c[1] * zp * 2), t2 = Math.exp(-cfg.c[2] * zp * 2);
      var x0 = Math.max(0, Math.floor(px - R)), x1 = Math.min(W - 1, Math.ceil(px + R));
      var y0 = Math.max(0, Math.floor(py - R)), y1 = Math.min(H - 1, Math.ceil(py + R));
      for (var yy = y0; yy <= y1; yy++) {
        for (var xx = x0; xx <= x1; xx++) {
          var dx = xx - px, dy = yy - py, d2 = (dx * dx + dy * dy) / (R * R);
          if (d2 >= 1) continue;
          var v = peak * (1 - d2) * (1 - d2), o = (yy * W + xx) * 3;
          out[o] += v * t0; out[o + 1] += v * t1; out[o + 2] += v * t2;
        }
      }
    }
  }

  function tone(x) {
    if (x <= 0) return 0;
    if (x > 0.85) x = 0.85 + 0.15 * (1 - Math.exp(-(x - 0.85) / 0.15));
    return x > 1 ? 1 : x;
  }

  function finish(out, cfg, img) {
    var rnd = rng(4242);
    var hist = new Uint32Array(3 * 64);
    var lum = 0, clip = 0, ns = cfg.noise, F = cfg.F, G = cfg.gain;
    for (var i = 0; i < N; i++) {
      var j = i * 3;
      var r = out[j] * F[0], g = out[j + 1] * F[1], b = out[j + 2] * F[2];
      if (ns > 0) {
        r += (rnd() + rnd() - 1) * 2.45 * (0.0025 + 0.009 * Math.sqrt(r > 0 ? r : 0)) * ns;
        g += (rnd() + rnd() - 1) * 2.45 * (0.0025 + 0.009 * Math.sqrt(g > 0 ? g : 0)) * ns;
        b += (rnd() + rnd() - 1) * 2.45 * (0.0025 + 0.009 * Math.sqrt(b > 0 ? b : 0)) * ns;
      }
      r *= G[0]; g *= G[1]; b *= G[2];
      if (r > 1 || g > 1 || b > 1) clip++;
      r = tone(r); g = tone(g); b = tone(b);
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      var R8 = ENC[(r * 2047 + 0.5) | 0], G8 = ENC[(g * 2047 + 0.5) | 0], B8 = ENC[(b * 2047 + 0.5) | 0];
      var o = i * 4;
      img[o] = R8; img[o + 1] = G8; img[o + 2] = B8; img[o + 3] = 255;
      hist[R8 >> 2]++; hist[64 + (G8 >> 2)]++; hist[128 + (B8 >> 2)]++;
    }
    return { lum: lum / N, clip: clip / N, hist: hist };
  }

  function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

  function render(st, ctx2d) {
    var t0 = now();
    var cfg = derive(st);
    var key = st.lens + '|' + st.dist + '|' + (st.chart ? 1 : 0);
    if (cache.key !== key) { cache.layers = buildLayers(st); cache.key = key; }
    var out = pool.out;
    paintWater(out, cfg);
    for (var i = 0; i < cache.layers.length; i++) {
      compositeOver(out, processLayer(cache.layers[i], cfg));
    }
    paintParticles(out, cfg);
    if (!pool.img || pool.imgCtx !== ctx2d) { pool.img = ctx2d.createImageData(W, H); pool.imgCtx = ctx2d; }
    var m = finish(out, cfg, pool.img.data);
    ctx2d.putImageData(pool.img, 0, 0);
    m.cfg = cfg;
    m.ms = now() - t0;
    return m;
  }

  /* ---------- plain-English explanation of what the current settings do ---------- */
  function metres(v) { return v < 10 ? v.toFixed(2) : v.toFixed(1); }

  function describe(st, cfg, m) {
    var notes = [];
    function add(tone, text) { notes.push({ tone: tone, text: text }); }
    var redAmb = Math.exp(-cfg.kd[0] * cfg.depth) * 100;
    var ds = Math.max(0.15, Math.sqrt(cfg.dist * cfg.dist + cfg.off * cfg.off));

    if (st.light === 'night') {
      add('info', 'Night: there is no ambient light at all, so everything you see is lit by your strobe.');
    } else if (cfg.depth >= 2) {
      add('info', 'At ' + cfg.depth + ' m about ' + (redAmb < 1 ? 'none' : Math.round(redAmb) + '%') +
        ' of the sun\u2019s red light is left. Blue survives best, so anything the strobe does not reach looks blue-green.');
    } else {
      add('info', 'Close to the surface most of the sun\u2019s colour is still there, so colours look fairly natural.');
    }

    if (cfg.strobeOn) {
      var redStrobe = Math.exp(-cfg.c[0] * (ds + cfg.dist)) * 100;
      add('info', 'The strobe puts full-spectrum light back, but it travels ' + (ds + cfg.dist).toFixed(1) +
        ' m through water and weakens with the square of distance: only about ' + Math.round(redStrobe) +
        '% of its red survives the trip. Halve the distance and the light is four times stronger.');
    } else if (st.light !== 'night') {
      add('info', 'No strobe: colour depends on the remaining sunlight only. A custom white balance or red filter can recover some, at the cost of noise or light.');
    }

    if (cfg.strobeOn && cfg.b > 0.15) {
      if (cfg.off < 0.3) add('warn', 'Strobes this close to the lens light the particles that sit between you and the subject, so they bounce light straight back as bright "snow" (backscatter). Move them wider or turn the power down.');
      else add('good', 'Wide strobe positioning keeps most of the lit particles out of the camera\u2019s view, so backscatter stays low even in cloudy water.');
    }

    if (cfg.strobeOn && cfg.den > 200) {
      add('warn', 'Shutter 1/' + cfg.den + ' is faster than typical strobe sync (about 1/200), so the flash is partly cut off and the frame gets darker.');
    } else if (cfg.shakePx > 1.5) {
      add('warn', '1/' + cfg.den + ' is slow for a ' + cfg.f + 'mm lens held by hand: expect camera shake in the ambient-lit parts' +
        (cfg.strobeOn ? ', while strobe-lit parts stay sharp because the flash is so brief.' : '.'));
    }
    var fishLen = 0.45 * (cfg.f * PXMM / Math.max(0.12, st.dist)) * cfg.t;
    if (fishLen > 3) {
      add('warn', 'At this shutter speed the swimming fish smears by about ' + Math.round(fishLen) + ' px' +
        (cfg.strobeOn ? '. The strobe freezes a sharp copy, leaving a ghost trail from the ambient light.' : '.'));
    }

    var Hd = cfg.f * cfg.f / (cfg.N * 0.03) + cfg.f, zfmm = cfg.zf * 1000;
    var near = Hd * zfmm / (Hd + (zfmm - cfg.f)) / 1000;
    var far = (zfmm - cfg.f) < Hd ? Hd * zfmm / (Hd - (zfmm - cfg.f)) / 1000 : Infinity;
    add('info', 'f/' + cfg.N + ' with a ' + cfg.f + 'mm lens focused at ' + metres(cfg.zf) + ' m: acceptably sharp from ' +
      metres(near) + ' m to ' + (isFinite(far) ? metres(far) + ' m' : 'infinity') + '.' +
      (cfg.N >= 16 ? ' Very small apertures also soften the image slightly (diffraction) and need much more light.' : '') +
      (cfg.N <= 2.8 ? ' Wide apertures let in lots of light but give a very thin zone of focus.' : ''));

    if (cfg.iso >= 1600 || (cfg.gain[0] > 3 && cfg.iso >= 400)) {
      add('warn', 'ISO ' + cfg.iso + ' adds visible noise' + (cfg.gain[0] > 3 ? ', and the white-balance boost on the weak red channel (x' + cfg.gain[0].toFixed(1) + ') amplifies it further' : '') + '.');
    }
    if (st.wb === 'auto' && cfg.strobeOn && cfg.gain[0] > 1.5) {
      add('warn', 'Custom white balance is set for the ambient light, so strobe-lit areas now come out too red.');
    }
    if (st.wb === 'filter') {
      add('info', 'A red filter removes much of the blue-green light (costing about 2 stops) and also tints strobe light red.');
    }

    var ev = Math.log(m.lum / 0.18 + 1e-9) / Math.LN2;
    if (!cfg.ref) {
      if (ev < -1.3) add('warn', 'Underexposed. Open the aperture, slow the shutter, raise ISO or add strobe power.');
      else if (ev > 1 || m.clip > 0.08) add('warn', 'Overexposed with blown highlights. Close the aperture, speed up the shutter, lower ISO or reduce strobe power.');
    }
    var rank = { warn: 0, good: 1, info: 2 };
    notes.sort(function (a, b) { return rank[a.tone] - rank[b.tone]; });
    return notes.slice(0, 7);
  }

  var Sim = {
    W: W, H: H, APERTURES: APERTURES, SHUTTERS: SHUTTERS, ISOS: ISOS, STROBE_STOPS: STROBE_STOPS,
    WATERS: WATERS, DEFAULTS: DEFAULTS, PRESETS: PRESETS,
    render: render, describe: describe, derive: derive,
    setCanvasFactory: function (fn) { makeCanvas = fn; cache.key = null; }
  };
  root.Sim = Sim;
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
})(typeof window !== 'undefined' ? window : globalThis);
