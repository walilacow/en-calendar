# 聲播日曆 Cloud Functions（開播／下播打卡 Web Push）

`sendSlotReminders` 每 5 分鐘跑一次（台北時間），讀取所有在 App 設定裡開啟推播的主播
（`users/{uid}.pushSubs`），依當天的開播時段（`dates[YYYY-MM-DD].slots`）在
**開播時** 與 **下播前 5 分鐘** 各推播一次。已發送的紀錄放在 `pushLog/{uid}`（只保留 3 天），
失效的訂閱（404 / 410）會自動從 `pushSubs` 移除。

規則在 `due.js`（純函式），`node test-due.js` 可以離線驗證。

## 第一次部署（只需做一次）

1. **升級 Blaze 方案**：Firebase Console → 專案 en-calendar-dbb36 → 左下「升級」→ Blaze（按量計費）。
   這個用量（每 5 分鐘一次、幾十位主播）每月費用趨近 0 元，但 Cloud Functions 一定要 Blaze 才能部署。
2. **安裝並登入 Firebase CLI**（在自己的電腦）：
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
3. **安裝套件**：
   ```bash
   cd functions && npm install && cd ..
   ```
4. **設定 VAPID 私鑰**（Claude 產生的一對金鑰：公鑰已寫在 `js/app.js` 與 `functions/index.js`，
   私鑰存在你電腦的 `~/.en-calendar-vapid-private.txt`，不在 repo 裡）：
   ```bash
   firebase functions:secrets:set VAPID_PRIVATE_KEY --data-file ~/.en-calendar-vapid-private.txt --project en-calendar-dbb36
   ```
5. **部署**（第一次會自動啟用 Cloud Functions / Cloud Build / Cloud Scheduler / Secret Manager 等 API，可能要等 1～2 分鐘）：
   ```bash
   firebase deploy --only functions --project en-calendar-dbb36
   ```
6. **確認**：Firebase Console → Functions 看到 `sendSlotReminders`；Google Cloud Console → Cloud Scheduler 有一個每 5 分鐘的工作。
   Functions 的記錄每次會印 `sendSlotReminders done {checked, sent, removed}`。

之後改了 `functions/` 的程式，重跑第 5 步即可；GitHub Actions 的 hosting 部署不會碰 functions。

## 之後想讓 GitHub Actions 自動部署 functions（選用）

在 GitHub 網頁新增 `.github/workflows/deploy-functions.yml`（repo 現有的 `FIREBASE_TOKEN` secret 可以共用）：

```yaml
name: Deploy Functions
on:
  push:
    branches: [main]
    paths: ['functions/**']
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install -g firebase-tools@13.29.1
      - run: cd functions && npm ci
      - run: firebase deploy --only functions --project en-calendar-dbb36 --non-interactive --force
        env: { FIREBASE_TOKEN: ${{ secrets.FIREBASE_TOKEN }} }
```

## 換金鑰

若要換一對新的 VAPID 金鑰：產生後同時更新 `js/app.js`、`test/js/app.js`、`functions/index.js` 的公鑰，
重設 Secret，重新部署 hosting 與 functions；所有主播要在 App 裡「關閉推播」再「開啟推播」一次。
