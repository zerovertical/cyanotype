/* Runs before the modules and independently of them.

   A module that fails to parse or load cannot report itself — nothing inside
   it ever executes — so the only reporter that can survive that is a plain
   script that already ran. This one also renders the diagnostics panel, so
   the report works even when no module code is alive. */
(function () {
  var t0 = Date.now();
  var finished = false;
  var reported = false;          // a real error must not be clobbered by the timeout
  var errors = [];
  var marks = [];

  function $(id) { return document.getElementById(id); }

  function paint(headline) {
    var st = $('state'); if (st) st.textContent = 'startup failed';
    var dot = $('dot'); if (dot) dot.className = 'dot bad';
    var t = $('toast');
    if (t) { t.textContent = headline; t.className = 'toast on bad'; }
    renderDiag();
    var scr = $('s-diag');
    if (scr) {
      var all = document.querySelectorAll('.screen');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('on');
      scr.classList.add('on');
    }
  }

  function report(msg, hard) {
    if (finished) return;
    if (reported && !hard) return;   // keep the first real cause
    if (hard) reported = true;
    paint(msg);
  }

  function renderDiag() {
    var box = $('diagBody'); if (!box) return;
    var sw = 'none';
    try { sw = navigator.serviceWorker && navigator.serviceWorker.controller ? 'controlling' : 'none'; } catch (e) {}
    var rows = [
      ['modules ran', marks.length ? 'yes' : 'NO — script never executed'],
      ['stages', marks.length ? marks.join(' > ') : 'none'],
      ['errors', errors.length ? errors.join(' | ') : 'none recorded'],
      ['es modules', ('noModule' in HTMLScriptElement.prototype) ? 'yes' : 'NO'],
      ['vendor libs', (typeof window.qrcode === 'function' ? 'qrcode ' : '') +
                      (typeof window.jsQR === 'function' ? 'jsQR' : '') || 'NEITHER LOADED'],
      ['secure context', window.isSecureContext ? 'yes' : 'NO'],
      ['web crypto', (window.crypto && window.crypto.subtle) ? 'yes' : 'NO'],
      ['webrtc', window.RTCPeerConnection ? 'yes' : 'NO'],
      ['camera api', (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ? 'yes' : 'NO'],
      ['indexeddb', window.indexedDB ? 'yes' : 'NO'],
      ['service worker', sw],
      ['elapsed', (Date.now() - t0) + 'ms'],
      ['ua', navigator.userAgent]
    ];
    box.innerHTML = '';
    for (var i = 0; i < rows.length; i++) {
      var r = document.createElement('div'); r.className = 'diagRow';
      var k = document.createElement('span'); k.className = 'diagKey'; k.textContent = rows[i][0];
      var v = document.createElement('span'); v.className = 'diagVal'; v.textContent = String(rows[i][1]);
      r.appendChild(k); r.appendChild(v); box.appendChild(r);
    }
  }

  window.__boot = {
    mark: function (name) { marks.push(name + '@' + (Date.now() - t0) + 'ms'); },
    done: function () { finished = true; },
    fail: function (m) { report(m, true); },
    diag: renderDiag
  };

  // Capture phase catches failed <script>/<link> loads, which do not bubble.
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && e.target.src) {
      errors.push('load failed: ' + String(e.target.src).split('/').pop());
      report('Could not load ' + String(e.target.src).split('/').pop() +
             '. A stale service worker or an incomplete deploy usually causes this.', true);
    } else if (e.message) {
      errors.push(e.message + (e.filename ? ' (' + String(e.filename).split('/').pop() + ':' + e.lineno + ')' : ''));
      report(e.message, true);
    }
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var m = (e.reason && e.reason.message) || String(e.reason);
    errors.push('unhandled: ' + m);
    report('Unhandled error: ' + m, true);
  });

  setTimeout(function () {
    if (finished) return;
    report(marks.length
      ? 'Startup stalled after: ' + marks[marks.length - 1] + '. Details below.'
      : 'App code never ran — nothing executed at all. Details below.', false);
  }, 9000);
})();
