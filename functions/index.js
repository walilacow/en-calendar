'use strict';
// 聲播日曆 Cloud Functions：每 5 分鐘檢查所有已開啟推播的主播，發送開播／下播打卡的 Web Push。
// 需要的設定：Secret Manager 的 VAPID_PRIVATE_KEY（見 functions/README.md）。

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const webpush = require('web-push');
const { computeDue } = require('./due');

admin.initializeApp();

// 公鑰與前端 js/app.js 的 VAPID_PUBLIC_KEY 必須是同一對
const VAPID_PUBLIC_KEY = 'BEuMNVSP0yeWn5OOoQ4KFVnW6BAPk3Snb765vlQNfCEzZXdyRB2nCaftxTYfJUlDyJjljwx1NCqys0EzoH6fr_g';
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
const CONTACT = 'mailto:walilacow.hu@gmail.com';
const KEEP_LOG_DAYS = 3;

exports.sendSlotReminders = onSchedule({
  schedule: 'every 5 minutes',
  timeZone: 'Asia/Taipei',
  region: 'asia-east1',
  memory: '256MiB',
  timeoutSeconds: 120,
  secrets: [VAPID_PRIVATE_KEY]
}, async () => {
  webpush.setVapidDetails(CONTACT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.value());
  const db = admin.firestore();
  const now = new Date();
  const users = await db.collection('users').get();
  let checked = 0, sentCount = 0, removed = 0;

  for (const doc of users.docs) {
    const d = doc.data() || {};
    const subs = d.pushSubs;
    if (!subs || typeof subs !== 'object' || !Object.keys(subs).length) continue;
    checked++;

    const logRef = db.collection('pushLog').doc(doc.id);
    const logSnap = await logRef.get();
    const sent = (logSnap.exists && logSnap.data().sent) || {};
    const due = computeDue(d.dates || {}, now, sent, d.nickname || '');
    if (!due.length) continue;

    const dead = [];
    for (const item of due) {
      const payload = JSON.stringify({ title: item.title, body: item.body, tag: item.tag, url: './index.html' });
      for (const [id, sub] of Object.entries(subs)) {
        if (!sub || !sub.endpoint || !sub.keys) continue;
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 600, urgency: 'high' });
          sentCount++;
        } catch (err) {
          const code = err && err.statusCode;
          if (code === 404 || code === 410) dead.push(id);           // 訂閱已失效（使用者移除 App／關閉通知）
          else logger.warn('push failed', { uid: doc.id, id, code, msg: err && err.message });
        }
      }
      sent[item.key] = now.toISOString();
    }

    // 清掉 3 天前的紀錄，pushLog 不會無限長大
    const cutoff = new Date(now.getTime() - KEEP_LOG_DAYS * 86400000).toISOString().slice(0, 10);
    Object.keys(sent).forEach((k) => { if (k.slice(0, 10) < cutoff) delete sent[k]; });
    await logRef.set({ sent, updatedAt: now.toISOString() });

    if (dead.length) {
      const upd = {};
      dead.forEach((id) => { upd['pushSubs.' + id] = admin.firestore.FieldValue.delete(); });
      await doc.ref.update(upd).catch(() => {});
      removed += dead.length;
    }
  }
  logger.info('sendSlotReminders done', { checked, sent: sentCount, removed });
});
