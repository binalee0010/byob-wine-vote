(() => {
  const pageId = crypto.randomUUID();
  const touchTrace = [];
  const taps = [];
  let calibration = Number(sessionStorage.getItem('qa-ios-calibration') || 0);
  let centered = false;
  let submitCommand = Number(sessionStorage.getItem('qa-ios-submit') || 0);
  let busy = false;
  const center = element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
    document.addEventListener(type, event => {
      const row = event.target.closest?.('.custom-rank-summary .rank-row');
      if (row) touchTrace.push({ wine: row.querySelector('.rank-wine strong')?.textContent, name: type, type: event.pointerType, trusted: event.isTrusted });
    }, { capture: true, passive: true });
  }
  function startCalibration() {
    taps.length=0;
    document.getElementById('qa-ios-calibration')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'qa-ios-calibration';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(255,255,255,.95);color:#000;font:16px sans-serif;touch-action:none';
    overlay.innerHTML = '<p style="padding:20px">Tap the two targets to calibrate CSS coordinates.</p><span style="position:absolute;left:80px;top:180px;transform:translate(-50%,-50%)">⊕ 1 (80,180)</span><span style="position:absolute;left:280px;top:380px;transform:translate(-50%,-50%)">⊕ 2 (280,380)</span>';
    overlay.addEventListener('pointerdown', event => {
      taps.push({ x: event.clientX, y: event.clientY, type: event.pointerType, trusted: event.isTrusted });
      if (taps.length === 2) {
        overlay.remove();
      }
    }, { passive: true });
    document.body.append(overlay);
  }
  async function report() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const summary = document.querySelector('.custom-rank-summary');
      if (summary && !centered) {
        centered = true;
        summary.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
      const commands = await fetch('/observe-command', { cache: 'no-store' }).then(response => response.json());
      if(commands.calibrate > calibration) {
        calibration=commands.calibrate;
        sessionStorage.setItem('qa-ios-calibration',String(calibration));
        startCalibration();
      }
      const submit = document.querySelector('.ranked-answer .form-footer button.primary');
      if (commands.submit > submitCommand && submit) {
        submitCommand = commands.submit;
        sessionStorage.setItem('qa-ios-submit', String(submitCommand));
        submit.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
      const snapshot = {
        pageId,
        calibration,
        userAgent: navigator.userAgent,
        text: document.body.innerText.slice(0,500),
        order: Array.from(document.querySelectorAll('.custom-rank-summary .rank-wine strong'), element => element.textContent),
        values: Array.from(document.querySelectorAll('.custom-rank-row select'), element => element.value),
        grips: Array.from(document.querySelectorAll('.custom-rank-summary .rank-grip'), center),
        touchTrace,
        taps,
        submit: submit ? center(submit) : null,
      };
      await fetch('/observe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot) });
      const handledReload = Number(sessionStorage.getItem('qa-ios-reload') || 0);
      if (commands.reload > handledReload) {
        sessionStorage.setItem('qa-ios-reload', String(commands.reload));
        location.reload();
      }
    } catch (error) {
      console.warn('QA observation report failed', error);
    } finally {
      busy = false;
    }
  }
  void report();
  setInterval(() => void report(), 250);
})();
