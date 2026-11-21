(() => {
  const retryLink = document.getElementById('startup-retry');
  if (!retryLink) return;
  const marker = '__startup_retry';
  const url = new URL(location.href);
  const title = 'BYOB 와인 투표' + (/^\/v\/[^/]+\/?$/.test(url.pathname) ? '' : ' · 운영자');
  document.title = title;
  const heading = document.getElementById('startup-title');
  if (heading) heading.textContent = title;
  function retry() {
    url.searchParams.set(marker, Date.now().toString());
    location.replace(url.href);
  }
  function failed() {
    clearTimeout(timer);
    window.removeEventListener('error', scriptError, true);
    if (!url.searchParams.has(marker)) retry();
  }
  function scriptError(event) {
    if (event.target?.tagName === 'SCRIPT' && event.target.type === 'module') failed();
  }
  retryLink.addEventListener('click', event => {
    event.preventDefault();
    retry();
  });
  window.addEventListener('error', scriptError, true);
  const timer = setTimeout(failed, 10000);
  window.addEventListener('byob:mounted', () => {
    clearTimeout(timer);
    window.removeEventListener('error', scriptError, true);
    if (url.searchParams.has(marker)) {
      const current = new URL(location.href);
      current.searchParams.delete(marker);
      history.replaceState(history.state, '', current.href);
    }
  }, { once: true });
})();
