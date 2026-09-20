# 聲播日曆 (en-calendar)

> 這份是本專案給所有 AI 編碼工具讀的共用脈絡。`CLAUDE.md` 只有一行 `@AGENTS.md`，
> 兩邊不要各寫一份，改就改這裡。

給聲播主記錄開播時段、收禮目標與達成狀況的 PWA。使用者自己登入、自己看自己的資料；
另有後台讓管理者看所有主播的狀況。

## 技術架構

- **純 vanilla JS，沒有任何框架、沒有 build step**。改完直接就是成品
- Firebase compat SDK 10.12.2，從 gstatic CDN 載入（`index.html` 底部三個 script）
- Firebase 專案：`en-calendar-dbb36`（Auth 用 Google 登入 + Firestore + Cloud Functions）
- `sw.js` **只處理 Web Push，完全不做快取**。不要加 cache 邏輯，版本更新是靠 `js/update-check.js` 比對 HTML 裡的 meta

## 檔案地圖

| 路徑 | 說明 |
|---|---|
| `index.html` | 前台單頁，所有 UI 的 DOM 都在這 |
| `css/style.css` | 全部樣式，CSS 變數定義在最上面的 `:root` |
| `js/app.js` | ~3000 行主程式，用 `// ---------- 區塊名 ----------` 分段 |
| `js/data-images.js` | **313KB base64 圖片資料。整份不要讀**，詳見下方「不要整份讀的檔案」 |
| `js/update-check.js` | 每 30 分鐘抓自己的 HTML 比對 `app-version`，有新版就跳更新橫幅 |
| `functions/` | Cloud Functions（Node 20，CommonJS） |
| `test/` | 測試站鏡像 + **後台頁面** |
| `avatars/` `gifts/` `sfx/` | 素材檔，不要動 |
| `doc/` | 使用手冊與後台手冊的 HTML / PDF 產出 |

### 不要整份讀的檔案

以下檔案**不要用 Read / cat 整份讀進對話**，內容是機器產物或超大文字，讀了會塞滿 context
而且看不出任何有用資訊：

| 檔案 | 大小 | 內容 |
|---|---|---|
| `js/data-images.js`、`test/js/data-images.js` | 313KB | base64 圖片字串 |
| `user-manual.html`、`test/user-manual.html` | 485KB | 使用手冊，內嵌大量 base64 截圖 |
| `functions/package-lock.json` | 104KB | 相依樹 |
| `doc/*.pdf` | 1.2–1.4MB | 手冊 PDF 產出，原始檔是同名的 .html |
| `functions/node_modules/` | — | 一律不進去 |

要找東西用 `grep` 精準抓，例如 `grep -n "關鍵字" user-manual.html | head`。
`js/app.js`（139KB）可以讀，但建議先用區塊註解定位再讀該段，不要整份拉進來。

### app.js 主要區塊（行號會變動，用註解搜尋）

Firebase 登入與雲端資料庫 / 主播暱稱・馬甲・頭像 / 業績分數 / 趨勢圖 / 月曆 / 日面板 /
行事曆匯出 / 熱門話題 / 流行華語歌曲 / 直播音效庫 / 開播下播打卡提醒 / 分享圖卡 /
本週分數統計 / 聽眾資料庫 / 設定 / Web Push / 通用 overlay 開關

## 資料結構

**Firestore `users/{uid}`**：
- `dates["YYYY-MM-DD"].slots` — 當天的開播時段（打卡與推播都看這個）
- `pushSubs` — Web Push 訂閱，失效的 404/410 會被 Functions 自動移除
- `nick` / `alias` / `avatarData` / `email` / `profile` — 主播基本資料
- `fans` / `items` — 聽眾資料卡與禮物項目

**Firestore `templates`** — 收禮目標範本

**localStorage**（只放不需要同步的東西）：
`nick_v1` `alias_v1` `avatar_v1` `avatarData_v1` `sfxVolume` `iosTipHide` `safariTipShown` `voiceAvatarData`

## 前台 / 後台

- 前台 = 根目錄 `index.html`
- **後台只存在於 `test/` 底下**：`test/admin.html`（主播收禮狀況）、`test/superadmin.html`（帳號與角色）。
  正式站根目錄沒有後台頁，線上網址是 `/test/admin.html`
- `firebase.json` 的 `public` 是 `.`，所以 `test/` 整個會被部署上線

## 架構級禁令

這些是已經定案、不要重新討論也不要「順手優化」的決定：

- **不要引入任何框架**（React / Vue / Svelte…）。這是刻意的 vanilla JS，沒有 build step，
  改完的檔案就是部署出去的檔案
