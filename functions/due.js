'use strict';
// 純函式：算出「現在這一刻」該發的開播／下播打卡提醒。
// 規則與 App 內的 checkReminders 一致：
//   開播打卡：開播時間起算，開播後 5 分鐘內提醒（前後各放寬 1 分鐘給排程誤差）
//   下播打卡：下播前 5 分鐘內提醒
// 時段存在主播的 dates[YYYY-MM-DD].slots，日期一律以台北時間的日曆日為準（與 App 的 todayKey 相同）。

function taipeiParts(now) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const p = {};
  fmt.formatToParts(now).forEach((x) => { p[x.type] = x.value; });
  const hh = Number(p.hour) % 24; // 某些環境會把 00 時輸出成 24
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh, mm: Number(p.minute) };
}
function dayKey(p) {
  return p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
}
function toMin(t) {
  if (!t) return NaN;
  const parts = String(t).split(':');
  const h = Number(parts[0]), m = Number(parts[1] || 0);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

/**
 * @param {object} dates  users/{uid}.dates
 * @param {Date}   now
 * @param {object} sent   已發送過的 key → ISO 時間（pushLog/{uid}.sent）
 * @param {string} nick   主播暱稱（放進標題）
 * @returns {Array<{key:string,title:string,body:string,tag:string}>}
 */
function computeDue(dates, now, sent, nick) {
  const out = [];
  const p = taipeiParts(now);
  const tk = dayKey(p);
  const cur = p.hh * 60 + p.mm;
  const b = dates && dates[tk];
  if (!b || !Array.isArray(b.slots)) return out;
  const who = nick ? '・' + nick : '';
  b.slots.forEach((sl, i) => {
    if (!sl || typeof sl !== 'object') return;
    const s = toMin(sl.start), e = toMin(sl.end);
    if (Number.isFinite(s)) {
      const k = tk + '_' + i + '_start';
      if (!sent[k] && cur >= s - 1 && cur < s + 6) {
        out.push({ key: k, title: '🎙️ 開播打卡' + who, body: '第 ' + (i + 1) + ' 場 ' + sl.start + ' 開播了，記得打卡！', tag: k });
      }
    }
    if (Number.isFinite(e) && (!Number.isFinite(s) || e > s)) {
      const k = tk + '_' + i + '_end';
      if (!sent[k] && cur >= e - 6 && cur < e) {
        out.push({ key: k, title: '🎙️ 下播打卡' + who, body: '第 ' + (i + 1) + ' 場 ' + sl.end + ' 下播，再 5 分鐘，記得打卡！', tag: k });
      }
    }
  });
  return out;
}

module.exports = { computeDue, taipeiParts, dayKey, toMin };
