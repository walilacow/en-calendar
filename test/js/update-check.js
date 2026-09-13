
// 新版本自動偵測：以 no-store 抓取自身 HTML 比對版本，發現新版時顯示更新橫幅（不清資料）
(function () {
  function showUpdateBanner(ver) {
    if (document.getElementById('updateBanner')) return;
    var b = document.createElement('button');
    b.id = 'updateBanner';
    b.textContent = '🎉 發現新版本 v' + ver + '，點此更新（資料不會遺失）';
    b.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);z-index:300;background:var(--accent);color:#14141c;border:none;border-radius:99px;padding:12px 20px;font-weight:700;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.45);cursor:pointer;font-family:inherit;';
    b.onclick = function () {
      try {
        if ('caches' in window) {
          caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }).catch(function () {});
        }
      } catch (e) {}
      location.href = location.pathname + '?_=' + Date.now();
    };
    document.body.appendChild(b);
  }
  async function checkAppUpdate() {
    try {
      var res = await fetch(location.pathname, { cache: 'no-store' });
      var txt = await res.text();
      var m = txt.match(/<meta name="app-version" content="([^"]+)">/);
      var localEl = document.querySelector('meta[name="app-version"]');
      if (m && localEl && m[1] !== localEl.content) showUpdateBanner(m[1]);
    } catch (e) {}
  }
  checkAppUpdate();
  setInterval(checkAppUpdate, 30 * 60 * 1000);
})();