- **不要引入打包工具或轉譯**（webpack / vite / babel / TypeScript）。同上
- **不要在 `sw.js` 加快取邏輯**。它只負責 Web Push。版本更新是靠 `js/update-check.js`
  以 `no-store` 抓自己的 HTML 比對 `app-version` 來處理，加了快取只會製造「使用者看到舊版」的問題
- **不要把 `js/app.js` 拆成模組**。它很長，但它是單檔載入、無模組系統的設計
- **不要改用 Firebase modular SDK**。目前用的是 compat 版（v10.12.2，CDN 載入），全檔都依賴 compat 的 API 形式
- **不要把素材改成外部連結或 CDN**。`avatars/` `gifts/` `sfx/` 是自帶的，離線也要能用
- **不要把任何金鑰寫進 repo**。VAPID 私鑰在 `~/.en-calendar-vapid-private.txt`

## 改動規則

- **改根目錄的 `index.html` / `css/style.css`，要同步改 `test/` 那份**。兩者差別只有相對路徑
  （`test/` 裡是 `../icon.png`、`../avatars/`），其他內容應該一致
- `js/app.js` 和 `test/js/app.js` 唯一的差異是音效檔路徑（`test/` 那份是 `../sfx/...`）。
  改動 `js/app.js` 後同步過去時，**要保留這個 `../` 前綴**，其餘內容必須一致
- 改版本號要同時更新 `index.html` 的 `<meta name="app-version">`
- UI 改動要在手機寬度（375px）確認一次，這個 App 幾乎都在手機上用

## 部署

push 到 `main` → GitHub Actions → `firebase deploy --only hosting`。

- workflow：`.github/workflows/firebase-hosting-merge.yml`
- `paths-ignore` 有 `test/**` 和 `**.md`，所以只改這些不會觸發部署
- **push 到 main 等於直接上線，沒有 staging 緩衝。沒問過我不要 push**

Cloud Functions 要另外手動部署：`firebase deploy --only functions`（需要 Blaze 方案）

## Cloud Functions

`sendSlotReminders` 每 5 分鐘跑一次（台北時間），讀 `users/{uid}.pushSubs`，
依當天 `dates[...].slots` 在開播時與下播前 5 分鐘各推一次。已發送紀錄在 `pushLog/{uid}`，保留 3 天。

- 判斷邏輯在 `functions/due.js`（純函式），**改完一定要跑 `node test-due.js` 離線驗證**
- VAPID 公鑰寫在 `js/app.js` 與 `functions/index.js`；私鑰在 `~/.en-calendar-vapid-private.txt`，
  **不在 repo 裡，也不要寫進 repo**

## 本機開發

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

（`.claude/launch.json` 已經設好這個 configuration）

## 慣例

- commit message：`feat:` / `fix:` / `docs:` 開頭，內容用繁體中文
- 註解、UI 文案、文件一律繁體中文

## 常見任務的標準步驟

### 新增一個音效

1. 音檔放進 `sfx/`（mp3 或 m4a），並在 `sfx/CREDITS.txt` 補上來源與授權
2. 在 `js/app.js` 的 `SFX` 陣列（搜尋 `// ---------- 直播音效庫`）加一筆：
   `{ id, label, file: 'sfx/檔名', fallback: '合成器名' }`
3. `fallback` 必須是 `SFX_PLAYERS` 裡已存在的 key — 目前有
   `airhorn` `applause` `coin` `countdown` `ding` `drum` `fail` `fanfare` `surprise` `whoosh`。
   音檔載入失敗或 iOS 擋自動播放時，會改用 WebAudio 即時合成這個 fallback
4. 同步到 `test/js/app.js` 的同一個陣列，**路徑要加 `../` 前綴**（`'../sfx/檔名'`）

### 改版面或樣式

1. 改 `index.html` / `css/style.css`
2. 同步到 `test/index.html` / `test/css/style.css`，保留 `../` 的相對路徑差異
3. 在 375px 寬度確認一次
4. 更新 `index.html` 的 `<meta name="app-version">`

### 改推播邏輯

1. 判斷規則寫在 `functions/due.js`（純函式，不碰 Firebase）
2. `cd functions && node test-due.js` 離線驗證
3. `firebase deploy --only functions` 單獨部署（不會被 GitHub Actions 帶上去）

## 目前的臨時狀態

前台套著生日風格（`css/style.css` 最後一段註解「🎂 生日風格」+ `index.html` 的
`bday-banner` / `bday-confetti` / `bday-balloon`）。**2026-10-05 會還原成原本的深紫灰主題**，
在那之前不要把生日的樣式當成正式設計。
