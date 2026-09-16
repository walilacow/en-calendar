
(function () {
  'use strict';

  const APP_VERSION = '1.5.9';
  const STORE_KEY = 'voiceHostCalendar_v1';

  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const CAL_WEEK = WEEK; // 日曆表頭（週日起）

  // 所有設定項的預設值（sanitizeStore / load 共用）
  const DEFAULT_SETTINGS = {
    enableGiftTasks: true, enableSalesScore: false,
    enableDragon: true, enableCastle: true,
    giftCutoffHour: 0, salesCutoffHour: 8,
    salesDayTarget: 0, salesWeekTarget: 0, salesMonthTarget: 0
  };

  // scope → store 欄位對應（day/week/month）
  const BUCKET = { day: 'dates', week: 'weeks', month: 'months' };

  // 禮物圖示對應表情符號（圖片載入失敗時降級顯示用文字）
  const GIFT_EMOJI = { '玫瑰':'🌹','火箭':'🚀','城堡':'🏰','金龍':'🐉','跑車':'🏎️','飛機':'✈️','遊艇':'🛥️','鑽戒':'💍','皇冠':'👑','煙花':'🎆','愛心':'❤️','禮物盒':'🎁' };

  /* store 資料模型（所有持久化資料的形狀）：
   *   dates:  { 'YYYY-MM-DD':           { tasks: [...], slots: [...], note, special: {dragon, castle} } }
   *   weeks:  { 'YYYY-MM-DD'（該週日起）: { tasks: [...] } }
   *   months: { 'YYYY-MM':              { tasks: [...] } }
   *   ranges:  自訂區間 { id: { name, start, end, tasks } }
   *   scoreLog / salesLog / listeners / settings 見各段落
   * 注意：load() 在下方定義，但因 function declaration 會提升，這裡可直接呼叫 */
  let store = load();
  let viewYear, viewMonth;
  let openDate = null;   // 目前開啟的日期面板（YYYY-MM-DD）
  let scope = 'day';     // day | week | month | custom
  let weekStatsOpen = false; // 週面板「本週分數統計」是否展開
  let customId = null;   // 目前選擇的自訂區間 id
  let showCreateRange = false;

  // ---------- Firebase 登入與雲端資料庫 ----------
  // ⚠️ 請把下面 6 個 PASTE 換成你自己的 Firebase 設定值（設定教學見文件）
  const FB_CONFIG = {
    apiKey: "AIzaSyClGhrZrcjfzHBhSiSUWDuZk9OqnXCPY_M",
    authDomain: "en-calendar-dbb36.firebaseapp.com",
    projectId: "en-calendar-dbb36",
    storageBucket: "en-calendar-dbb36.firebasestorage.app",
    messagingSenderId: "759675780359",
    appId: "1:759675780359:web:5040f38da2dd71ea4019a2"
  };

  let fbOk = false;
  let auth = null, db = null, currentUid = null, cloudTimer = null;

  try {
    if (FB_CONFIG.apiKey === 'PASTE') throw new Error('尚未設定 Firebase（聯絡管理員）');
    firebase.initializeApp(FB_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {
      setTimeout(() => { $('loginErr').textContent = '⚠️ 瀏覽器不允許保存登入狀態（可能是私密瀏覽），關掉頁面後會需要重新登入'; }, 200);
    });
    fbOk = true;
  } catch (err) {
    setTimeout(() => { $('loginErr').textContent = '⚠️ ' + err.message; }, 100);
  }

  // iPhone 使用建議（僅 iOS、非桌面 App 模式、未關閉過才顯示）
  try {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isIOS && !standalone && localStorage.getItem('iosTipHide') !== '1') {
      $('iosTip').style.display = 'block';
    }
  } catch (e) {}
  $('iosTipClose').onclick = () => {
    $('iosTip').style.display = 'none';
    try { localStorage.setItem('iosTipHide', '1'); } catch (e) {}
  };

  function scheduleCloudSave() {
    if (!fbOk || !currentUid) return;
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(() => {
      const payload = {
        dates: store.dates || {},
        weeks: store.weeks || {},
        months: store.months || {},
        ranges: store.ranges || {},
        scoreLog: store.scoreLog || {},
        listeners: store.listeners || [],
        settings: store.settings || {},
        salesLog: store.salesLog || {},
        // 主播 profile 一併上雲（nickOk 之後的任何資料異動都會排程這裡）
        email: (firebase.auth().currentUser && firebase.auth().currentUser.email) || '',
        nickname: nickname || '',
        alias: alias || '',
        avatar: avatarKey || '',
        avatarData: (function(){ try { return localStorage.getItem('voiceAvatarData') || ''; } catch (e) { return ''; } })(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      // 用 update() 把這些欄位「整個覆寫」。原本的 set(merge:true) 會把 dates 等巢狀物件深度合併，
      // 本機刪掉的鍵（例如刪光開播時段後被移除的 slots、清掉的趣事）不會從雲端移除，
      // 下次開 App 從雲端載入就又被還原。文件還不存在（第一次登入）才退回 set(merge:true) 建立。
      const ref = db.collection('users').doc(currentUid);
      ref.update(payload).catch((err) => {
        if (err && err.code === 'not-found') return ref.set(payload, { merge: true }).catch(() => {});
      });
    }, 1500);
  }


  /* 雲端/本機合併策略：以雲端為主，但本機「任務數較多」的日期/週/月保留本機版本，
   * 避免空白或較舊的雲端資料蓋掉本機較新的資料；
   * 雲端缺 listeners / settings / salesLog 時用本機補上。 */
  function mergeLocalIntoCloud(cloud) {
    // 本機資料先消毒再合併：raw localStorage 可能含壞分數/字串數字，直接蓋回 store 會污染分數計算
    const local = sanitizeStore(JSON.parse(localStorage.getItem(STORE_KEY) || '{}'));
    ['dates', 'weeks', 'months'].forEach(function (bk) {
      const lb = (local && local[bk]) || {};
      Object.keys(lb).forEach(function (k) {
        // 只計算真正的陣列任務數：壞資料（例如 tasks 是字串）會讓 .length 變成字串長度，誤判本機較新
        const ltArr = Array.isArray(lb[k] && lb[k].tasks) ? lb[k].tasks : [];
        const ctArr = Array.isArray(cloud[bk][k] && cloud[bk][k].tasks) ? cloud[bk][k].tasks : [];
        if (ltArr.length > ctArr.length) cloud[bk][k] = lb[k];
      });
    });
    if ((!cloud.listeners || !cloud.listeners.length) && Array.isArray(local.listeners)) cloud.listeners = local.listeners;
    if ((!cloud.settings || typeof cloud.settings !== 'object') && local.settings) cloud.settings = local.settings;
    if ((!cloud.salesLog || typeof cloud.salesLog !== 'object') && local.salesLog) cloud.salesLog = local.salesLog;
  }


  function showLogin() { $('loginOverlay').style.display = 'flex'; $('mainContent').style.display = 'none'; }
  function showApp() { $('loginOverlay').style.display = 'none'; $('mainContent').style.display = 'block'; }

  if (fbOk) {
    auth.onAuthStateChanged(async (user) => {
      if (!user) { currentUid = null; showLogin(); return; }
      currentUid = user.uid;
      showApp();
      try {
        const snap = await db.collection('users').doc(user.uid).get();
        if (snap.exists) {
          const d = snap.data();
          // 補存 email（給最高管理者頁面列出主播用；舊資料沒有 email 會在這裡補上）
          try { if (user.email && d.email !== user.email) db.collection('users').doc(user.uid).set({ email: user.email }, { merge: true }).catch(() => {}); } catch (e) {}
          const cloud = sanitizeStore({ dates: d.dates, weeks: d.weeks, months: d.months, ranges: d.ranges, scoreLog: d.scoreLog, salesLog: d.salesLog, listeners: d.listeners, settings: d.settings });
          // 合併保險：本機任務較多的期間保留本機版，避免空/舊雲端清掉本機資料
          try { mergeLocalIntoCloud(cloud); } catch (e) {}
          store = cloud;
          save();
          // 所屬廳房（後台設定，預設未知）
          try {
            if (typeof d.room === 'string') hostRoom = d.room;
          } catch (e) {}
          if (d.nickname) {
            nickname = d.nickname;
            lsSetRaw('nick_v1', nickname);
            applyNick();
          }
          if (d.alias) {
            alias = d.alias;
            lsSetRaw('alias_v1', alias);
          }
          if (d.avatar) {
            avatarKey = d.avatar;
            lsSetRaw('avatar_v1', avatarKey);
          }
          // 開啟 App 時反向補漏：雲端缺 profile 但本機有 → 推上雲（修復舊版被覆蓋掉的資料）
          try {
            const _pf = {};
            if (!d.nickname && nickname) _pf.nickname = nickname;
            if (!d.alias && alias) _pf.alias = alias;
            if (!d.avatar && avatarKey) _pf.avatar = avatarKey;
            if (!d.avatarData && avatarData) _pf.avatarData = avatarData;
            if (Object.keys(_pf).length) {
              db.collection('users').doc(currentUid).set(_pf, { merge: true }).catch(() => {});
            }
          } catch (e) {}
          if (d.avatarData) {
            avatarData = d.avatarData;
            lsSetRaw('avatarData_v1', avatarData);
            applyNick();
          }
        } else {
          // 雲端沒有這個帳號的資料：可能是全新用戶，也可能是後台把這個主播的資料刪除了
          // 兩種情況都要確保本機是乾淨狀態，不會把舊的本機快取又傳回雲端
          store = { dates: {}, weeks: {}, months: {}, ranges: {}, scoreLog: {}, salesLog: {}, listeners: [], settings: Object.assign({}, DEFAULT_SETTINGS) };
          save();
          nickname = ''; alias = ''; avatarKey = 'cat'; avatarData = ''; hostRoom = '';
          lsSetRaw('nick_v1', ''); lsSetRaw('alias_v1', ''); lsSetRaw('avatar_v1', 'cat'); lsSetRaw('avatarData_v1', '');
        }
      } catch (err) {}
      renderCalendar();
      if (!nickname || !alias) {
        $('nickInput').value = '';
        $('aliasInput').value = '';
        renderAvatarPicker();
        $('nameOverlay').style.display = 'flex';
        setTimeout(() => $('nickInput').focus(), 200);
      }
    });
    auth.getRedirectResult().catch(() => {});

    $('googleLoginBtn').onclick = () => {
      $('loginErr').textContent = '登入中…';
      const provider = new firebase.auth.GoogleAuthProvider();
      auth.signInWithPopup(provider).catch((e) => {
        const code = e && e.code;
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
          $('loginErr').textContent = '已取消登入';
        } else {
          $('loginErr').textContent = '改用重新導向方式登入…';
          auth.signInWithRedirect(provider);
        }
      });
    };
  }

  $('logoutBtn').onclick = () => { if (fbOk && auth) auth.signOut(); };

  // ---------- 主播暱稱 / 馬甲 / 頭像 ----------
  const AVATARS = [
    ['cat', '貓'], ['dog', '狗'], ['rabbit', '兔'], ['bear', '熊'],
    ['fox', '狐'], ['panda', '熊貓'], ['owl', '貓頭鷹'], ['unicorn', '獨角獸']
  ];
  let nickname = localStorage.getItem('nick_v1') || '';
  let alias = localStorage.getItem('alias_v1') || '';
  let avatarKey = localStorage.getItem('avatar_v1') || 'cat';
  let avatarData = localStorage.getItem('avatarData_v1') || ''; // 自訂頭像（壓縮後 base64）

  // 取得目前頭像 URL（自訂優先，其次預設圖）
  function avatarURL() {
    return avatarData || AVATAR_IMG[avatarKey] || AVATAR_IMG.cat;
  }

  $('avatarFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('圖片太大（上限 5MB）'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // 壓縮到 256x256 JPEG
        const S = 256;
        const cv = document.createElement('canvas');
        cv.width = S; cv.height = S;
        const c = cv.getContext('2d');
        const side = Math.min(img.width, img.height);
        c.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
        let data = cv.toDataURL('image/jpeg', 0.85);
        // 保險：若超過 200KB 再降品質
        let q = 0.85;
        while (data.length > 200 * 1024 && q > 0.4) {
          q -= 0.15;
          data = cv.toDataURL('image/jpeg', q);
        }
        if (data.length > 300 * 1024) { toast('圖片壓縮後仍過大，請換一張'); return; }
        avatarData = data;
        try { lsSetRaw('avatarData_v1', data); } catch (e) { /* 本機容量滿也不中斷 */ }
        if (fbOk && currentUid) {
          db.collection('users').doc(currentUid).set({ avatarData: data }, { merge: true }).catch(() => {});
        }
        renderAvatarPicker();
        applyNick();
        toast('✅ 頭像已更新');
      };
      img.onerror = () => toast('無法讀取圖片');
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
    e.target.value = '';
  });

  function renderAvatarPicker() {
    const row = $('avatarPickRow');
    row.innerHTML = '';
    AVATARS.forEach(([key, label]) => {
      const b = document.createElement('button');
      const on = key === avatarKey;
      b.style.cssText = 'background:' + (on ? 'var(--accent)' : 'var(--bg)') + '; border:2px solid ' + (on ? 'var(--accent)' : 'var(--border)') + '; border-radius:50%; padding:3px; cursor:pointer;';
      b.innerHTML = '<img src="' + (AVATAR_IMG[key] || '') + '" style="width:52px;height:52px;border-radius:50%;display:block;">';
      b.title = label;
      b.onclick = () => { avatarKey = key; avatarData = ''; renderAvatarPicker(); };
      row.appendChild(b);
    });
    // 上傳自訂頭像按鈕
    const up = document.createElement('button');
    const hasCustom = !!avatarData;
    up.style.cssText = 'background:' + (hasCustom ? 'var(--accent)' : 'var(--bg)') + '; border:2px dashed ' + (hasCustom ? 'var(--accent)' : 'var(--border)') + '; border-radius:50%; width:58px; height:58px; cursor:pointer; color:var(--muted); font-size:22px;';
    up.textContent = '⬆️';
    up.title = '上傳自訂頭像';
    up.onclick = () => $('avatarFile').click();
    row.appendChild(up);
    if (avatarData) {
      const c = document.createElement('button');
      c.style.cssText = 'background:var(--bg); border:2px solid var(--border); border-radius:50%; width:58px; height:58px; cursor:pointer; color:var(--muted); font-size:13px;';
      c.textContent = '✕';
      c.title = '清除自訂頭像';
      c.onclick = () => { avatarData = ''; localStorage.removeItem('avatarData_v1'); renderAvatarPicker(); };
      row.appendChild(c);
    }
  }
  let hostRoom = '';
  function applyNick() {
    const n = nickname;
    document.title = n ? n + '聲播日曆' : '聲播日曆';
    $('appTitle').textContent = n ? '🎁 ' + n + '聲播日曆' : '🎁 聲播日曆';
    // 廳房名獨立一行顯示（在標題下方）
    var roomEl = document.getElementById('roomBadge');
    if (!roomEl) {
      roomEl = document.createElement('div');
      roomEl.id = 'roomBadge';
      roomEl.style.cssText = 'font-size:12px;color:var(--accent2);margin-top:2px;letter-spacing:1px;';
      $('appTitle').parentNode.appendChild(roomEl);
    }
    roomEl.textContent = hostRoom ? '🏠 ' + hostRoom : '';
    roomEl.style.display = hostRoom ? 'block' : 'none';
    $('loginTitle').textContent = n ? '🔐 ' + n + '聲播日曆' : '🔐 聲播日曆';
    $('titleAvatar').src = avatarURL();
  }
  applyNick();

  $('nickOk').onclick = () => {
    const v = $('nickInput').value.trim();
    const a = $('aliasInput').value.trim();
    if (!v) { $('nickInput').focus(); return; }
    if (!a) { $('aliasInput').focus(); return; }
    nickname = v;
    alias = a;
    lsSetRaw('nick_v1', v);
    lsSetRaw('alias_v1', a);
    lsSetRaw('avatar_v1', avatarKey);
    applyNick();
    if (fbOk && currentUid) {
      const payload = { nickname: v, alias: a, avatar: avatarKey };
      if (avatarData) payload.avatarData = avatarData; else payload.avatarData = firebase.firestore.FieldValue.delete();
      db.collection('users').doc(currentUid).set(payload, { merge: true }).catch(() => {});
    }
    $('nameOverlay').style.display = 'none';
  };
  $('nickInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('aliasInput').focus(); });
  $('aliasInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('nickOk').click(); });
  $('aliasPickRow').addEventListener('click', (e) => {
    const b = e.target.closest('.alias-pick');
    if (!b) return;
    $('aliasInput').value = b.textContent.trim();
  });
  $('editNickBtn').onclick = () => {
    $('nickInput').value = nickname;
    $('aliasInput').value = alias;
    renderAvatarPicker();
    $('nameOverlay').style.display = 'flex';
    setTimeout(() => $('nickInput').focus(), 200);
  };

  function lsSetRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // 資料消毒：雲端/本機資料可能因舊版或寫入中斷而型別異常（例如 tasks 不是陣列），
  // 一筆壞資料會讓 renderCalendar 在迴圈中 throw、整個月空白。統一在此修正。
  function sanitizeStore(s) {
    const out = { dates: {}, weeks: {}, months: {}, ranges: {}, scoreLog: {}, salesLog: {}, listeners: [], settings: Object.assign({}, DEFAULT_SETTINGS) };
    if (!s || typeof s !== 'object') return out;
    const normTask = t => {
      if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
      const nt = Object.assign({}, t);
      nt.cur = Number(t.cur) || 0;
      nt.target = Math.max(1, Number(t.target) || 1);
      nt.score = Number(t.score) || 0;
      return nt;
    };
    ['dates', 'weeks', 'months'].forEach(bk => {
      const src = bk === 'weeks' ? migrateWeekKeys(s.weeks) : s[bk];
      if (!src || typeof src !== 'object' || Array.isArray(src)) return;
      Object.keys(src).forEach(k => {
        const b = src[k];
        if (!b || typeof b !== 'object' || Array.isArray(b)) return;
        const nb = { tasks: (Array.isArray(b.tasks) ? b.tasks : []).map(normTask).filter(Boolean) };
        if (b.note) nb.note = String(b.note);
        if (Array.isArray(b.slots)) nb.slots = b.slots.filter(sl => sl && typeof sl === 'object').map(sl => ({
          start: String((sl && sl.start) || ''),
          end: String((sl && sl.end) || ''),
          done: !!(sl && sl.done)
        }));
        if (b.special && typeof b.special === 'object') nb.special = { dragon: Number(b.special.dragon) || 0, castle: Number(b.special.castle) || 0 };
        out[bk][k] = nb;
      });
    });
    if (s.ranges && typeof s.ranges === 'object' && !Array.isArray(s.ranges)) {
      Object.keys(s.ranges).forEach(id => {
        const r = s.ranges[id];
        if (!r || typeof r !== 'object' || Array.isArray(r)) return;
        out.ranges[id] = {
          name: r.name ? String(r.name) : '',
          start: r.start ? String(r.start) : '',
          end: r.end ? String(r.end) : '',
          tasks: (Array.isArray(r.tasks) ? r.tasks : []).map(normTask).filter(Boolean)
        };
      });
    }
    if (s.scoreLog && typeof s.scoreLog === 'object' && !Array.isArray(s.scoreLog)) out.scoreLog = s.scoreLog;
    if (Array.isArray(s.listeners)) {
      out.listeners = s.listeners.map((l, idx) => ({
        id: String((l && l.id) || ('F-' + (idx + 1))),
        nickname: String((l && l.nickname) || ''),
        personality: String((l && l.personality) || ''),
        topic: String((l && l.topic) || ''),
        birthday: String((l && l.birthday) || ''),
        shots: Array.isArray(l && l.shots) ? l.shots.slice(0, 2).map(x => String(x || '')) : []
      })).filter(l => l.nickname || l.id);
    } else {
      out.listeners = [];
    }
    out.salesLog = (s.salesLog && typeof s.salesLog === 'object' && !Array.isArray(s.salesLog))
      ? Object.fromEntries(Object.entries(s.salesLog).filter(([k, v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)]))
      : {};
    out.settings = Object.assign({}, DEFAULT_SETTINGS, (s.settings && typeof s.settings === 'object' && !Array.isArray(s.settings)) ? s.settings : {});
    out.settings.enableDragon = out.settings.enableDragon !== false;
    out.settings.enableCastle = out.settings.enableCastle !== false;
    out.settings.giftCutoffHour = [0, 8].includes(Number(out.settings.giftCutoffHour)) ? Number(out.settings.giftCutoffHour) : 0;
    out.settings.salesCutoffHour = [0, 8].includes(Number(out.settings.salesCutoffHour)) ? Number(out.settings.salesCutoffHour) : 8;
    ['salesDayTarget', 'salesWeekTarget', 'salesMonthTarget'].forEach(k => {
      const n = Number(out.settings[k]);
      out.settings[k] = Number.isFinite(n) && n >= 0 ? n : 0;
    });
    out.settings.enableGiftTasks = out.settings.enableGiftTasks !== false;
    out.settings.enableSalesScore = out.settings.enableSalesScore !== false;
    return out;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return sanitizeStore(JSON.parse(raw));
    } catch (e) {}
    return { dates: {}, weeks: {}, months: {}, ranges: {}, scoreLog: {}, salesLog: {}, listeners: [], settings: Object.assign({}, DEFAULT_SETTINGS) };
  }
  function save() { try { logTodayScores(); } catch (e) {} try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {} scheduleCloudSave(); }

  function key(y, m, d) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function todayKey() { const n = new Date(); return key(n.getFullYear(), n.getMonth(), n.getDate()); }

  // 週邊界：禮拜日 00:00。週日 00:00 起算，到下個禮拜日 00:00 結算。
  const WEEK_SETTLE_DAY = 0;   // 0=週日
  const WEEK_SETTLE_HOUR = 0;  // 禮拜日 00:00

  function weekInfoForParts(y, m, d, hh = 12, mm = 0) {
    const at = new Date(y, m - 1, d, hh, mm, 0, 0);
    let start = new Date(y, m - 1, d, WEEK_SETTLE_HOUR, 0, 0, 0);
    let back = (start.getDay() - WEEK_SETTLE_DAY + 7) % 7;
    if (back === 0 && start.getTime() > at.getTime()) back = 7;
    start.setDate(start.getDate() - back);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start, end, key: key(start.getFullYear(), start.getMonth(), start.getDate()) };
  }

  function weekInfo(ds) {
    const [y, m, d] = ds.split('-').map(Number);
    if (ds === todayKey()) {
      const n = new Date();
      return weekInfoForParts(y, m, d, n.getHours(), n.getMinutes());
    }
    return weekInfoForParts(y, m, d, 12, 0);
  }

  function addDays(dt, n) { const x = new Date(dt); x.setDate(x.getDate() + n); return x; }
  function fmtMD(dt) { return `${dt.getMonth() + 1}/${dt.getDate()}`; }

  // 舊版週 key 是週一；遷移到禮拜日 00:00 起算的新 key
  function migrateWeekKeys(weeks) {
    const out = {};
    Object.keys(weeks || {}).forEach(k => {
      let b = weeks[k];
      if (!b || typeof b !== 'object' || Array.isArray(b)) b = { tasks: [] };
      let nk = k;
      const p = String(k).split('-').map(Number);
      if (p.length === 3 && p.every(Number.isFinite)) {
        const dt = new Date(p[0], p[1] - 1, p[2]);
        if (dt.getDay() === 1) nk = weekInfoForParts(p[0], p[1], p[2], 12, 0).key;
      }
      if (!out[nk]) out[nk] = { tasks: [] };
      const arr = Array.isArray(b.tasks) ? b.tasks : [];
      arr.forEach(t => {
        if (t && !out[nk].tasks.some(x => x && x.name === t.name)) out[nk].tasks.push(t);
      });
    });
    return out;
  }

  function scopeKey(sc, ds) {
    if (sc === 'day') return ds;
    if (sc === 'week') return weekInfo(ds).key;
    return ds.slice(0, 7); // YYYY-MM
  }


  function getTasks(sc, ds) {
    if (sc === 'custom') {
      const r = customId && store.ranges ? store.ranges[customId] : null;
      return (r && r.tasks) || [];
    }
    const k = scopeKey(sc, ds);
    const b = store[BUCKET[sc]][k];
    return (b && b.tasks) || [];
  }
  function ensureBucket(sc, ds) {
    if (sc === 'custom') {
      if (!store.ranges) store.ranges = {};
      if (!store.ranges[customId]) store.ranges[customId] = { name: '', start: '', end: '', tasks: [] };
      return store.ranges[customId];
    }
    const k = scopeKey(sc, ds);
    if (!store[BUCKET[sc]][k]) store[BUCKET[sc]][k] = { tasks: [] };
    return store[BUCKET[sc]][k];
  }
  function calc(tasks) {
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    const doneCnt = tasks.filter(t => num(t.cur, 0) >= num(t.target, 0)).length;
    const totUnits = tasks.reduce((s, t) => s + Math.max(0, num(t.target, 0)), 0);
    const doneUnits = tasks.reduce((s, t) => s + Math.min(Math.max(num(t.cur, 0), 0), Math.max(num(t.target, 0), 0)), 0);
    const scoreTotal = tasks.reduce((s, t) => s + Math.max(0, num(t.score, 0)), 0);
    const scoreEarned = tasks.reduce((s, t) => s + (num(t.cur, 0) >= num(t.target, 0) ? Math.max(0, num(t.score, 0)) : 0), 0);
    const pct = totUnits ? Math.round(doneUnits / totUnits * 100) : 0;
    return { doneCnt, total: tasks.length, totUnits, doneUnits, pct, scoreTotal, scoreEarned, allDone: tasks.length > 0 && doneCnt === tasks.length };
  }

  // 當月金龍/城堡加總
  function monthSpecial(ds) {
    const ym = ds.slice(0, 7);
    let dragon = 0, castle = 0;
    Object.keys(store.dates).forEach(k => {
      if (k.slice(0, 7) !== ym) return;
      const sp = store.dates[k].special;
      if (sp) { dragon += sp.dragon || 0; castle += sp.castle || 0; }
    });
    return { dragon, castle };
  }

  // 任務類型：bonus（舊資料 bonus:true）> easy > 每日
  function taskTypeOf(t) {
    if (t.type === 'bonus' || t.bonus === true) return 'bonus';
    if (t.type === 'easy') return 'easy';
    return 'day';
  }
  // 依類型拆得分
  function splitScores(tasks) {
    const r = { day: 0, easy: 0, bonus: 0 };
    (tasks || []).forEach(t => {
      const cur = Number(t.cur), target = Number(t.target), sc = Number(t.score);
      const s = (Number.isFinite(cur) && Number.isFinite(target) && cur >= target && Number.isFinite(sc)) ? sc : 0;
      r[taskTypeOf(t)] += s;
    });
    return r;
  }
  // 每天自動記錄分數快照（供週日複製當週明细）
  // 首頁副標：顯示目前設定的週結算時刻
  function updateHeaderSub() {
    const wt = getGiftCutoffHour() === 8 ? '08:00' : '00:00';
    const el = $('headerSub');
    if (el) el.textContent = `點日期可設定「每日 / 每週 / 每月」收禮目標・每週於禮拜日 ${wt} 結算並起算・跨結算自動歸屬・歷史完成數保留`;
  }


  function getGiftCutoffHour() {
    return Number((store.settings || {}).giftCutoffHour) === 8 ? 8 : 0;
  }
  // 禮物日：邊界設 08:00 時，0~8 點之間「今天」仍是昨天（9/10 = 9/10 08:00 ~ 9/11 08:00）
  function giftTodayKey() {
    const now = new Date();
    if (now.getHours() >= getGiftCutoffHour()) return todayKey();
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return key(y.getFullYear(), y.getMonth(), y.getDate());
  }
  function logTodayScores() {
    const tk = giftTodayKey();
    if (!store.scoreLog) store.scoreLog = {};
    const b = store.dates[tk];
    const sp = splitScores(b && b.tasks);
    const wk = calc(getTasks('week', tk)).scoreEarned;
    const mo = calc(getTasks('month', tk)).scoreEarned;
    const prev = store.scoreLog[tk] || {};
    if (prev.day === sp.day && prev.easy === sp.easy && prev.bonus === sp.bonus && prev.week === wk && prev.month === mo) return;
    store.scoreLog[tk] = { day: sp.day, easy: sp.easy, bonus: sp.bonus, week: wk, month: mo };
  }

  // 計算某週（由 ds 所在週）總開播分鐘
  function weekMinutes(ds) {
    const wi = weekInfo(ds);
    let total = 0;
    for (let dt = new Date(wi.start); dt < wi.end; dt.setDate(dt.getDate() + 1)) {
      const dk = key(dt.getFullYear(), dt.getMonth(), dt.getDate());
      const b = store.dates[dk];
      if (!b || !Array.isArray(b.slots)) continue;
      const dayStart = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, 0, 0, 0);
      const dayEnd = addDays(dayStart, 1);
      const s = Math.max(wi.start, dayStart);
      const e = Math.min(wi.end, dayEnd);
      b.slots.forEach(sl => {
        if (!sl) return;
        const [sh, sm] = String(sl.start || '00:00').split(':').map(Number);
        const [eh, em] = String(sl.end || sl.start || '00:00').split(':').map(Number);
        if (!Number.isFinite(sh) || !Number.isFinite(eh)) return;
        const st = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), sh, sm || 0);
        const en = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), eh, em || 0);
        if (en <= st) return;
        total += Math.max(0, (Math.min(en, e) - Math.max(st, s)) / 60000);
      });
    }
    return Math.round(total);
  }

  // 'HH:MM' → 分鐘數（供時段驗證、打卡提醒、ICS 換算共用）
  function toMin(t) { const p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); }


  function slotMinutes(sl) {
    if (!sl || !sl.start || !sl.end) return 0;
    const [sh, sm] = String(sl.start).split(':').map(Number);
    const [eh, em] = String(sl.end).split(':').map(Number);
    if (!Number.isFinite(sh) || !Number.isFinite(eh)) return 0;
    const st = new Date(2000, 0, 1, sh, sm || 0);
    const en = new Date(2000, 0, 1, eh, em || 0);
    if (en <= st) return 0;
    return Math.round((en - st) / 60000);
  }
  function doneMinutesForMonth(ym) {
    let total = 0;
    Object.keys(store.dates || {}).forEach(dk => {
      if (!String(dk).startsWith(ym)) return;
      const b = store.dates[dk];
      if (!b || !Array.isArray(b.slots)) return;
      b.slots.forEach(sl => { if (sl && sl.done) total += slotMinutes(sl); });
    });
    return total;
  }
  function fmtHrsMins(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return h + ' 小時' + (m ? ' ' + m + ' 分' : '');
  }


  // ---------- 業績分數（每天 08:00 起算，到隔天 08:00） ----------
  function getSalesCutoffHour() {
    const n = Number((store.settings || {}).salesCutoffHour);
    return n === 0 ? 0 : 8;
  }
  function salesDayKeyFromDate(d) {
    const x = new Date(d);
    if (x.getHours() < getSalesCutoffHour()) x.setDate(x.getDate() - 1);
    return key(x.getFullYear(), x.getMonth(), x.getDate());
  }
  function salesDayKey(ds) {
    // 歷史日期一律視為該日業績日
    if (ds && ds !== todayKey()) return ds;
    return salesDayKeyFromDate(new Date());
  }
  function salesWeekKey(ds) {
    const d = new Date(String(salesDayKey(ds)).replace(/-/g, '/'));
    d.setHours(12, 0, 0, 0);
    const start = new Date(d);
    start.setDate(d.getDate() - d.getDay()); // 週日
    start.setHours(getSalesCutoffHour(), 0, 0, 0);
    return key(start.getFullYear(), start.getMonth(), start.getDate());
  }
  function salesMonthKey(ds) {
    return salesDayKey(ds).slice(0, 7);
  }
  function salesEarned(scope, ds) {
    const log = store.salesLog || {};
    if (scope === 'day') return Number(log[salesDayKey(ds)] || 0);
    if (scope === 'week') {
      const wk = salesWeekKey(ds);
      return Object.keys(log).filter(dk => salesWeekKey(dk) === wk).reduce((a, k) => a + (Number(log[k]) || 0), 0);
    }
    const mk = salesMonthKey(ds);
    return Object.keys(log).filter(dk => salesMonthKey(dk) === mk).reduce((a, k) => a + (Number(log[k]) || 0), 0);
  }
  function addSalesScore(points) {
    const n = Math.max(0, parseInt(points, 10) || 0);
    if (!n) { toast('請輸入大於 0 的分數'); return; }
    if (!store.salesLog || typeof store.salesLog !== 'object') store.salesLog = {};
    const dk = salesDayKey(openDate);
    store.salesLog[dk] = (Number(store.salesLog[dk]) || 0) + n;
    save(); renderSheet(); renderCalendar(); toast(`已新增業績分數 +${n}`);
  }


  // ---------- 趨勢圖 ----------
  function isLastDayOfMonth(ds) {
    const [y, m, d] = ds.split('-').map(Number);
    const next = new Date(y, m, 0);
    return d === next.getDate();
  }
  function isSaturday(ds) {
    const [y, m, d] = ds.split('-').map(Number);
    return new Date(y, m - 1, d).getDay() === 6;
  }
  function taskScoreForDay(ds) {
    const b = store.dates && store.dates[ds];
    const tasks = b && Array.isArray(b.tasks) ? b.tasks : [];
    return tasks.reduce((a, t) => {
      const cur = Number(t.cur), target = Number(t.target), sc = Number(t.score);
      const u = (Number.isFinite(cur) && Number.isFinite(target)) ? Math.min(Math.max(cur, 0), Math.max(target, 0)) : 0;
      return a + u * (Number.isFinite(sc) ? sc : 0);
    }, 0);
  }
  function salesScoreForDay(ds) {
    const log = store.salesLog || {};
    return Object.keys(log).filter(k => salesDayKey(k) === ds).reduce((a, k) => a + (Number(log[k]) || 0), 0);
  }
  function drawTrend(canvas, labels, salesData, taskData, title, mode) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#191924'; ctx.fillRect(0, 0, W, H);
    const padL = 92, padR = 28, padT = 34, padB = 56;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const useSales = mode !== 'tasks';
    const useTasks = mode !== 'sales';
    const shownSales = useSales ? salesData : [];
    const shownTasks = useTasks ? taskData : [];
    const maxVal = Math.max(10, ...shownSales, ...shownTasks);
    const niceMax = Math.ceil(maxVal / 100) * 100 || 100;
    ctx.strokeStyle = '#2e2e40'; ctx.lineWidth = 1;
    ctx.fillStyle = '#8b8b9e'; ctx.font = '16px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH - (plotH * i / 4);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(String(Math.round(niceMax * i / 4)), padL - 10, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const step = Math.max(1, Math.ceil(labels.length / 10));
    labels.forEach((lab, i) => {
      if (i % step !== 0 && i !== labels.length - 1) return;
      const x = padL + (plotW * i / Math.max(1, labels.length - 1));
      ctx.fillText(lab, x, H - padB + 12);
    });
    const series = [];
    if (useSales) series.push({ data: salesData, color: '#f6ad55', name: '業績分數' });
    if (useTasks) series.push({ data: taskData, color: '#63b3ed', name: '任務目標收禮分數' });
    series.forEach(s => {
      ctx.strokeStyle = s.color; ctx.lineWidth = 3; ctx.beginPath();
      s.data.forEach((v, i) => {
        const x = padL + (plotW * i / Math.max(1, s.data.length - 1));
        const y = padT + plotH - (plotH * (v / niceMax));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      s.data.forEach((v, i) => {
        const x = padL + (plotW * i / Math.max(1, s.data.length - 1));
        const y = padT + plotH - (plotH * (v / niceMax));
        ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      });
    });
    let lx = padL; const ly = 16;
    series.forEach(s => {
      ctx.fillStyle = s.color; ctx.fillRect(lx, ly, 18, 18);
      ctx.fillStyle = '#e8e8f0'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = '18px sans-serif';
      ctx.fillText(s.name, lx + 26, ly + 9);
      lx += 140;
    });
    $('trendTitle').textContent = title;
  }
  let trendMode = 'sales';
  function openTrend(scopeType) {
    if (!openDate) return;
    window.__trendPeriod = scopeType; // 供分享功能判斷本週/本月
    const settings = store.settings || {};
    const showSales = settings.enableSalesScore !== false;
    const showTasks = settings.enableGiftTasks !== false;
    if (!showSales && !showTasks) { toast('請先在設定啟用業績分數或禮物任務'); return; }
    if (!showSales) trendMode = 'tasks';
    if (!showTasks) trendMode = 'sales';
    $('tabTrendSales').classList.toggle('active', trendMode === 'sales');
    $('tabTrendTasks').classList.toggle('active', trendMode === 'tasks');
    $('tabTrendSales').style.display = showSales ? '' : 'none';
    $('tabTrendTasks').style.display = showTasks ? '' : 'none';
    const [y, m] = openDate.split('-').map(Number);
    let labels = [], sales = [], tasks = [];
    if (scopeType === 'week') {
      const wi = weekInfo(openDate);
      for (let i = 0; i < 7; i++) {
        const dt = new Date(wi.start); dt.setDate(wi.start.getDate() + i);
        const dk = key(dt.getFullYear(), dt.getMonth(), dt.getDate());
        labels.push(`${dt.getMonth() + 1}/${dt.getDate()}`);
        sales.push(salesScoreForDay(dk));
        tasks.push(taskScoreForDay(dk));
      }
      drawTrend($('trendCanvas'), labels, sales, tasks, `📈 本週趨勢圖（${fmtMD(wi.start)}–${fmtMD(wi.end)}）`, trendMode);
    } else {
      const days = new Date(y, m, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const dk = key(y, m - 1, d);
        labels.push(String(d));
        sales.push(salesScoreForDay(dk));
        tasks.push(taskScoreForDay(dk));
      }
      drawTrend($('trendCanvas'), labels, sales, tasks, `📈 本月趨勢圖（${y}-${String(m).padStart(2, '0')}）`, trendMode);
    }
    $('trendOverlay').classList.add('open');
  }

  // ---------- 月曆 ----------
  function renderCalendar() {
    // v42 保險：某些裝置/資料狀態下 viewYear/viewMonth 可能被污染，先轉回合法值，避免整個月不畫
    const now0 = new Date();
    let y0 = Number(viewYear);
    let m0 = Number(viewMonth);
    if (!Number.isFinite(y0) || y0 < 1900 || y0 > 2200) y0 = now0.getFullYear();
    if (!Number.isInteger(m0) || m0 < 0 || m0 > 11) m0 = now0.getMonth();
    viewYear = y0;
    viewMonth = m0;

    $('monthTitle').textContent = `${viewYear} 年 ${viewMonth + 1} 月`;
    const grid = $('calGrid');
    grid.innerHTML = '';
    CAL_WEEK.forEach(w => {
      const h = document.createElement('div');
      h.className = 'cal-head'; h.textContent = w;
      grid.appendChild(h);
    });

    const monthStart = new Date(viewYear, viewMonth, 1);
    const first = Number.isNaN(monthStart.getTime()) ? 0 : monthStart.getDay(); // 週日開頭
    let daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    if (!Number.isFinite(daysInMonth) || daysInMonth < 28 || daysInMonth > 31) {
      const fallbackDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      daysInMonth = fallbackDays[viewMonth] || 30;
      const isLeap = ((viewYear % 4 === 0 && viewYear % 100 !== 0) || viewYear % 400 === 0);
      if (viewMonth === 1 && isLeap) daysInMonth = 29;
    }
    const tKey = giftTodayKey(); // 禮物日：0~8 點之間「今天」是昨天

    for (let i = 0; i < first; i++) {
      const c = document.createElement('div');
      c.className = 'cell other';
      grid.appendChild(c);
    }

    let statFull = 0, statPart = 0;

    let firstCalErr = '';
    const noteCalErr = (err) => {
      const msg = String((err && err.message) || err || '未知錯誤').replace(/\s+/g, ' ').slice(0, 80);
      if (!firstCalErr) firstCalErr = msg;
      console.error('renderCalendar 單日渲染失敗', err);
    };

    for (let d = 1; d <= daysInMonth; d++) {
      const ds = key(viewYear, viewMonth, d);

      // 先建立最基本日期格：即使後面資料壞掉，也不能讓整個月消失
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.innerHTML = `<div class="dnum">${d}</div>`;
      cell.onclick = () => openDay(ds);

      try {
        const tasks = getTasks('day', ds);
        const r = calc(tasks);

        if (ds === tKey) cell.classList.add('today');
        if (r.allDone) { cell.classList.add('all-done'); statFull++; }
        else if (r.doneUnits > 0) { cell.classList.add('partial'); statPart++; }

        let inner = `<div class="dnum">${d}</div>`;

        const stB = store.dates && typeof store.dates === 'object' ? store.dates[ds] : null;
        if (stB && Array.isArray(stB.slots) && stB.slots.length) {
          const slotTxt = stB.slots
            .map(sl => (sl ? String(sl.start || '') + (sl.end ? '–' + String(sl.end || '') : '') : ''))
            .filter(Boolean)
            .join(' ');
          if (slotTxt) inner += `<div class="badge">${slotTxt}</div>`;
        }

        // 首頁日曆不顯示每日任務個數 / 收禮進度，只保留特殊統計與週月 badge

        // 首頁日曆只顯示開播時間，不顯示週月任務 / 區間統計

        cell.innerHTML = inner;
      } catch (err) {
        noteCalErr(err);
      }

      grid.appendChild(cell);
    }

    $('statFull').textContent = statFull;
    $('statPart').textContent = statPart;
    const wr = calc(getTasks('week', tKey));
    $('statWeek').textContent = wr.total ? `${wr.doneCnt}/${wr.total}` : '–';
    const mr = calc(getTasks('month', tKey));
    $('statMonth').textContent = mr.total ? `${mr.doneCnt}/${mr.total}` : '–';

    const dayCellCount = grid.querySelectorAll('.cell:not(.other)').length;
    $('verTag').textContent = dayCellCount > 0 ? ('v' + APP_VERSION + (firstCalErr ? ' · ' + firstCalErr : '')) : 'v' + APP_VERSION + ' · 日曆異常';
  }

  // ---------- 日面板 ----------
  function openDay(ds) {
    openDate = ds;
    scope = 'day';
    renderSheet();
    $('overlay').classList.add('open');
    setTimeout(() => $('nameInput').focus(), 250);
    checkTemplateVersion();
  }
  function closeSheet() {
    openDate = null;
    $('overlay').classList.remove('open');
    renderCalendar();
  }

  function renderTabs() {
    const tabs = $('tabs');
    tabs.innerHTML = '';
    [['day', '每日'], ['week', '每週'], ['month', '每月'], ['custom', '自訂']].forEach(([sc, label]) => {
      const r = calc(getTasks(sc, openDate));
      const b = document.createElement('button');
      b.className = 'tab' + (scope === sc ? ' active' : '');
      b.innerHTML = `${label}<span class="t-sub">${r.total ? r.doneCnt + '/' + r.total + ' 任務' : '無目標'}</span>`;
      b.onclick = () => { scope = sc; renderSheet(); };
      tabs.appendChild(b);
    });
  }

  function renderSheet() {
    if (!openDate) return;
    const [y, m, d] = openDate.split('-').map(Number);
    const tKey = giftTodayKey(); // 禮物日：0~8 點之間「今天」是昨天

    if (scope === 'day') {
      const week = WEEK[new Date(y, m - 1, d).getDay()];
      const rel = openDate === tKey ? '・今天' : (openDate < tKey ? '・已結算' : '・未來');
      $('sheetTitle').textContent = `${m} 月 ${d} 日（週${week}）${rel}`;
    } else if (scope === 'week') {
      const wi = weekInfo(openDate);
      const cur = scopeKey('week', tKey), mine = scopeKey('week', openDate);
      const rel = mine === cur ? '・本週' : (mine < cur ? '・已結算' : '・未來');
      const _wt = getGiftCutoffHour() === 8 ? '08:00' : '00:00';
      $('sheetTitle').textContent = `本週 ${fmtMD(wi.start)} ${_wt} – ${fmtMD(wi.end)} ${_wt}${rel}`;
    } else if (scope === 'custom') {
      const r = customId && store.ranges ? store.ranges[customId] : null;
      $('sheetTitle').textContent = r ? `${r.name}（${r.start}～${r.end}）` : '自訂任務區間';
    } else {
      const cur = tKey.slice(0, 7), mine = openDate.slice(0, 7);
      const rel = mine === cur ? '・本月' : (mine < cur ? '・已結算' : '・未來');
      $('sheetTitle').textContent = `${y} 年 ${m} 月${rel}`;
    }

    renderTabs();

    // 自訂區間列
    const customBar = $('customBar');
    if (scope === 'custom') {
      customBar.style.display = 'block';
      if (!store.ranges) store.ranges = {};
      const ids = Object.keys(store.ranges);
      if (!customId || !store.ranges[customId]) customId = ids[0] || null;
      let bar = '<div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;">';
      ids.forEach(id => {
        const rg = store.ranges[id];
        const rc = calc(rg.tasks || []);
        const on = id === customId;
        bar += `<button class="rng-chip" data-id="${id}" style="background:${on ? 'var(--accent)' : 'var(--card)'}; color:${on ? '#14141c' : 'var(--muted)'}; border:1px solid var(--border); border-radius:99px; padding:6px 12px; font-size:13px; cursor:pointer; font-family:inherit;">${rg.name}（${rg.start}～${rg.end}）${rc.doneCnt}/${rc.total}</button>`;
      });
      bar += '<button id="rngAdd" style="background:none; border:1px dashed var(--border); color:var(--muted); border-radius:99px; padding:6px 12px; font-size:13px; cursor:pointer; font-family:inherit;">＋ 新增區間</button></div>';
      if (showCreateRange) {
        bar += `<div style="background:var(--card); border:1px solid var(--border); border-radius:12px; padding:12px; margin-bottom:10px;">
          <input id="rngName" type="text" placeholder="區間名稱（例如：中秋活動）" style="width:100%; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--text); padding:10px; font-size:14px; outline:none; margin-bottom:8px; font-family:inherit;">
          <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center;">
            <input id="rngStart" type="date" style="flex:1; min-width:0; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--text); padding:10px; font-size:14px; outline:none; color-scheme:dark; font-family:inherit;">
            <span style="color:var(--muted);">～</span>
            <input id="rngEnd" type="date" style="flex:1; min-width:0; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--text); padding:10px; font-size:14px; outline:none; color-scheme:dark; font-family:inherit;">
          </div>
          <button id="rngCreate" class="btn btn-primary" style="width:100%; padding:10px; font-size:14px;">建立區間</button>
        </div>`;
      }
      customBar.innerHTML = bar;
    } else {
      customBar.style.display = 'none';
    }

    $('weekCopyBtn').style.display = (scope === 'day' && isSaturday(openDate)) ? 'block' : 'none';
    $('weekStatsBtn').style.display = (scope === 'day' && isSaturday(openDate)) ? 'block' : 'none';
    renderWeekStats(scope === 'day' && isSaturday(openDate));
    $('hoursBox').style.display = (scope === 'day' && isSaturday(openDate)) ? 'block' : 'none';
    // 簡／加碼只用在每日任務；切到週／月任務時隱藏並清掉勾選，避免殘留誤觸發
    $('easyBonusRow').style.display = scope === 'day' ? 'flex' : 'none';
    if (scope !== 'day') { $('easyChk').checked = false; $('bonusChk').checked = false; }
    const stSettings = store.settings || {};
    const showDragon = stSettings.enableDragon !== false;
    const showCastle = stSettings.enableCastle !== false;
    $('dragonRow').style.display = showDragon ? '' : 'none';
    $('castleRow').style.display = showCastle ? '' : 'none';
    $('specialBox').style.display = (scope === 'day' && (showDragon || showCastle)) ? 'block' : 'none';
    const trendVisible = stSettings.enableGiftTasks !== false || stSettings.enableSalesScore !== false;
    $('trendWeekBtn').style.display = (scope === 'day' && isSaturday(openDate) && trendVisible) ? 'block' : 'none';
    $('trendMonthBtn').style.display = (scope === 'day' && isLastDayOfMonth(openDate) && trendVisible) ? 'block' : 'none';
    if (scope === 'day' && isSaturday(openDate)) {
      // 週六（每週最後一天）顯示「當週」時數，滿 1 小時才 +5
      const curWi = weekInfo(openDate);
      const curKey = key(curWi.start.getFullYear(), curWi.start.getMonth(), curWi.start.getDate());
      const mins = weekMinutes(curKey);
      const fullHrs = Math.floor(mins / 60);
      const leftover = mins % 60;
      const pts = fullHrs * 5;
      $('hoursAuto').textContent = '當週 ' + fullHrs + ' 小時' + (leftover ? ' ' + leftover + ' 分（不滿 1 小時不算）' : '') + ' → +' + pts + ' 分';
    }
    const settings = store.settings || { enableGiftTasks: true, enableSalesScore: false, salesDayTarget: 0, salesWeekTarget: 0, salesMonthTarget: 0 };
    const tasks = settings.enableGiftTasks ? getTasks(scope, openDate) : [];
    const r = calc(tasks);
    let status;
    if (!tasks.length) status = '尚未新增目標';
    else if (r.allDone) status = `<span class="ok">🎉 全部達成</span>`;
    else if (r.doneUnits > 0) status = `<span class="mid">部分達成</span>`;
    else status = '進行中';

    const giftCut = Number((store.settings || {}).giftCutoffHour) === 8 ? 8 : 0;
    const giftCutTxt = giftCut === 0 ? '午夜 12 點（00:00）' : '08:00';
    const weekCutTxt = giftCut === 0 ? '00:00' : '08:00';
    // 首頁副標同步顯示週結算時間
    updateHeaderSub();
    const notes = {
      day: `每日於 ${giftCutTxt} 重新結算，新的一天從 0 重新開始。每週於禮拜日 ${weekCutTxt} 結算並起算。`,
      week: `每週從禮拜日 ${weekCutTxt} 開始，下個禮拜日 ${weekCutTxt} 自動結算並保留紀錄。`,
      month: '每月 1 號自動結算上月並重新計算。',
      custom: '自訂區間：進度累計到結束日，結束後保留為紀錄。'
    };
    const ms = monthSpecial(openDate);
    let weekLine = '';
    if (scope === 'day') {
      const [yy, mm, dd] = openDate.split('-').map(Number);
      const wi = weekInfo(openDate);
      let wkEarn = 0, wkTot = 0;
      Object.keys(store.dates || {}).sort().forEach(dk => {
        if (weekInfo(dk).key !== wi.key) return;
        const b = store.dates[dk];
        if (b && Array.isArray(b.tasks)) {
          const rc = calc(b.tasks);
          wkEarn += rc.scoreEarned; wkTot += rc.scoreTotal;
        }
      });
      weekLine = ''; // 依需求移除：任務達成 / 收禮進度 / 分數 / 結算週期每日分數
      weekLine += `・ 當月 🐉x<b>${ms.dragon}</b> 🏰x<b>${ms.castle}</b>`;
    }
    const doneMin = doneMinutesForMonth(openDate.slice(0, 7));
    const hoursLine = scope === 'day' ? ` ・ 當月已完成時數 <b>${fmtHrsMins(doneMin)}</b>` : '';
    let salesLine = '';
    if (settings.enableSalesScore) {
      const earned = salesEarned(scope, openDate);
      const target = scope === 'day' ? (settings.salesDayTarget || 0)
        : scope === 'week' ? (settings.salesWeekTarget || 0)
        : scope === 'month' ? (settings.salesMonthTarget || 0) : 0;
      salesLine = target > 0 ? ` ・ 業績分數 <b>${earned}/${target}</b>（尚缺 ${Math.max(0, target - earned)}）` : '';
      const box = $('salesInlineBox');
      if (box) {
        box.style.display = '';
        $('salesInlineLine').innerHTML = `業績分數：<b>${earned}/${target || 0}</b>（尚缺 ${Math.max(0, (target || 0) - earned)}）`;
        $('salesAddInput').value = '';
        const scopeTag = scope === 'day' ? '每日' : scope === 'week' ? '每週' : scope === 'month' ? '每月' : '自訂';
        $('salesTargetScope').textContent = '（' + scopeTag + '）';
        const tIn = $('salesTargetInput');
        if (tIn && document.activeElement !== tIn) tIn.value = target || '';
      }
    } else if ($('salesInlineBox')) {
      $('salesInlineBox').style.display = 'none';
    }
    const summaryBody = `${weekLine}${hoursLine}${salesLine}`;
    $('daySummary').innerHTML = summaryBody ? `${summaryBody}<br>${notes[scope]}` : `${notes[scope]}`;

    const labels = {
      day: ['📋 複製前一天任務', '🗑 清空這天'],
      week: ['📋 複製上一週', '🗑 清空本週'],
      month: ['📋 複製上一月', '🗑 清空本月'],
      custom: ['📋 複製區間（不支援）', '🗑 刪除這個區間']
    };
    $('copyPrevBtn').textContent = labels[scope][0];
    $('clearDayBtn').textContent = labels[scope][1];

    // 每日趣事（僅每日分頁顯示）
    const noteBox = $('noteBox');
    const spBox = $('specialBox');
    if (scope === 'day') {
      $('timeBox').style.display = 'block';
      const tb = ensureBucket('day', openDate);
      if (!tb.slots && tb.startTime) {
        tb.slots = [{ start: tb.startTime, end: tb.endTime || '' }];
        delete tb.startTime; delete tb.endTime; save();
      }
      const slots = tb.slots || [];
      const slotList = $('slotList');
      slotList.innerHTML = '';
      slots.forEach((sl, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:8px;';
        row.innerHTML = `
          <input type="checkbox" class="slot-done" data-slot="${i}" ${sl.done ? 'checked' : ''} title="已完成開播" aria-label="已完成開播">
          <input type="time" class="slot-start" data-slot="${i}" value="${sl.start || ''}" style="flex:1; min-width:0; background:var(--card); border:1px solid var(--border); border-radius:10px; color:var(--text); padding:12px; font-size:16px; font-family:inherit; outline:none; color-scheme:dark;">
          <span style="color:var(--muted); font-size:14px;">～</span>
          <input type="time" class="slot-end" data-slot="${i}" value="${sl.end || ''}" style="flex:1; min-width:0; background:var(--card); border:1px solid var(--border); border-radius:10px; color:var(--text); padding:12px; font-size:16px; font-family:inherit; outline:none; color-scheme:dark;">
          <button class="slot-del" data-slot="${i}" title="刪除時段" style="background:none; border:none; color:var(--muted); font-size:15px; cursor:pointer; padding:4px 6px;">✕</button>`;
        slotList.appendChild(row);
      });
      noteBox.style.display = 'block';
      $('noteInput').value = (store.dates[openDate] && store.dates[openDate].note) || '';
      // 幸運開出統計
      spBox.style.display = 'block';
      const sp = (store.dates[openDate] && store.dates[openDate].special) || { dragon: 0, castle: 0 };
      spBox.querySelectorAll('.sp-count').forEach(el => { el.textContent = sp[el.dataset.k] || 0; });
      const msNow = monthSpecial(openDate);
      const dEl = spBox.querySelector('[data-k="dragon"]').previousElementSibling;
      const cEl = spBox.querySelector('[data-k="castle"]').previousElementSibling;
      if (dEl) dEl.innerHTML = '🐉 金龍 <span style="font-size:11px;color:var(--muted);font-weight:400;">當月x' + msNow.dragon + '</span>';
      if (cEl) cEl.innerHTML = '🏰 城堡 <span style="font-size:11px;color:var(--muted);font-weight:400;">當月x' + msNow.castle + '</span>';
    } else {
      $('timeBox').style.display = 'none';
      noteBox.style.display = 'none';
      spBox.style.display = 'none';
    }

    const list = $('taskList');
    list.innerHTML = '';
    if (!settings.enableGiftTasks) {
      list.innerHTML = '<div class="empty">已停用禮物任務</div>';
      return;
    }
    if (!tasks.length) {
      list.innerHTML = '<div class="empty">還沒有目標<br>在上方輸入「項目」「數量」「分數」開始新增</div>';
      return;
    }
    tasks.forEach((t, idx) => {
      const isDone = t.cur >= t.target;
      const tpct = Math.round(Math.min(t.cur, t.target) / t.target * 100);
      const div = document.createElement('div');
      div.className = 'task' + (isDone ? ' done' : '');
      div.innerHTML = `
        <div class="task-top">
          <button class="drag-handle" data-idx="${idx}" title="拖曳排序" style="background:none; border:none; color:var(--muted); cursor:grab; padding:10px 8px 10px 0; font-size:15px; letter-spacing:1px; touch-action:none; flex-shrink:0;">☰</button>
          <span class="task-name" data-idx="${idx}" title="編輯任務" style="cursor:pointer;"></span>
          <button class="task-edit-btn" data-idx="${idx}" title="編輯此任務">✏️</button>
          <div class="qty-ctrl">
            <button class="minus" data-idx="${idx}" title="少一個">−</button>
            <input type="number" min="0" value="${t.cur}" data-idx="${idx}" aria-label="完成數量">
            <button class="plus" data-idx="${idx}" title="收到一個，+1">+1</button>
          </div>
          <button class="task-del" data-idx="${idx}" title="刪除">✕</button>
        </div>
        <div class="task-meta">目標 ${t.target} 個 ・ 已收 ${t.cur} 個（${tpct}%）・ 尚缺 ${Math.max(0, t.target - t.cur)} 個・ ${t.score || 0} 分${isDone ? ' ・ ✅ 達成' : ''}</div>
        <div class="task-bar"><div class="task-fill" style="width:${tpct}%"></div></div>
      `;
      const nameEl = div.querySelector('.task-name');
      nameEl.textContent = '';
      const effIcon = (t.icon && t.icon !== 'none') ? t.icon : '';
      const iconSrc = effIcon ? (GIFT_IMG[effIcon] || '') : '';
      if (iconSrc) {
        const giftImg = document.createElement('img');
        giftImg.src = iconSrc;
        giftImg.alt = '';
        giftImg.draggable = false;
        giftImg.style.cssText = 'width:22px;height:22px;border-radius:50%;margin-right:8px;object-fit:cover;vertical-align:middle;flex-shrink:0;pointer-events:none;-webkit-user-drag:none;user-select:none;';
        let giftIconFailed = false;
        giftImg.onerror = () => {
          if (giftIconFailed) return;
          giftIconFailed = true;
          giftImg.remove();
          const em = document.createElement('span');
          em.textContent = (GIFT_EMOJI[effIcon] || '🎁') + ' ';
          em.style.cssText = 'font-size:16px;margin-right:6px;vertical-align:middle;flex-shrink:0;';
          nameEl.insertBefore(em, nameEl.firstChild);
        };
        nameEl.appendChild(giftImg);
      }
      nameEl.appendChild(document.createTextNode(t.name));
      const tt = taskTypeOf(t);
      if (tt !== 'day') {
        const bTag = document.createElement('span');
        bTag.textContent = tt === 'bonus' ? '🔥加碼' : '✨簡易';
        bTag.style.cssText = 'font-size:10px; color:' + (tt === 'bonus' ? 'var(--accent2)' : 'var(--green)') + '; border:1px solid currentColor; border-radius:99px; padding:1px 7px; margin-left:8px; vertical-align:middle; white-space:nowrap;';
        nameEl.appendChild(bTag);
      }
      list.appendChild(div);
    });
  }

  // 任務操作（事件委派）
  let plusPressTimer = null;
  let plusLongFired = false;
  $('taskList').addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('button.plus');
    if (!btn || !openDate) return;
    plusLongFired = false;
    clearTimeout(plusPressTimer);
    plusPressTimer = setTimeout(() => {
      plusLongFired = true;
      const idx = Number(btn.dataset.idx);
      const tasks = getTasks(scope, openDate);
      if (!tasks[idx]) return;
      const raw = prompt(`「${tasks[idx].name}」要增加多少個？`, '1');
      if (raw === null) return;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0 || n > 9999) { toast('請輸入 0～9999 的數字'); return; }
      tasks[idx].cur += n;
      if (tasks[idx].cur > 9999) tasks[idx].cur = 9999;
      if (tasks[idx].cur >= tasks[idx].target) toast(`🎉 「${tasks[idx].name}」收滿！`);
      save(); renderSheet();
    }, 650);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => {
    $('taskList').addEventListener(ev, () => clearTimeout(plusPressTimer));
  });
  // 任務全欄位編輯狀態
  let editingTaskIdx = null;
  let editingTaskScope = null;
  let editingTaskDate = null;
  function resetAddForm() {
    $('nameInput').value = '';
    $('qtyInput').value = '1';
    $('ptsInput').value = '';
    refreshDefaultPts();
    $('iconSelect').value = 'none';
    $('easyChk').checked = false;
    $('bonusChk').checked = false;
    $('addBtn').textContent = '新增';
    $('addBtn').style.visibility = '';
    const er = $('taskEditRow');
    if (er) er.style.display = 'none';
    [...$('taskList').children].forEach(el => el.classList.remove('editing'));
    const _ar2 = document.getElementById('taskEditZone');
    if (_ar2) _ar2.classList.remove('editing');
  }
  function ensureTaskEditRow() {
    let row = $('taskEditRow');
    if (!row) {
      row = document.createElement('div');
      row.id = 'taskEditRow';
      row.style.cssText = 'display:none;justify-content:flex-end;gap:10px;margin:0 0 12px;';
      const cb = document.createElement('button');
      cb.className = 'btn btn-ghost';
      cb.textContent = '取消編輯';
      cb.style.cssText = 'padding:12px 16px;white-space:nowrap;';
      cb.onclick = () => { cancelEditTask(); };
      row.appendChild(cb);
      const sv = document.createElement('button');
      sv.className = 'btn btn-primary';
      sv.textContent = '💾 儲存';
      sv.style.cssText = 'padding:12px 16px;white-space:nowrap;';
      sv.onclick = () => { $('addBtn').click(); }; // 代理：觸發原新增鈕（內含編輯邏輯）
      row.appendChild(sv);
      const addRow = document.querySelector('.add-row');
      addRow.parentNode.insertBefore(row, addRow.nextSibling);
    }
    return row;
  }
  function cancelEditTask() {
    editingTaskIdx = null;
    resetAddForm();
  }
  function startEditTask(idx) {
    const tasks = getTasks(scope, openDate);
    const t = tasks[idx];
    if (!t) return;
    if (editingTaskIdx === idx && editingTaskScope === scope && editingTaskDate === openDate) {
      cancelEditTask();
      return; // 再點同任務＝取消編輯
    }
    editingTaskIdx = idx;
    editingTaskScope = scope;
    editingTaskDate = openDate;
    $('nameInput').value = t.name;
    $('qtyInput').value = t.target;
    $('ptsInput').value = t.score || 0;
    $('iconSelect').value = t.icon || 'none';
    const tt = taskTypeOf(t);
    $('easyChk').checked = tt === 'easy';
    $('bonusChk').checked = tt === 'bonus';
    $('addBtn').textContent = '💾 儲存';
    $('addBtn').style.visibility = 'hidden'; // 留在原地佔位，保持上方欄位標籤對齊
    [...$('taskList').children].forEach(el => el.classList.remove('editing'));
    const _tel = $('taskList').children[idx];
    if (_tel) _tel.classList.add('editing');
    const _ar = document.getElementById('taskEditZone');
    if (_ar) _ar.classList.add('editing');
    const _er = ensureTaskEditRow();
    _er.style.display = 'flex';
    const row = document.querySelector('.add-row');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }
  $('taskList').addEventListener('click', (e) => {
    if (!openDate) return;
    // 點任務名稱 → 全欄位編輯
    const nameEl = e.target.closest('.task-name');
    if (nameEl && !e.target.closest('button')) {
      startEditTask(Number(nameEl.dataset.idx));
      return;
    }
    const editBtn = e.target.closest('.task-edit-btn');
    if (editBtn) { startEditTask(Number(editBtn.dataset.idx)); return; }
    const btn = e.target.closest('button');
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    const tasks = getTasks(scope, openDate);
    if (!tasks[idx]) return;
    if (btn.classList.contains('plus')) {
      if (plusLongFired) { plusLongFired = false; return; }
      tasks[idx].cur++;
      if (tasks[idx].cur === tasks[idx].target) toast(`🎉 「${tasks[idx].name}」收滿！`);
    } else if (btn.classList.contains('minus')) {
      tasks[idx].cur = Math.max(0, tasks[idx].cur - 1);
    } else if (btn.classList.contains('task-del')) {
      if (!confirm(`刪除「${tasks[idx].name}」？`)) return;
      tasks.splice(idx, 1);
    } else return;
    save(); renderSheet();
  });
  $('taskList').addEventListener('change', (e) => {
    const input = e.target.closest('input[type="number"]');
    if (!input || !openDate) return;
    const idx = Number(input.dataset.idx);
    const tasks = getTasks(scope, openDate);
    if (!tasks[idx]) return;
    let v = parseInt(input.value, 10);
    if (isNaN(v) || v < 0) v = 0;
    tasks[idx].cur = Math.min(v, 9999);
    save(); renderSheet();
  });

  // 拖曳排序（滑鼠＋觸控，透過 ☰ handle）
  let dragCtx = null;
  $('taskList').addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || !openDate) return;
    const tasks = getTasks(scope, openDate);
    const idx = Number(handle.dataset.idx);
    if (!tasks[idx]) return;
    dragCtx = { idx, el: handle.closest('.task'), startX: e.clientX, startY: e.clientY, active: false };
  });
  document.addEventListener('pointermove', (e) => {
    if (!dragCtx) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) {
      dragCtx.el.classList.remove('dragging');
      document.body.style.userSelect = '';
      dragCtx = null;
      renderSheet();
      return;
    }
    if (!dragCtx.active) {
      if (Math.abs(e.clientY - dragCtx.startY) < 8 && Math.abs(e.clientX - dragCtx.startX) < 8) return;
      dragCtx.active = true;
      dragCtx.el.classList.add('dragging');
      document.body.style.userSelect = 'none';
    }
    e.preventDefault();
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const overTask = over && over.closest ? over.closest('.task') : null;
    const list = $('taskList');
    if (overTask && overTask !== dragCtx.el && overTask.parentNode === list) {
      const rect = overTask.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      list.insertBefore(dragCtx.el, before ? overTask : overTask.nextSibling);
    }
  });
  document.addEventListener('pointerup', () => {
    if (!dragCtx) return;
    const ctx = dragCtx;
    dragCtx = null;
    document.body.style.userSelect = '';
    if (!ctx.active) return;
    ctx.el.classList.remove('dragging');
    const tasks = getTasks(scope, openDate);
    if (!tasks || !tasks.length) return;
    const newOrder = Array.from($('taskList').children).map(el => {
      const h = el.querySelector('.drag-handle');
      return h ? tasks[Number(h.dataset.idx)] : null;
    });
    if (newOrder.length !== tasks.length || newOrder.some(t => !t)) { renderSheet(); return; }
    if (newOrder.every((t, i) => t === tasks[i])) return;
    tasks.splice(0, tasks.length, ...newOrder);
    save();
    renderSheet();
    toast('已更新順序');
  });
  document.addEventListener('pointercancel', () => {
    if (!dragCtx) return;
    dragCtx.el.classList.remove('dragging');
    document.body.style.userSelect = '';
    dragCtx = null;
    renderSheet();
  });

  // 新增
  function defaultDayScore() {
    if ($('easyChk').checked) return 5;
    if ($('bonusChk').checked) return 100;
    return 10;
  }
  function refreshDefaultPts() {
    if (scope === 'day') $('ptsInput').value = defaultDayScore();
  }

  function addTasks() {
    if (!openDate) return;
    const name = $('nameInput').value.trim();
    if (!name) { $('nameInput').focus(); return; }
    if (scope === 'custom' && !customId) { toast('請先建立或選擇區間'); return; }
    const qty = parseInt($('qtyInput').value, 10);
    const target = (isNaN(qty) || qty < 1) ? 1 : qty;
    if (scope === 'day') $('ptsInput').value = defaultDayScore();
    const pts = parseInt($('ptsInput').value, 10);
    const score = (isNaN(pts) || pts < 0) ? 0 : pts;
    const tasks = ensureBucket(scope, openDate).tasks;
    if (tasks.some((t, i) => t.name === name && i !== editingTaskIdx)) { toast('這個項目已存在'); return; }
    const iconSel = $('iconSelect').value;
    // 簡／加碼只用在每日任務，週／月任務一律當普通任務
    const isEasy = scope === 'day' && $('easyChk').checked, isBonus = scope === 'day' && $('bonusChk').checked;
    if (isEasy && isBonus) { toast('「簡」和「加」請擇一勾選'); return; }
    const taskType = isBonus ? 'bonus' : (isEasy ? 'easy' : '');
    // 編輯模式：更新既有任務全欄位（cur 完成數保留）
    if (editingTaskIdx !== null) {
      if (editingTaskScope !== scope || editingTaskDate !== openDate) {
        cancelEditTask();
        toast('編輯目標已變更，請重新點選任務');
        return;
      }
      const et = tasks[editingTaskIdx];
      if (!et) { cancelEditTask(); return; }
      if (tasks.some((x, i2) => x.name === name && i2 !== editingTaskIdx)) { toast('這個項目已存在'); return; }
      et.name = name;
      et.target = target;
      et.score = score;
      et.icon = iconSel || '';
      if (taskType) et.type = taskType; else delete et.type;
      editingTaskIdx = null;
      save();
      resetAddForm();
      renderSheet();
      toast(`已更新「${name}」`);
      return;
    }
    const newTask = { name, target, cur: 0, score, icon: iconSel || '' };
    if (taskType) newTask.type = taskType;
    tasks.push(newTask);
    save();
    $('nameInput').value = '';
    $('qtyInput').value = '1';
    refreshDefaultPts();
    $('iconSelect').value = 'none';
    $('easyChk').checked = false;
    $('bonusChk').checked = false;
    renderSheet();
    $('nameInput').focus();
    toast(`已新增「${name}」x ${target}（${score} 分）`);
  }
  $('easyChk').addEventListener('change', () => { if ($('easyChk').checked) $('bonusChk').checked = false; refreshDefaultPts(); });
  $('bonusChk').addEventListener('change', () => { if ($('bonusChk').checked) $('easyChk').checked = false; refreshDefaultPts(); });
  refreshDefaultPts();
  $('addBtn').onclick = addTasks;
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTasks(); });
  $('qtyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTasks(); });
  $('ptsInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTasks(); });
  $('noteInput').addEventListener('input', () => {
    if (!openDate) return;
    ensureBucket('day', openDate).note = $('noteInput').value;
    save();
  });
  $('slotList').addEventListener('change', (e) => {
    if (!openDate) return;
    const b = ensureBucket('day', openDate);
    if (!b.slots) return;
    const i = Number(e.target.dataset.slot);
    if (!b.slots[i]) return;
    if (e.target.classList.contains('slot-done')) {
      b.slots[i].done = e.target.checked;
      save();
      renderCalendar();
      renderSheet();
      return;
    }
    if (e.target.classList.contains('slot-start')) b.slots[i].start = e.target.value;
    else if (e.target.classList.contains('slot-end')) b.slots[i].end = e.target.value;
    else return;
    const sl = b.slots[i];
    if (sl.start && sl.end) {
      if (toMin(sl.end) === toMin(sl.start)) { toast('結束時間不能等於開始時間'); renderSheet(); return; }
      if (toMin(sl.end) < toMin(sl.start)) { toast('結束時間不能早於開始時間'); renderSheet(); return; }
    }
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (err) {}
    save();
    renderCalendar();
  });
  $('slotList').addEventListener('click', (e) => {
    const btn = e.target.closest('.slot-del');
    if (!btn || !openDate) return;
    const b = ensureBucket('day', openDate);
    if (!b.slots) return;
    b.slots.splice(Number(btn.dataset.slot), 1);
    if (!b.slots.length) delete b.slots;
    save(); renderSheet(); renderCalendar();
  });
  // ===== 行事曆匯出（方案 C：到點由 iPhone 系統推播）=====
  function exportICS() {
    if (!openDate) return;
    const b = store.dates[openDate];
    const slots = (b && b.slots) || [];
    const valid = slots.filter(s => s && s.start && s.end);
    if (!valid.length) { toast('這天還沒設定開播時段'); return; }
    const [yy, mm, dd] = openDate.split('-').map(Number);
    const pad = (n) => String(n).padStart(2, '0');
    const icsDate = (t) => `${yy}${pad(mm)}${pad(dd)}T${String(t).replace(':', '')}00`;
    const escIcs = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,');
    const nick = (function(){ try { return localStorage.getItem('nick_v1') || ''; } catch(e){ return ''; } })();
    const title = '🎙️ 開播提醒' + (nick ? '・' + nick : '');
    let vevents = '';
    valid.forEach((s, i) => {
      // 開播前 5 分鐘提醒；下播前 5 分鐘提醒。
      // VALARM 的 TRIGGER 只能相對「事件開始」觸發，所以用「時長 - 5 分鐘」換算，
      // 讓第二個鬧鈴剛好落在 DTEND 前 5 分鐘（舊版兩個鬧鈴都設 -PT5M，下播提醒實際上會跟開播提醒同時響）。
      const durMin = toMin(s.end) - toMin(s.start);
      vevents += 'BEGIN:VEVENT\r\n'
        + 'UID:' + openDate + '-' + i + '@voicehost\r\n'
        + 'DTSTAMP:' + icsDate(s.start) + '\r\n'
        + 'DTSTART:' + icsDate(s.start) + '\r\n'
        + 'DTEND:' + icsDate(s.end) + '\r\n'
        + 'SUMMARY:' + escIcs(title) + '\r\n'
        + 'BEGIN:VALARM\r\n'
        + 'TRIGGER:-PT5M\r\n'
        + 'ACTION:DISPLAY\r\n'
        + 'DESCRIPTION:' + escIcs('🎙️ 開播前 5 分鐘' + (nick ? '・' + nick : '')) + '\r\n'
        + 'END:VALARM\r\n'
        + (durMin > 5
          ? 'BEGIN:VALARM\r\nTRIGGER:-PT' + (durMin - 5) + 'M\r\nACTION:DISPLAY\r\nDESCRIPTION:' + escIcs('⏰ 下播前 5 分鐘・準備打卡') + '\r\nEND:VALARM\r\n'
          : '')
        + 'END:VEVENT\r\n';
    });
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//VoiceHost//EN\r\nCALSCALE:GREGORIAN\r\n' + vevents + 'END:VCALENDAR\r\n';
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'voicehost-' + openDate + '.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('已下載行事曆檔，點它即可加入提醒');
  }
  $('exportCalendarBtn').onclick = exportICS;
  $('addSlotBtn').onclick = () => {
    if (!openDate) return;
    const b = ensureBucket('day', openDate);
    if (!b.slots) b.slots = [];
    const nowH = new Date().getHours();
    const startH = String(nowH).padStart(2, '0');
    const endH = String((nowH + 1) % 24).padStart(2, '0');
    b.slots.push({ start: startH + ':00', end: endH + ':00' });
    save(); renderSheet();
  };
  $('clearTimeBtn').onclick = () => {
    if (!openDate) return;
    const b = ensureBucket('day', openDate);
    delete b.slots;
    save(); renderSheet(); renderCalendar();
  };
  $('specialBox').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !openDate) return;
    const k = btn.dataset.k;
    const b = ensureBucket('day', openDate);
    if (!b.special) b.special = { dragon: 0, castle: 0 };
    if (btn.classList.contains('sp-plus')) b.special[k] = (b.special[k] || 0) + 1;
    else if (btn.classList.contains('sp-minus')) b.special[k] = Math.max(0, (b.special[k] || 0) - 1);
    else return;
    save(); renderSheet();
  });

  // 複製上一期
  $('copyPrevBtn').onclick = () => {
    if (!openDate) return;
    if (scope === 'custom') { toast('自訂區間不支援複製'); return; }
    const [y, m, d] = openDate.split('-').map(Number);
    let prevKey;
    if (scope === 'day') {
      const p = new Date(y, m - 1, d - 1);
      prevKey = key(p.getFullYear(), p.getMonth(), p.getDate());
    } else if (scope === 'week') {
      const prev = addDays(weekInfo(openDate).start, -7);
      prevKey = key(prev.getFullYear(), prev.getMonth(), prev.getDate());
    } else {
      const p = new Date(y, m - 1, 1); p.setMonth(p.getMonth() - 1);
      prevKey = `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}`;
    }
    const bucket = store[BUCKET[scope]][prevKey];
    const prevTasks = (bucket && bucket.tasks) || [];
    if (!prevTasks.length) { toast('上一期沒有目標可以複製'); return; }
    const tasks = ensureBucket(scope, openDate).tasks;
    let added = 0;
    for (const t of prevTasks) {
      if (!tasks.some(x => x.name === t.name)) { tasks.push({ ...t, cur: 0 }); added++; }
    }
    save(); renderSheet();
    toast(added > 0 ? `已複製 ${added} 個目標（進度歸零）` : '目標都已存在');
  };

  // 同步範本任務：把後台管理員建立的任務範本，一次帶入「今天」的日／週／月任務清單，不用自己輸入
  // 範本依廳房分開存（不分日期），每天都能重複同步同一份；已存在的項目（同名）不會重複加入
  function templateRoomKey() { return hostRoom || '未知'; }
  function tplSyncedVerKey() { return 'tplSyncedVer_v1_' + templateRoomKey(); }
  // 檢查後台範本有沒有更新過（版本號比對），有的話在同步按鈕旁顯示 NEW 角標
  function checkTemplateVersion() {
    if (!fbOk || !db) return;
    db.collection('templates').doc(templateRoomKey()).get().then(snap => {
      const remoteVer = (snap.exists && Number(snap.data().version)) || 0;
      let localVer = 0;
      try { localVer = Number(localStorage.getItem(tplSyncedVerKey()) || '0'); } catch (e) {}
      const badge = $('syncTemplateNewBadge');
      if (badge) badge.style.display = (remoteVer > localVer) ? 'inline-block' : 'none';
    }).catch(() => {});
  }
  // 把範本任務清單合併進某個任務陣列：同名的直接跳過（不覆蓋、不動已收數量），回傳新增數量
  function mergeTemplateInto(tasks, src) {
    let added = 0;
    (Array.isArray(src) ? src : []).forEach(t => {
      if (!t || !t.name) return;
      if (tasks.some(x => x.name === t.name)) return;
      const newTask = { name: t.name, target: t.target, cur: 0, score: t.score, icon: t.icon || '' };
      if (t.type) newTask.type = t.type;
      tasks.push(newTask);
      added++;
    });
    return added;
  }
  function syncTemplateTasks() {
    if (!openDate) return;
    if (!fbOk || !db) { toast('雲端未連線，無法同步'); return; }
    toast('同步中…');
    db.collection('templates').doc(templateRoomKey()).get().then(snap => {
      const tpl = snap.exists ? (snap.data() || {}) : {};
      const remoteVer = Number(tpl.version) || 0;
      const ds = openDate;
      const counts = { day: 0, week: 0, month: 0 };
      ['day', 'week', 'month'].forEach(sc => {
        counts[sc] = mergeTemplateInto(ensureBucket(sc, ds).tasks, tpl[sc]);
      });
      // 自訂區間任務：只有主播「當下正開著某個自訂區間」才一併帶入，沒有選區間就沒地方放
      let customMsg = '';
      if (scope === 'custom' && customId) {
        counts.custom = mergeTemplateInto(ensureBucket('custom', ds).tasks, tpl.custom);
        customMsg = `・自訂 ${counts.custom} 個`;
      }
      // 不管這次有沒有新任務被加入，都算「已經看過這個版本」，NEW 角標消掉
      try { localStorage.setItem(tplSyncedVerKey(), String(remoteVer)); } catch (e) {}
      const badge = $('syncTemplateNewBadge');
      if (badge) badge.style.display = 'none';
      const total = counts.day + counts.week + counts.month + (counts.custom || 0);
      if (!total) { toast('沒有新任務可同步（已存在或範本是空的）'); return; }
      save();
      renderCalendar();
      if (openDate) renderSheet();
      toast(`已同步：日 ${counts.day} 個・週 ${counts.week} 個・月 ${counts.month} 個${customMsg}`);
    }).catch(err => {
      toast('同步失敗：' + (err && err.message ? err.message : err));
    });
  }

  // 複製完成/未完成清單：只複製「目前 scope」，每日頁就只複製每日，每週/每月同理
  $('copyListBtn').onclick = () => {
    if (!openDate) return;
    const cleanName = n => String(n)
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{FE0F}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    const label = t => cleanName(t.name) + (taskTypeOf(t) === 'bonus' ? '（加碼）' : '');
    const tasks = getTasks(scope, openDate);
    if (!tasks.length) { toast('這個範圍還沒有目標'); return; }

    let scopeLabel = '每日';
    if (scope === 'week') {
      const wi = weekInfo(openDate);
      scopeLabel = `每週（${fmtMD(wi.start)}–${fmtMD(wi.end)}）`;
    } else if (scope === 'month') {
      scopeLabel = `每月（${openDate.slice(0, 7)}）`;
    } else if (scope === 'custom') {
      scopeLabel = '自訂';
    }

    const done = tasks.filter(t => t.cur >= t.target);
    const undone = tasks.filter(t => t.cur < t.target);
    const lines = [
      `【${openDate}・${scopeLabel}】${done.length} 已完成 / ${undone.length} 未完成`
    ];
    done.forEach(t => lines.push(`${label(t)} ${t.cur}/${t.target} ${alias || '💛'}`));
    undone.forEach(t => lines.push(`${label(t)} ${t.cur}/${t.target}`));

    const text = lines.join('\n');
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已複製到剪貼簿'); }
      catch (err) { alert(text); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('已複製到剪貼簿')).catch(fallback);
    } else fallback();
  };

  $('clearDayBtn').onclick = () => {
    if (!openDate) return;
    if (scope === 'custom') {
      if (!customId || !store.ranges || !store.ranges[customId]) return;
      if (confirm('確定刪除區間「' + store.ranges[customId].name + '」和所有任務？')) {
        delete store.ranges[customId];
        customId = null;
        save(); renderSheet(); renderCalendar(); toast('已刪除區間');
      }
      return;
    }
    const names = { day: '每日', week: '每週', month: '每月' };
    if (confirm(`確定清空${names[scope]}任務清單嗎？（不會清開播時間 / 趣事 / 幸運統計）`)) {
      const bucket = store[BUCKET[scope]];
      const key = scopeKey(scope, openDate);
      const b = bucket[key] || {};
      b.tasks = [];
      bucket[key] = b;
      save(); renderSheet(); renderCalendar(); toast('已清空任務清單');
    }
  };

  $('customBar').addEventListener('click', (e) => {
    const chip = e.target.closest('.rng-chip');
    if (chip) { customId = chip.dataset.id; renderSheet(); return; }
    if (e.target.closest('#rngAdd')) { showCreateRange = !showCreateRange; renderSheet(); return; }
    if (e.target.closest('#rngCreate')) {
      const name = $('rngName').value.trim();
      const st = $('rngStart').value, en = $('rngEnd').value;
      if (!name || !st || !en) { toast('名稱和起訖日期都要填'); return; }
      if (en < st) { toast('結束日期不能早於開始日期'); return; }
      const id = 'r' + Date.now();
      store.ranges[id] = { name: name, start: st, end: en, tasks: [] };
      customId = id; showCreateRange = false;
      save(); renderSheet(); renderCalendar();
      toast('已建立區間「' + name + '」');
    }
  });

  $('closeSheet').onclick = closeSheet;
  $('overlay').addEventListener('click', (e) => { if (e.target === $('overlay')) closeSheet(); });
  document.addEventListener('keydown', (e) => {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('overlay').classList.contains('open')) closeSheet();
    if ($('topicOverlay').classList.contains('open')) $('topicOverlay').classList.remove('open');
    if ($('songOverlay').classList.contains('open')) $('songOverlay').classList.remove('open');
  });
  });

  // ---------- 熱門話題（近 10 日累計排行）----------
  $('topicBtn').onclick = () => {
    $('topicOverlay').classList.add('open');
    $('topicSummary').innerHTML = '查看台灣 Google 搜尋趨勢；點下方按鈕開啟官方頁面，或輸入關鍵字直接探索。';
    const list = $('topicList');
    list.innerHTML = `
      <div class="add-row" style="margin-bottom:14px;">
        <input id="gtrendKeyword" type="text" placeholder="輸入關鍵字，例如：演唱會 / 颱風 / iPhone" autocomplete="off" style="flex:1;min-width:0;">
        <button class="btn btn-primary" id="gtrendSearch">搜尋趨勢</button>
      </div>
      <button class="btn btn-ghost btn-block gt-open" data-url="https://trends.google.com/trends/trendingsearches/daily?geo=TW">📅 每日搜尋趨勢（台灣）</button>
      <button class="btn btn-ghost btn-block gt-open" data-url="https://trends.google.com/trends/trendingsearches/realtime?geo=TW&category=all">⚡ 即時搜尋趨勢（台灣）</button>
      <button class="btn btn-ghost btn-block gt-open" data-url="https://trends.google.com/trends/explore?geo=TW">🔎 探索搜尋趨勢</button>
      <button class="btn btn-ghost btn-block gt-open" data-url="https://trends.google.com/trends/trendingsearches/daily?geo=HK">🇭🇰 香港每日趨勢</button>
      <button class="btn btn-ghost btn-block gt-open" data-url="https://trends.google.com/trends/trendingsearches/daily?geo=MY">🇲🇾 馬來西亞每日趨勢</button>
      <div class="day-summary" style="margin-top:12px;">提示：若手機內建瀏覽器擋 Google 頁面，會改用外部瀏覽器開啟。</div>
    `;
    const openUrl = (url) => window.open(url, '_blank', 'noopener');
    list.querySelectorAll('.gt-open').forEach(b => b.addEventListener('click', () => openUrl(b.dataset.url)));
    $('gtrendSearch').addEventListener('click', () => {
      const kw = $('gtrendKeyword').value.trim();
      openUrl(kw ? `https://trends.google.com/trends/explore?q=${encodeURIComponent(kw)}&geo=TW` : 'https://trends.google.com/trends/explore?geo=TW');
    });
    $('gtrendKeyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gtrendSearch').click(); });
  };
  $('closeTopic').onclick = () => $('topicOverlay').classList.remove('open');
  $('topicOverlay').addEventListener('click', (e) => { if (e.target === $('topicOverlay')) $('topicOverlay').classList.remove('open'); });

  const now = new Date();
  viewYear = now.getFullYear(); viewMonth = now.getMonth();
  $('prevMonth').onclick = () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } renderCalendar(); };
  $('nextMonth').onclick = () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } renderCalendar(); };
  $('todayBtn').onclick = () => {
    const n = new Date();
    viewYear = n.getFullYear(); viewMonth = n.getMonth();
    renderCalendar();
    openDay(todayKey());
  };

  function $(id) { return document.getElementById(id); }
  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }


  // ---------- 流行華語歌曲（iTunes 台灣即時排行，每次按都抓最新）----------
  const SONG_FALLBACK = [
    ['愛人錯過', '告五人'], ['如果可以', '韋禮安'], ['小情歌', '蘇打綠'],
    ['身騎白馬', '徐佳瑩'], ['有一種悲傷', 'A-Lin'], ['以後別做朋友', '周興哲'],
    ['光年之外', 'G.E.M. 鄧紫棋'], ['修煉愛情', '林俊傑'], ['倒帶', '蔡依林'],
    ['突然好想你', '五月天'], ['魚仔', '盧廣仲'], ['小幸運', '田馥甄'],
    ['成全', '林宥嘉'], ['說謊', '林宥嘉'], ['晴天', '周杰倫'], ['七里香', '周杰倫'],
    ['遇見', '孫燕姿'], ['那些你很冒險的夢', '林俊傑'], ['聽海', '張惠妹'], ['演員', '薛之謙']
  ];
  $('songBtn').onclick = async () => {
    $('songOverlay').classList.add('open');
    const list = $('songList');
    list.innerHTML = '<div class="empty">即時抓取最新排行中…</div>';
    $('songSummary').textContent = '';

    const ytSearch = q => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
    const render = (songs, srcText) => {
      $('songSummary').innerHTML = srcText;
      list.innerHTML = '';
      songs.forEach((s, i) => {
        const div = document.createElement('a');
        div.className = 'task';
        div.href = s.url;
        div.target = '_blank';
        div.rel = 'noopener';
        div.style.textDecoration = 'none';
        div.style.display = 'block';
        const name = document.createElement('span');
        name.className = 'task-name';
        name.textContent = `${i + 1}. ${s.title}`;
        const tag = document.createElement('span');
        tag.className = 'task-meta';
        tag.textContent = s.tag;
        const row = document.createElement('div');
        row.className = 'task-top';
        row.appendChild(name); row.appendChild(tag);
        div.appendChild(row);
        const meta = document.createElement('div');
        meta.className = 'task-meta';
        meta.textContent = s.artist;
        div.appendChild(meta);
        list.appendChild(div);
      });
    };

    try {
      const res = await fetch('https://itunes.apple.com/tw/rss/topsongs/limit=25/json', { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      const entries = (data.feed && data.feed.entry) || [];
      if (!entries.length) throw new Error('empty');
      const songs = entries.map(en => {
        const title = (en['im:name'] && en['im:name'].label) || '';
        const artist = (en['im:artist'] && en['im:artist'].label) || '';
        const isMando = /[一-鿿]/.test(title + artist);
        return { title, artist, url: ytSearch(title + ' ' + artist), tag: isMando ? '🎤 華語' : '🌐 非華語' };
      });
      const mandos = songs.filter(x => x.tag === '🎤 華語');
      const others = songs.filter(x => x.tag !== '🎤 華語');
      render([...mandos, ...others].slice(0, 20),
        'iTunes 台灣即時排行・已優先列出華語歌曲・點歌連到 YouTube・<a href="https://music.apple.com/tw/browse" target="_blank" rel="noopener">榜單來源：Apple Music</a>');
      return;
    } catch (err) {}
    // 連不上時給常備歌單，按鈕永遠有東西看
    render(SONG_FALLBACK.map(([t, a]) => ({ title: t, artist: a, url: ytSearch(t + ' ' + a), tag: '🎤 華語' })),
      '暫時連不上即時排行，先給你常備歌單（稍後再按一次就會即時更新）');
  };
  $('closeSong').onclick = () => $('songOverlay').classList.remove('open');
  $('songOverlay').addEventListener('click', (e) => { if (e.target === $('songOverlay')) $('songOverlay').classList.remove('open'); });

  // ---------- 直播音效庫（WebAudio 合成，無外部音檔） ----------
  let audioCtx = null, masterGain = null;
  let sfxVolume = Math.max(0, Math.min(100, parseInt(localStorage.getItem('sfxVolume') || '80', 10) || 80));
  const SFX = [
    { id: 'applause', label: '👏 掌聲', file: '../sfx/applause.mp3', fallback: 'applause' },
    { id: 'celebrate', label: '🎉 歡呼慶祝', file: '../sfx/celebrate.mp3', fallback: 'fanfare' },
    { id: 'airhorn', label: '📣 氣氛喇叭', file: '../sfx/airhorn.mp3', fallback: 'airhorn' },
    { id: 'cash', label: '💰 收款', file: '../sfx/cash.mp3', fallback: 'coin' },
    { id: 'drumroll', label: '🥁 鼓動人心', file: '../sfx/drumroll.mp3', fallback: 'drum' },
    { id: 'ding', label: '✨ 叮咚', file: '../sfx/ding.mp3', fallback: 'ding' },
    { id: 'win', label: '🏆 勝利', file: '../sfx/win.mp3', fallback: 'fanfare' },
    { id: 'fail', label: '😵 糗了', file: '../sfx/fail.mp3', fallback: 'fail' },
    { id: 'scratch', label: '📀 尷尬刮碟', file: '../sfx/scratch.mp3', fallback: 'whoosh' },
    { id: 'clap', label: '👏 高爾夫鼓掌', file: '../sfx/clap.mp3', fallback: 'applause' },
    { id: 'thanks', label: '🙏 觀眾感謝', file: '../sfx/thanks.mp3', fallback: 'fanfare' },
    { id: 'laugh', label: '😂 觀眾笑聲', file: '../sfx/laugh.mp3', fallback: 'surprise' },
    { id: 'gasp', label: '😮 驚訝倒抽氣', file: '../sfx/gasp.mp3', fallback: 'surprise' },
    { id: 'crickets', label: '🦗 冷場蟋蟀', file: '../sfx/crickets.mp3', fallback: 'fail' },
    { id: 'timpani', label: '🎬 緊張定音鼓', file: '../sfx/timpani.mp3', fallback: 'drum' },
    { id: 'shush', label: '🤫 安靜噓聲', file: '../sfx/shush.mp3', fallback: 'ding' }
  ];
  function ensureAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!audioCtx) {
      audioCtx = new AC();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = sfxVolume / 100;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return true;
  }
  // iOS/Safari：AudioContext 只能在使用者手勢內建立並 resume，
  // 全域掛手勢監聽預先解鎖，避免 PWA/主畫面模式第一次點按被靜音
  ['touchstart', 'touchend', 'click'].forEach(function (ev) {
    document.addEventListener(ev, function () { try { ensureAudio(); } catch (e) {} }, { passive: true });
  });
  // 音訊狀態燈每秒刷新（不被後段 script 的按鈕覆蓋影響）
  window.__sfxStateTimer = setInterval(function () { try { updateSfxState(); } catch (e) {} }, 1000);
  function setSfxVolume(v) {
    sfxVolume = Math.max(0, Math.min(100, Number.isFinite(v) ? v : 80));
    syncSfxVolumeToAudios();
    localStorage.setItem('sfxVolume', String(sfxVolume));
    const _volL = $('sfxVolLabel'); if (_volL) _volL.textContent = sfxVolume + '%';
    const _volR = $('sfxVolume'); if (_volR) _volR.value = sfxVolume;
  }
  function syncSfxVolumeToAudios() {
    if (masterGain) masterGain.gain.value = sfxVolume / 100;
  }
  function tone(freq, dur, type = 'sine', vol = 0.25, when = 0, slide = 0) {
    if (!ensureAudio()) return;
    const t = audioCtx.currentTime + when;
    const o = audioCtx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(1, slide), t + dur);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(masterGain);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(dur = 0.4, vol = 0.2, type = 'bandpass', freq = 1200, when = 0) {
    if (!ensureAudio()) return;
    const t = audioCtx.currentTime + when;
    const len = Math.max(1, Math.floor(audioCtx.sampleRate * dur));
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = audioCtx.createBufferSource(); src.buffer = buf;
    const f = audioCtx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(masterGain);
    src.start(t);
  }
  const SFX_PLAYERS = {
    applause() { noise(0.9, 0.35, 'bandpass', 1600); noise(0.6, 0.18, 'highpass', 2500, 0.08); },
    ding() { tone(880, .18, 'sine', .25); tone(1318, .28, 'sine', .18, .08); },
    airhorn() { [220, 277, 330].forEach((f, i) => tone(f, .55, 'sawtooth', .16, i * .02)); },
    drum() { tone(120, .25, 'sine', .45, 0, 45); noise(.08, .18, 'lowpass', 900); },
    coin() { tone(988, .12, 'square', .18); tone(1319, .22, 'square', .16, .07); },
    whoosh() { noise(.55, .28, 'lowpass', 700); },
    fanfare() { [523, 659, 784, 1047].forEach((f, i) => tone(f, .22, 'triangle', .22, i * .09)); },
    fail() { tone(320, .25, 'sawtooth', .22, 0, 180); tone(180, .4, 'sawtooth', .18, .18, 90); },
    surprise() { [660, 880, 660, 990].forEach((f, i) => tone(f, .12, 'square', .16, i * .06)); },
    countdown() { tone(600, .12, 'sine', .22); tone(600, .12, 'sine', .22, .28); tone(900, .3, 'sine', .25, .56); }
  };
  const activeSources = [];
  function stopAllSfx() {
    activeSources.forEach(src => { try { src.onended = null; src.stop(0); } catch (e) {} });
    activeSources.length = 0;
    (window.__htmlAudios || []).forEach(a => { try { a.pause(); } catch (e) {} });
    window.__htmlAudios = [];
  }
  function updateSfxState() {
    const el = $('sfxStateDot');
    if (!el) return;
    if (window.__sfxLastMode === 'htmlaudio') { el.textContent = '音訊:直接播放'; el.style.color = 'var(--green)'; return; }
    if (!audioCtx) { el.textContent = '音訊:未初始化'; el.style.color = 'var(--muted)'; return; }
    const map = {
      running: ['音訊:正常', 'var(--green)'],
      suspended: ['音訊:被靜音(點一下畫面)', 'var(--accent2)'],
      closed: ['音訊:關閉', 'var(--red)'],
      interrupted: ['音訊:中斷', 'var(--red)']
    };
    const m = map[audioCtx.state] || ['音訊:' + audioCtx.state, 'var(--muted)'];
    el.textContent = m[0]; el.style.color = m[1];
  }
  window.updateSfxState = updateSfxState;
  function isIOSDevice() {
    return /iP(hone|ad|od)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  }
  function playViaHtmlAudio(file) {
    try {
      const a = new Audio(file); // file 本身已含 sfx/ 前綴
      a.volume = sfxVolume / 100;
      if (!window.__htmlAudios) window.__htmlAudios = [];
      window.__htmlAudios.push(a);
      a.addEventListener('ended', () => {
        window.__htmlAudios = (window.__htmlAudios || []).filter(x => x !== a);
      });
      const p = a.play();
      window.__sfxLastMode = 'htmlaudio';
      if (p && p.catch) p.catch(() => { if (window.__sfxLastMode === 'htmlaudio') window.__sfxLastMode = ''; });
      updateSfxState();
      return true;
    } catch (e) { return false; }
  }
  async function playSfxFile(file) {
    // 全平台一律先走 WebAudio（音量滑桿經 masterGain 控制，iOS 上 HTMLAudio 的 volume 無法程式控制）
    if (!ensureAudio()) return playViaHtmlAudio(file); // 無 WebAudio → HTMLAudio
    // ctx suspended 時等 resume 完成再播
    if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (e) {} }
    // 解鎖失敗 → 改用 HTMLAudio 備援
    if (audioCtx.state !== 'running') {
      if (playViaHtmlAudio(file)) return true;
    }
    window.__sfxLastMode = 'webaudio';
    try {
      const res = await fetch(file, { cache: 'no-store' });
      if (!res.ok) return false;
      const buf = await res.arrayBuffer();
      const audioBuf = await audioCtx.decodeAudioData(buf);
      const srcNode = audioCtx.createBufferSource();
      srcNode.buffer = audioBuf;
      srcNode.connect(masterGain);
      activeSources.push(srcNode);
      srcNode.onended = () => {
        const i = activeSources.indexOf(srcNode);
        if (i >= 0) activeSources.splice(i, 1);
      };
      srcNode.start(0);
      return true;
    } catch (e) {
      return false;
    }
  }
  function playSfx(s) {
    syncSfxVolumeToAudios();
    if (s.file) {
      playSfxFile(s.file).then(ok => {
        if (!ok) {
          const fb = s.fallback || s.id;
          if (SFX_PLAYERS[fb]) SFX_PLAYERS[fb]();
        }
      });
      return;
    }
    const fb = s.fallback || s.id;
    if (SFX_PLAYERS[fb]) SFX_PLAYERS[fb]();
  }
  function renderSfx() {
    const list = $('sfxList');
    list.innerHTML = '';
    SFX.forEach(s => {
      const b = document.createElement('button');
      b.className = 'sfx-item';
      b.textContent = s.label;
      b.onclick = () => {
        try { playSfx(s); }
        catch (err) {
          const fb = s.fallback || s.id;
          if (SFX_PLAYERS[fb]) SFX_PLAYERS[fb]();
        }
      };
      list.appendChild(b);
    });
  }
  function openSfxLibrary() {
    try {
      ensureAudio();
      renderSfx();
      openOverlay('sfxOverlay');
    } catch (e) {
      toast('音效庫開啟失敗');
    }
  }
  function closeSfxLibrary() {
    $('sfxOverlay').classList.remove('open');
  }
  function bindSfx() {
    setSfxVolume(sfxVolume);
    renderSfx();
    $('sfxOverlay').addEventListener('click', (e) => { if (e.target === $('sfxOverlay')) closeSfxLibrary(); });
  }
  bindSfx();


  // ---------- 開播 / 下播打卡提醒 ----------
  const REMIND_KEY = 'voiceHostRemind_v1';
  function loadReminded() { try { return JSON.parse(localStorage.getItem(REMIND_KEY) || '{}'); } catch (e) { return {}; } }
  function saveReminded(r) { try { localStorage.setItem(REMIND_KEY, JSON.stringify(r)); } catch (e) {} }
  const reminded = loadReminded();

  function fireRemind(title, body) {
    $('remindTitle').textContent = title;
    $('remindBody').textContent = body;
    $('remindOverlay').classList.add('open');
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body });
      }
    } catch (e) {}
  }
  $('remindOk').onclick = () => $('remindOverlay').classList.remove('open');
  $('remindOverlay').addEventListener('click', (e) => { if (e.target === $('remindOverlay')) $('remindOverlay').classList.remove('open'); });

  function checkReminders() {
    const now = new Date();
    const tk = todayKey();
    const b = store.dates[tk];
    if (!b || !b.slots || !b.slots.length) return;
    const cur = now.getHours() * 60 + now.getMinutes();
    const flags = reminded[tk] || (reminded[tk] = []);
    b.slots.forEach((sl, i) => {
      const f = flags[i] || (flags[i] = {});
      // 剛開播：開播後 5 分鐘內提醒（過窗不補彈）
      if (sl.start && !f.start && cur >= toMin(sl.start) && cur < toMin(sl.start) + 5) {
        f.start = true; saveReminded(reminded);
        fireRemind('🎙️ 開播打卡', '第 ' + (i + 1) + ' 場剛開播，記得打卡！');
      }
      // 下播前 5 分鐘：只在 end-5 ～ end 之間提醒（下播後不補彈）
      if (sl.end && !f.end && cur >= toMin(sl.end) - 5 && cur < toMin(sl.end)) {
        f.end = true; saveReminded(reminded);
        fireRemind('🎙️ 下播打卡', '第 ' + (i + 1) + ' 場再 5 分鐘下播，記得打卡！');
      }
    });
  }
  setInterval(checkReminders, 15000);
  setTimeout(checkReminders, 2000);


  // ---------- 分享圖卡 ----------
  let lastCardBlob = null;

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function makeFanCard(f, cb) {
    const W = 1080, H = 1350;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    const FONT = "'PingFang TC', 'Noto Sans TC', sans-serif";
    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#1c1c2b'); g.addColorStop(1, '#14141c');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    const x0 = 60, y0 = 60, x1 = W - 60, y1 = H - 60, r = 40;
    c.beginPath();
    c.moveTo(x0 + r, y0);
    c.arcTo(x1, y0, x1, y1, r);
    c.arcTo(x1, y1, x0, y1, r);
    c.arcTo(x0, y1, x0, y0, r);
    c.arcTo(x0, y0, x1, y0, r);
    c.closePath();
    c.fillStyle = '#1e1e2a'; c.fill();
    c.strokeStyle = '#b794f6'; c.lineWidth = 4; c.stroke();
    c.textAlign = 'center';
    c.fillStyle = '#e8e8f0';
    c.font = 'bold 56px ' + FONT;
    c.fillText((f.nickname || '聽眾') + ' 的聽眾卡 🎁', W / 2, 170);
    c.fillStyle = '#8b8b9e';
    c.font = '30px ' + FONT;
    c.fillText('🎁 聲播日曆', W / 2, 220);
    c.textAlign = 'left';
    let y = 320;
    c.fillStyle = '#b794f6';
    c.font = 'bold 62px ' + FONT;
    c.fillText(f.nickname || '', 130, y);
    y += 74;
    c.fillStyle = '#e8e8f0';
    c.font = '32px ' + FONT;
    [f.id ? 'ID：' + f.id : null,
     f.personality ? '個性：' + f.personality : null,
     f.birthday ? '生日：' + f.birthday : null,
     f.topic ? '最近話題：' + f.topic : null].filter(Boolean).forEach(t => { c.fillText(t, 130, y); y += 56; });
    const shots = (f.shots || []).slice(0, 2);
    const finish = (imgs) => {
      imgs.forEach((im, i) => { if (im) c.drawImage(im, 130 + i * 430, y + 16, 400, 400); });
      cb(cv);
    };
    if (!shots.length) { finish([]); return; }
    let loaded = 0; const imgs = [];
    shots.forEach((src, i) => {
      const im = new Image();
      im.onload = () => { imgs[i] = im; if (++loaded === shots.length) finish(imgs); };
      im.onerror = () => { if (++loaded === shots.length) finish(imgs); };
      im.src = src;
    });
  }
  function shareFanCard(id) {
    const f = (store.listeners || []).find(x => x.id === id);
    if (!f) return;
    try {
      makeFanCard(f, (cv) => {
        cv.toBlob((blob) => {
          if (!blob) { toast('產生圖卡失敗'); return; }
          lastCardBlob = blob;
          $('cardImg').src = URL.createObjectURL(blob);
          const cm = $('cardMsg'); if (cm) cm.textContent = '';
          $('cardOverlay').classList.add('open');
        }, 'image/png');
      });
    } catch (e) { toast('產生圖卡失敗'); }
  }
  function makeCard(cb) {
    const tasks = getTasks(scope, openDate);
    const r = calc(tasks);
    const W = 1080, H = 1350;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    const FONT = '\'PingFang TC\', \'Noto Sans TC\', sans-serif';

    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#1c1c2b'); g.addColorStop(1, '#14141c');
    c.fillStyle = g; c.fillRect(0, 0, W, H);

    roundRect(c, 60, 60, W - 120, H - 120, 40);
    c.fillStyle = '#1e1e2a'; c.fill();
    c.strokeStyle = '#b794f6'; c.lineWidth = 4; c.stroke();

    c.textAlign = 'center';
    c.fillStyle = '#e8e8f0';
    c.font = 'bold 56px ' + FONT;
    c.fillText((nickname ? nickname : '') + '聲播日曆 🎁', W / 2, 175);

    const py = Number(openDate.slice(0, 4)), pm = Number(openDate.slice(5, 7)), pd = Number(openDate.slice(8, 10));
    const week = WEEK[new Date(py, pm - 1, pd).getDay()];
    c.fillStyle = '#8b8b9e';
    c.font = '34px ' + FONT;
    c.fillText(py + ' 年 ' + pm + ' 月 ' + pd + ' 日（週' + week + '）', W / 2, 240);

    // 虛擬頭像（左上）
    const drawAvatar = (img) => {
      if (img && img.width) {
        c.save();
        c.beginPath(); c.arc(150, 155, 70, 0, Math.PI * 2); c.closePath();
        c.fillStyle = '#2e2e40'; c.fill();
        c.clip();
        c.drawImage(img, 150 - 70, 155 - 70, 140, 140);
        c.restore();
        c.beginPath(); c.arc(150, 155, 72, 0, Math.PI * 2);
        c.strokeStyle = '#b794f6'; c.lineWidth = 6; c.stroke();
      }
      finishCard(c, r, tasks);
      cb(cv);
    };
    const avImg = new Image();
    avImg.onload = () => drawAvatar(avImg);
    avImg.onerror = () => drawAvatar(null);
    avImg.src = avatarURL();
  }

  function finishCard(c, r, tasks) {
    const FONT = '\'PingFang TC\', \'Noto Sans TC\', sans-serif';
    const W = 1080, H = 1350;
    c.textAlign = 'center';
    c.fillStyle = '#b794f6';
    c.font = 'bold 150px ' + FONT;
    c.fillText(r.pct + '%', W / 2, 435);
    c.fillStyle = '#8b8b9e';
    c.font = '34px ' + FONT;
    c.fillText('任務達成 ' + r.doneCnt + '/' + r.total + ' ・ 分數 ' + r.scoreEarned + '/' + r.scoreTotal, W / 2, 500);

    const bx = 140, bw = W - 280, by = 545;
    roundRect(c, bx, by, bw, 24, 12); c.fillStyle = '#2e2e40'; c.fill();
    if (r.pct > 0) {
      roundRect(c, bx, by, Math.max(24, bw * r.pct / 100), 24, 12);
      const pg = c.createLinearGradient(bx, 0, bx + bw, 0);
      pg.addColorStop(0, '#b794f6'); pg.addColorStop(1, '#f6ad55');
      c.fillStyle = pg; c.fill();
    }

    let ty = 672;
    const mark = alias || '💛';
    tasks.slice(0, 8).forEach(t => {
      const done = t.cur >= t.target;
      roundRect(c, 110, ty - 52, W - 220, 78, 18);
      c.fillStyle = done ? 'rgba(72,187,120,.13)' : 'rgba(46,46,64,.55)';
      c.fill();
      c.textAlign = 'left';
      c.fillStyle = done ? '#48bb78' : '#e8e8f0';
      c.font = 'bold 40px ' + FONT;
      c.fillText((done ? mark + ' ' : '⬜ ') + t.name, 150, ty);
      c.textAlign = 'right';
      c.fillStyle = done ? '#48bb78' : '#8b8b9e';
      c.font = 'bold 40px ' + FONT;
      c.fillText(t.cur + '/' + t.target, W - 150, ty);
      ty += 92;
    });

    c.textAlign = 'center';
    c.fillStyle = '#5a5a70';
    c.font = '28px ' + FONT;
    c.fillText('聲播日曆', W / 2, H - 105);
  }

  // ---------- 本週分數統計（與後台相同：業績／任務／時數每日長條，按鈕展開才顯示） ----------
  function dayMinutesOf(dk) {
    const b = store.dates && store.dates[dk];
    if (!b || !Array.isArray(b.slots)) return 0;
    return b.slots.reduce((a, sl) => a + slotMinutes(sl), 0);
  }
  function renderWeekStats(visible) {
    const box = $('weekStatsBox');
    const btn = $('weekStatsBtn');
    if (!box || !btn) return;
    btn.textContent = weekStatsOpen ? '📊 收合本週分數統計' : '📊 本週分數統計';
    if (!visible || !weekStatsOpen || !openDate) { box.style.display = 'none'; return; }
    try { logTodayScores(); } catch (e) {}
    const settings = store.settings || {};
    const showSales = settings.enableSalesScore !== false;
    const wi = weekInfo(openDate);
    const start = wi.start, end = addDays(wi.start, 7);
    const targetKey = key(start.getFullYear(), start.getMonth(), start.getDate());
    const cut = getGiftCutoffHour() === 8 ? '08:00' : '00:00';
    const log = store.scoreLog || {};
    const WD = ['日', '一', '二', '三', '四', '五', '六'];
    const rows = [];
    let prevW = 0; const prevMByMonth = {};
    let sSum = 0, tSum = 0;
    for (let dt = new Date(start); dt < end; dt.setDate(dt.getDate() + 1)) {
      const dk = key(dt.getFullYear(), dt.getMonth(), dt.getDate());
      const snap = log[dk]; const b = store.dates[dk]; const mk = dk.slice(0, 7);
      // 日／簡／加碼：依當天任務清單即時計算；週／月：依快照差額歸到實際拿到分數的那一天（與後台、複製當週分數同一套算法）
      const sp = (b && Array.isArray(b.tasks)) ? splitScores(b.tasks) : { day: 0, easy: 0, bonus: 0 };
      let wInc = 0, mInc = 0;
      if (snap) {
        const wNow = snap.week || 0; wInc = Math.max(0, wNow - prevW); prevW = wNow;
        const prevM = prevMByMonth[mk] || 0; mInc = Math.max(0, (snap.month || 0) - prevM); prevMByMonth[mk] = snap.month || 0;
      }
      const t = sp.day + sp.easy + sp.bonus + wInc + mInc;
      const s = showSales ? salesScoreForDay(dk) : 0;
      rows.push({ label: fmtMD(dt) + ' ' + WD[dt.getDay()], t, s, mins: dayMinutesOf(dk) });
      sSum += s; tSum += t;
    }
    const wResidual = Math.max(0, calc(getTasks('week', targetKey)).scoreEarned - prevW);
    const mResidual = Math.max(0, calc(getTasks('month', targetKey)).scoreEarned - (prevMByMonth[targetKey.slice(0, 7)] || 0));
    tSum += wResidual + mResidual;
    const wMin = weekMinutes(targetKey);
    const hFull = Math.floor(wMin / 60), hLeft = wMin % 60, hPts = hFull * 5;
    const sMax = Math.max(1, ...rows.map(r => r.s));
    const tMax = Math.max(1, ...rows.map(r => r.t));
    const hMax = Math.max(60, ...rows.map(r => r.mins));
    const fmtH = (m) => m > 0 ? (Math.round(m / 6) / 10) + 'h' : '';
    let html = '<div class="ws-period">📊 本週 ' + fmtMD(start) + ' ' + cut + ' – ' + fmtMD(end) + ' ' + cut + '</div>';
    html += '<div class="ws-nums">'
      + (showSales ? '<div class="ws-num"><div class="v" style="color:var(--accent2);">' + sSum + '</div><div class="l">本週業績分數</div></div>' : '')
      + '<div class="ws-num"><div class="v" style="color:var(--accent);">' + tSum + '</div><div class="l">本週任務分數</div></div>'
      + '<div class="ws-num"><div class="v" style="color:var(--green);">' + (tSum + hPts) + '</div><div class="l">任務＋時數總分</div></div>'
      + '</div>';
    html += '<div class="ws-hours">📻 開播時數 <b>' + hFull + ' 小時' + (hLeft ? ' ' + hLeft + ' 分' : '') + '</b>　→　時數分數 <b class="p">+' + hPts + '</b> <span style="color:var(--muted);">（每滿 1 小時 +5）</span></div>';
    rows.forEach(r => {
      html += '<div class="ws-row"><span class="d">' + r.label + '</span>'
        + '<div class="ws-track"><div class="ws-fill" style="background:var(--blue);width:' + Math.round(r.mins / hMax * 100) + '%"></div></div><span class="ws-v" style="color:var(--blue);">' + fmtH(r.mins) + '</span>'
        + (showSales ? '<div class="ws-track"><div class="ws-fill" style="background:var(--accent2);width:' + Math.round(r.s / sMax * 100) + '%"></div></div><span class="ws-v" style="color:var(--accent2);">' + (r.s || '') + '</span>' : '')
        + '<div class="ws-track"><div class="ws-fill" style="background:var(--accent);width:' + Math.round(r.t / tMax * 100) + '%"></div></div><span class="ws-v" style="color:var(--accent);">' + (r.t || '') + '</span>'
        + '</div>';
    });
    html += '<div class="ws-legend"><span><i style="background:var(--blue);"></i>時數</span>'
      + (showSales ? '<span><i style="background:var(--accent2);"></i>業績</span>' : '')
      + '<span><i style="background:var(--accent);"></i>任務（含當天拿到的週／月任務）</span></div>';
    if (wResidual || mResidual) {
      html += '<div class="ws-note">另有未歸到特定日期的'
        + (wResidual ? '週任務 +' + wResidual : '') + (wResidual && mResidual ? '、' : '') + (mResidual ? '月任務 +' + mResidual : '')
        + '，已計入本週任務分數</div>';
    }
    box.innerHTML = html;
    box.style.display = 'block';
  }
  $('weekStatsBtn').onclick = () => {
    weekStatsOpen = !weekStatsOpen;
    renderWeekStats(scope === 'day' && isSaturday(openDate));
    if (weekStatsOpen) { try { $('weekStatsBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {} }
  };

  // ---------- 週日複製當週分數 ----------
  $('weekCopyBtn').onclick = () => {
    if (!openDate) return;
    logTodayScores();

    // 禮拜六（每週最後一天）複製「本週」成績：本週日起算至下週日，含週六當下進度
    const curWi = weekInfo(openDate);
    const start = curWi.start;
    const end = addDays(curWi.start, 7);
    const targetKey = key(start.getFullYear(), start.getMonth(), start.getDate());

    const log = store.scoreLog || {};
    const dayLines = [];
    let grand = 0;
    let prevW = 0;
    const prevMByMonth = {}; // 各月份各自記錄累計，跨月週也能正確顯示月分數增量

    for (let dt = new Date(start); dt < end; dt.setDate(dt.getDate() + 1)) {
      const dk = key(dt.getFullYear(), dt.getMonth(), dt.getDate());
      const snap = log[dk];
      const b = store.dates[dk];
      const mk = dk.slice(0, 7);
      // 日/簡/加碼：以當日任務實際資料為準（快照可能漏記後補的簡/加碼）
      const sp = (b && Array.isArray(b.tasks)) ? splitScores(b.tasks) : { day: 0, easy: 0, bonus: 0 };
      // 週/月：以快照累計差額歸屬到「實際拿到分數的那一天」
      let wInc = 0, mInc = 0;
      if (snap) {
        const wNow = snap.week || 0;
        wInc = wNow - prevW; if (wInc < 0) wInc = 0; prevW = wNow;
        const prevM = prevMByMonth[mk] || 0;
        mInc = (snap.month || 0) - prevM; if (mInc < 0) mInc = 0;
        prevMByMonth[mk] = snap.month || 0;
      }
      grand += sp.day + sp.easy + sp.bonus + wInc + mInc;
      // 每日細項順序固定：月 週 日 簡 加碼
      const parts = [];
      if (mInc > 0) parts.push('月+' + mInc);
      if (wInc > 0) parts.push('週+' + wInc);
      if (sp.day) parts.push('日+' + sp.day);
      if (sp.easy) parts.push('簡+' + sp.easy);
      if (sp.bonus) parts.push('加碼+' + sp.bonus);
      if (parts.length) dayLines.push(fmtMD(dt) + ' ' + parts.join(' '));
    }

    // 週/月任務若因缺快照無法歸日的殘差，以合計行補上
    const wr = calc(getTasks('week', targetKey));
    const wResidual = Math.max(0, wr.scoreEarned - prevW);
    grand += wResidual;
    const weekLine = wResidual > 0 ? ('週任務 +' + wResidual) : '';

    const baseMk = targetKey.slice(0, 7);
    const mo = calc(getTasks('month', targetKey));
    const mResidual = Math.max(0, mo.scoreEarned - (prevMByMonth[baseMk] || 0));
    grand += mResidual;
    const monthLine = mResidual > 0 ? ('月任務 +' + mResidual) : '';

    // 整體順序：月/週殘差行 → 每日（月 週 日 簡 加碼）→ 時數 → 總分
    const lines = [];
    if (monthLine) lines.push(monthLine);
    if (weekLine) lines.push(weekLine);
    lines.push(...dayLines);

    const wMin = weekMinutes(targetKey);
    if (wMin > 0) {
      const fullHrs = Math.floor(wMin / 60);
      const leftover = wMin % 60;
      const wPts = fullHrs * 5; // 每滿 1 小時 +5，不滿 1 小時不算
      lines.push('時數 ' + fullHrs + ' 小時' + (leftover ? ' ' + leftover + ' 分（不滿 1 小時不算）' : '') + ' +' + wPts);
      grand += wPts;
    }

    lines.unshift(`【聲播週分數｜${fmtMD(start)} ${getGiftCutoffHour() === 8 ? '08:00' : '00:00'}–${fmtMD(end)} ${getGiftCutoffHour() === 8 ? '08:00' : '00:00'}】`);
    lines.push('總分' + grand);
    copyText(lines.join('\n'));
    toast('已複製剛結束週分數');
  };

  function copyText(text) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (err) { alert(text); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else fallback();
  }

  $('cardBtn').onclick = () => {
    if (!openDate) return;
    if (!getTasks(scope, openDate).length) { toast('還沒有任務，無法產生圖卡'); return; }
    makeCard((cv) => {
    cv.toBlob((blob) => {
      if (!blob) { toast('產生圖卡失敗'); return; }
      lastCardBlob = blob;
      $('cardImg').src = URL.createObjectURL(blob);
      $('cardMsg').textContent = '';
      $('cardOverlay').classList.add('open');
    }, 'image/png');
    });
  };
  // 下載鈕已移除：統一走系統分享選單（內含「儲存影像」）
  $('cardShare').onclick = async () => {
    if (!lastCardBlob) return;
    const file = new File([lastCardBlob], 'shengbo-card.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: '聲播日曆' }); } catch (e) {}
    } else {
      $('cardMsg').textContent = '此裝置不支援直接分享，請用「存到相簿」再手動發';
    }
  };
  $('closeCard').onclick = () => $('cardOverlay').classList.remove('open');
  $('cardOverlay').addEventListener('click', (e) => { if (e.target === $('cardOverlay')) $('cardOverlay').classList.remove('open'); });


  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }


  // ---------- 圖片預覽 ----------
  function openImgPreview(src) {
    if (!src) return;
    $('imgPreviewImg').src = src;
    $('imgPreviewOverlay').classList.add('open');
  }

  // ---------- 聽眾資料庫 ----------
  let editingFanId = null;
  function showFanForm() {
    $('fansForm').classList.add('show');
    $('fanAddToggle').style.display = 'none';
  }
  function hideFanForm() {
    $('fansForm').classList.remove('show');
    $('fanAddToggle').style.display = 'block';
  }

  // 聽眾截圖（最多 2 張，前端壓縮）
  let fanShotDraft = [];
  const MAX_FAN_SHOTS = 2;
  function compressImage(file, cb) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxSide = 1200;
        let w = img.width, h = img.height;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        try {
          cb(canvas.toDataURL('image/jpeg', 0.75));
        } catch (err) {
          toast('截圖壓縮失敗');
        }
      };
      img.onerror = () => toast('圖片讀取失敗');
      img.src = reader.result;
    };
    reader.onerror = () => toast('圖片讀取失敗');
    reader.readAsDataURL(file);
  }
  function renderFanShotPreview() {
    const box = $('fanShotPreview');
    box.innerHTML = '';
    fanShotDraft.slice(0, MAX_FAN_SHOTS).forEach((src, i) => {
      const wrap = document.createElement('div');
      wrap.style.position = 'relative';
      const img = document.createElement('img');
      img.className = 'fan-shot';
      img.src = src;
      img.onclick = () => openImgPreview(src);
      const del = document.createElement('button');
      del.textContent = '✕';
      del.className = 'fan-del';
      del.style.position = 'absolute';
      del.style.right = '2px';
      del.style.top = '2px';
      del.onclick = () => { fanShotDraft.splice(i, 1); renderFanShotPreview(); };
      wrap.appendChild(img); wrap.appendChild(del);
      box.appendChild(wrap);
    });
  }
  function bindFanShots() {
    $('fanShotPick').onclick = () => $('fanShotInput').click();
    $('fanShotInput').addEventListener('change', () => {
      const files = Array.from($('fanShotInput').files || []).slice(0, Math.max(0, MAX_FAN_SHOTS - fanShotDraft.length));
      if (!files.length) { toast('最多只能放 2 張截圖'); $('fanShotInput').value = ''; return; }
      files.forEach(f => compressImage(f, dataUrl => {
        fanShotDraft.push(dataUrl);
        renderFanShotPreview();
      }));
      $('fanShotInput').value = '';
    });
  }

  function clearFanForm() {
    editingFanId = null;
    ['fanId', 'fanNickname', 'fanPersonality', 'fanBirthday', 'fanTopic'].forEach(id => { $(id).value = ''; });
    fanShotDraft = [];
    renderFanShotPreview();
    $('fanShotInput').value = '';
    $('fanSave').textContent = '新增聽眾';
    $('fanCancelEdit').style.display = 'none';
    hideFanForm();
  }
  function renderFans() {
    const list = $('fansList');
    list.innerHTML = '';
    const fans = Array.isArray(store.listeners) ? store.listeners : [];
    if (!fans.length) {
      list.innerHTML = '<div class="empty">還沒有聽眾資料<br>先把常互動的聽眾記起來吧</div>';
      return;
    }
    fans.forEach(f => {
      const div = document.createElement('div');
      div.className = 'fan-card';
      div.innerHTML = `
        <div class="fan-top">
          <div>
            <div class="fan-name">${escapeHtml(f.nickname || '未命名')}</div>
            <div class="fan-meta">ID：${escapeHtml(f.id || '-')}　🎂 ${escapeHtml(f.birthday || '未填')}</div>
          </div>
          <button class="fan-share" data-id="${escapeHtml(f.id || '')}" title="產生分享圖卡">📤</button>
          <button class="fan-del" data-id="${escapeHtml(f.id || '')}" title="刪除">✕</button>
        </div>
        <div class="fan-meta">個性：${escapeHtml(f.personality || '未填')}</div>
        <div class="fan-meta">最近話題：${escapeHtml(f.topic || '未填')}</div>
        ${(Array.isArray(f.shots) && f.shots.length) ? `<div class="fan-shots">${f.shots.slice(0, 2).map(s => `<img class="shot-thumb" src="${s}" alt="" data-shot-src="${escapeHtml(s)}">`).join('')}</div>` : ''}`;
      div.onclick = (e) => {
        if (e.target && e.target.classList && e.target.classList.contains('fan-del')) return;
        editingFanId = f.id || null;
        $('fanId').value = f.id || '';
        $('fanNickname').value = f.nickname || '';
        $('fanPersonality').value = f.personality || '';
        $('fanBirthday').value = f.birthday || '';
        $('fanTopic').value = f.topic || '';
        fanShotDraft = Array.isArray(f.shots) ? f.shots.slice(0, 2) : [];
        renderFanShotPreview();
        $('fanSave').textContent = '更新聽眾';
        $('fanCancelEdit').style.display = '';
        showFanForm(); // 編輯聽眾卡時也展開欄位
      };
      list.appendChild(div);
    });
  }
  function saveFan() {
    const nickname = $('fanNickname').value.trim();
    if (!nickname) { toast('請填暱稱'); return; }
    const manualId = $('fanId').value.trim();
    const id = manualId || editingFanId || ('F-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7));
    const exists = Array.isArray(store.listeners) && store.listeners.some(x => x.id === id);
    if (!exists && Array.isArray(store.listeners) && store.listeners.length >= 50) {
      toast('聽眾資料卡上限為 50 張');
      return;
    }
    const obj = {
      id,
      nickname,
      personality: $('fanPersonality').value.trim(),
      birthday: $('fanBirthday').value.trim(),
      topic: $('fanTopic').value.trim(),
      shots: fanShotDraft.slice(0, MAX_FAN_SHOTS)
    };
    if (!Array.isArray(store.listeners)) store.listeners = [];
    const i = store.listeners.findIndex(x => x.id === id);
    if (i >= 0) store.listeners[i] = obj; else store.listeners.push(obj);
    save(); renderFans(); clearFanForm(); toast('已儲存聽眾');
  }
  // 供後段補丁 script 委派使用；放在此處確保一定執行得到（IIFE 結尾處另有備份）
  window.fansUI = { clearFanForm: clearFanForm, saveFan: saveFan, showFanForm: showFanForm };
  // 業績目標：在日面板各分頁直接編輯（事件委派只需綁一次，跟隨當前 scope 寫入對應設定）
  document.addEventListener('change', (e) => {
    if (!e.target || e.target.id !== 'salesTargetInput') return;
    const v = Math.max(0, parseInt(e.target.value, 10) || 0);
    if (scope === 'day') store.settings.salesDayTarget = v;
    else if (scope === 'week') store.settings.salesWeekTarget = v;
    else if (scope === 'month') store.settings.salesMonthTarget = v;
    else return;
    save();
    renderSheet();
    toast('業績目標已更新');
  });
  // 趨勢圖分享：業績＋任務兩張圖合併成一張圖卡
  function shareTrendCard() {
    if (!openDate) return;
    const period = window.__trendPeriod || 'week';
    const [y, m] = openDate.split('-').map(Number);
    let labels = [], sales = [], tasks = [], rangeTxt;
    if (period === 'week') {
      const wi = weekInfo(openDate);
      for (let i = 0; i < 7; i++) {
        const dt = new Date(wi.start); dt.setDate(wi.start.getDate() + i);
        const dk = key(dt.getFullYear(), dt.getMonth(), dt.getDate());
        labels.push(`${dt.getMonth() + 1}/${dt.getDate()}`);
        sales.push(salesScoreForDay(dk));
        tasks.push(taskScoreForDay(dk));
      }
      rangeTxt = `${fmtMD(wi.start)}–${fmtMD(wi.end)}`;
    } else {
      const days = new Date(y, m, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const dk = key(y, m - 1, d);
        labels.push(String(d));
        sales.push(salesScoreForDay(dk));
        tasks.push(taskScoreForDay(dk));
      }
      rangeTxt = `${y}-${String(m).padStart(2, '0')}`;
    }
    try {
      const W = 1200, CH = 620;
      const t1 = document.createElement('canvas'); t1.width = W; t1.height = CH;
      const t2 = document.createElement('canvas'); t2.width = W; t2.height = CH;
      drawTrend(t1, labels, sales, tasks, `📈 ${period === 'week' ? '本週' : '本月'}業績分數（${rangeTxt}）`, 'sales');
      drawTrend(t2, labels, sales, tasks, `📈 ${period === 'week' ? '本週' : '本月'}任務目標收禮分數`, 'tasks');
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = 80 + CH + 40 + CH + 60;
      const c = cv.getContext('2d');
      c.fillStyle = '#14141c'; c.fillRect(0, 0, cv.width, cv.height);
      c.textAlign = 'center';
      c.fillStyle = '#e8e8f0';
      c.font = "bold 40px 'PingFang TC', 'Noto Sans TC', sans-serif";
      c.fillText(`🎁 聲播日曆趨勢圖（${rangeTxt}）`, W / 2, 52);
      c.drawImage(t1, 0, 80, W, CH);
      c.drawImage(t2, 0, 80 + CH + 40, W, CH);
      cv.toBlob((blob) => {
        if (!blob) { toast('產生圖卡失敗'); return; }
        lastCardBlob = blob;
        $('cardImg').src = URL.createObjectURL(blob);
        const cm = $('cardMsg'); if (cm) cm.textContent = '';
        $('cardOverlay').classList.add('open');
      }, 'image/png');
    } catch (e) { toast('產生圖卡失敗'); }
  }
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'trendShareBtn') shareTrendCard();
  });
  updateHeaderSub();
  function bindFans() {
    if (!Array.isArray(store.listeners)) store.listeners = [];
    renderFans();
    $('fansOverlay').addEventListener('click', (e) => { if (e.target === $('fansOverlay')) $('fansOverlay').classList.remove('open'); });
    // 關閉面板時重置表單狀態（含「＋新增聽眾」按鈕顯示），用 addEventListener 避免被後段 script 的 onclick 覆蓋後失效
    $('closeFans').addEventListener('click', () => clearFanForm());
    $('fansOverlay').addEventListener('click', (e) => { if (e.target === $('fansOverlay')) clearFanForm(); });
    $('fanSave').onclick = saveFan;
    $('fanClear').onclick = clearFanForm;
    bindFanShots();
    renderFanShotPreview();
    $('fanAddToggle').style.display = 'block';
    $('fanAddToggle').onclick = () => { clearFanForm(); showFanForm(); };
    $('fanCancelEdit').onclick = () => { clearFanForm(); showFanForm(); };
    $('fansList').addEventListener('click', (e) => {
      const shot = e.target.closest && e.target.closest('.shot-thumb');
      if (shot && shot.dataset && shot.dataset.shotSrc) { openImgPreview(shot.dataset.shotSrc); return; }
      const shareBtn = e.target.closest('.fan-share');
      if (shareBtn && shareBtn.dataset.id) { shareFanCard(shareBtn.dataset.id); return; }
      const btn = e.target.closest('.fan-del');
      if (!btn) return;
      const id = btn.dataset.id;
      const fan = (store.listeners || []).find(x => x.id === id);
      const name = fan && fan.nickname ? fan.nickname : id;
      if (!confirm(`確定要刪除聽眾「${name}」嗎？`)) return;
      store.listeners = (store.listeners || []).filter(x => x.id !== id);
      if (editingFanId === id) clearFanForm();
      save(); renderFans(); toast('已刪除聽眾');
    });
  }
  bindFans();


  // ---------- 設定 ----------
  function applySettingsVisibility() {
    const settings = store.settings || {};
    const gift = settings.enableGiftTasks !== false;
    ['.add-row', '.add-hints', '#copyPrevBtn', '#clearDayBtn', '#copyListBtn'].forEach(sel => {
      const el = document.querySelector(sel);
      if (el && el.style) el.style.display = gift ? '' : 'none';
    });
    const wc = $('weekCopyBtn');
    if (wc && gift) wc.style.display = '';
  }
  function bindSalesInline() {
    const btn = $('salesAddBtn');
    if (btn) btn.onclick = () => addSalesScore($('salesAddInput').value);
  }
  bindSalesInline();
  $('closeImgPreview').onclick = () => $('imgPreviewOverlay').classList.remove('open');
  $('imgPreviewOverlay').addEventListener('click', (e) => { if (e.target === $('imgPreviewOverlay')) $('imgPreviewOverlay').classList.remove('open'); });
  $('tabTrendSales').onclick = () => { trendMode = 'sales'; openTrend(openDate && isLastDayOfMonth(openDate) ? 'month' : 'week'); };
  $('tabTrendTasks').onclick = () => { trendMode = 'tasks'; openTrend(openDate && isLastDayOfMonth(openDate) ? 'month' : 'week'); };
  $('trendWeekBtn').onclick = () => openTrend('week');
  $('trendMonthBtn').onclick = () => openTrend('month');
  $('closeTrend').onclick = () => $('trendOverlay').classList.remove('open');
  $('trendOverlay').addEventListener('click', (e) => { if (e.target === $('trendOverlay')) $('trendOverlay').classList.remove('open'); });

  // 設定面板：開啟前把 store.settings 填入表單（salesTarget* 欄位為選配，有就放）
  function populateSettingsPanel() {
    const s = store.settings || {};
    const setChecked = (id, val) => { const el = $(id); if (el) el.checked = val !== false; };
    const setVal = (id, val) => { const el = $(id); if (el) el.value = val; };
    const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };
    setChecked('enableGiftTasks', s.enableGiftTasks);
    setChecked('enableSalesScore', s.enableSalesScore);
    setChecked('enableDragon', s.enableDragon);
    setChecked('enableCastle', s.enableCastle);
    setVal('giftCutoffHour', String([0, 8].includes(Number(s.giftCutoffHour)) ? Number(s.giftCutoffHour) : 0));
    setVal('salesCutoffHour', String([0, 8].includes(Number(s.salesCutoffHour)) ? Number(s.salesCutoffHour) : 8));
    ['salesDayTarget', 'salesWeekTarget', 'salesMonthTarget'].forEach(k => setVal(k, Number.isFinite(s[k]) ? s[k] : 0));
    show('giftCutoffRow', $('enableGiftTasks') && $('enableGiftTasks').checked);
    show('salesCutoffRow', $('enableSalesScore') && $('enableSalesScore').checked);
    show('salesSettingsBox', $('enableSalesScore') && $('enableSalesScore').checked);
  }

  function openSettingsPanel() {
    populateSettingsPanel();
    openOverlay('settingsOverlay');
  }

  function bindSettings() {
    $('settingsBtn').onclick = openSettingsPanel;
    window.openSettingsPanel = openSettingsPanel;
    $('closeSettings').onclick = () => $('settingsOverlay').classList.remove('open');
    $('settingsOverlay').addEventListener('click', (e) => { if (e.target === $('settingsOverlay')) $('settingsOverlay').classList.remove('open'); });
    $('enableGiftTasks').addEventListener('change', () => { $('giftCutoffRow').style.display = $('enableGiftTasks').checked ? '' : 'none'; });
    $('enableSalesScore').addEventListener('change', () => { $('salesCutoffRow').style.display = $('enableSalesScore').checked ? '' : 'none'; });
    $('settingsSave').onclick = () => {
      store.settings = {
        enableGiftTasks: $('enableGiftTasks').checked,
        enableSalesScore: $('enableSalesScore').checked,
        enableDragon: $('enableDragon').checked,
        enableCastle: $('enableCastle').checked,
        giftCutoffHour: Number($('giftCutoffHour').value) === 8 ? 8 : 0,
        salesCutoffHour: Number($('salesCutoffHour').value) === 0 ? 0 : 8,
        salesDayTarget: Math.max(0, parseInt((store.settings || {}).salesDayTarget, 10) || 0),
        salesWeekTarget: Math.max(0, parseInt((store.settings || {}).salesWeekTarget, 10) || 0),
        salesMonthTarget: Math.max(0, parseInt((store.settings || {}).salesMonthTarget, 10) || 0)
      };
      save(); renderSheet(); renderCalendar(); updateHeaderSub(); applySettingsVisibility(); toast('設定已儲存');
    };
    applySettingsVisibility();
  }
  bindSettings();


  // ---------- Safari 建議 ----------
  function isSafariBrowser() {
    const ua = navigator.userAgent || '';
    const isIOS = /iP(hone|od|ad)/.test(ua);
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|mercury|chrome|android/i.test(ua);
    return isIOS && isSafari;
  }
  function maybeShowSafariTip() {
    try {
      if (localStorage.getItem('safariTipShown') === '1') return;
      if (isSafariBrowser()) return;
      $('safariTipOverlay').classList.add('open');
      localStorage.setItem('safariTipShown', '1');
    } catch (e) {}
  }
  $('closeSafariTip').onclick = () => $('safariTipOverlay').classList.remove('open');
  $('safariTipOk').onclick = () => $('safariTipOverlay').classList.remove('open');
  $('safariTipOverlay').addEventListener('click', (e) => { if (e.target === $('safariTipOverlay')) $('safariTipOverlay').classList.remove('open'); });

  // ---------- 通用 overlay 開關（單一綁定來源；舊版為三份重複的補丁 script）----------
  function openOverlay(id) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('open');
    requestAnimationFrame(() => el.classList.add('open'));
  }
  function bindOverlayButtons() {
    $('sfxBtn').onclick = () => { ensureAudio(); renderSfx(); openOverlay('sfxOverlay'); };
    $('donateBtn').onclick = () => openOverlay('donateOverlay');
    $('fansBtn').onclick = () => { renderFans(); bindFanShots(); renderFanShotPreview(); openOverlay('fansOverlay'); };
    $('syncTemplateBtn').onclick = syncTemplateTasks;
    $('settingsBtn').onclick = openSettingsPanel;
    // 各面板的關閉鈕：往上找到 .overlay 關掉即可
    ['closeSfx', 'closeDonate', 'closeFans', 'closeSettings'].forEach(id => {
      const btn = $(id);
      if (!btn) return;
      btn.onclick = () => {
        const overlay = btn.closest ? btn.closest('.overlay') : null;
        if (overlay) overlay.classList.remove('open');
      };
    });
  }

  // 暴露給外部（console / 測試）使用
  window.renderSfx = renderSfx;
  window.renderFans = renderFans;
  window.ensureAudio = ensureAudio;
  window.setSfxVolume = setSfxVolume;

  bindOverlayButtons();
  renderCalendar();
})();
