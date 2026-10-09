/* PTCGL 対局検討 — 画面と処理の流れ */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const E = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ================================================================ 保存（iPhoneの中のデータベース）
  const DB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open("ptcgl", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      });
    },
    async get(key) {
      const db = await this.open();
      return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    },
    async set(key, val) {
      const db = await this.open();
      return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); });
    },
  };

  let store = Core.defaultStore();
  async function save() {
    try { await DB.set("store", JSON.parse(JSON.stringify(store))); }
    catch (e) {
      try { localStorage.setItem("ptcgl_store", JSON.stringify(store)); } catch (_) { toast("保存できませんでした。容量がいっぱいの可能性があります"); }
    }
  }
  async function load() {
    let data = null;
    try { data = await DB.get("store"); } catch (_) { /* 使えない環境では下で予備を読む */ }
    if (!data) { try { data = JSON.parse(localStorage.getItem("ptcgl_store") || "null"); } catch (_) { data = null; } }
    const base = Core.defaultStore();
    if (data) { Object.assign(base, data); base.settings = Object.assign(Core.defaultStore().settings, data.settings || {}); }
    if (!base.meta_notes) base.meta_notes = Core.DEFAULT_META_NOTES;
    store = base;
  }

  const key = () => (store.settings.api_key || "").trim();
  const model = () => store.settings.model || Core.MODELS[0];
  const sys = () => Core.systemPrompt(store.regulation);

  // ================================================================ 小物
  let toastTimer = null;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function setTop(text, busy) {
    const el = $("topStatus");
    el.classList.toggle("busy", !!busy);
    el.textContent = text || `環境 ${String(store.meta_updated_at || "").slice(0, 10) || "未設定"}`;
  }
  function needKey() {
    if (key()) return false;
    toast("「設定」で Gemini APIキーを入力してください");
    show("settings"); $("setKey").focus();
    return true;
  }

  // 見出し・箇条書き・太字・リンクだけの、小さな Markdown 表示
  function md(text) {
    const inline = (s) => E(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out = []; let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { close(); continue; }
      if ((m = line.match(/^\s*#{1,6}\s+(.*)$/))) { close(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      close(); out.push(`<p>${inline(line)}</p>`);
    }
    close();
    return out.join("");
  }
  function answerHTML(ans) {
    if (!ans || !ans.text) return "";
    let meta = `${E(ans.at || "")} 作成・${E(ans.model || "")}`;
    if ("searched" in ans) meta += ans.searched ? "・Google検索で確認済み" : "・保存した環境メモをもとに回答";
    const src = (ans.sources || []).slice(0, 8).map((s) => `<li><a href="${E(s.url)}" target="_blank" rel="noopener">${E(s.title)}</a></li>`).join("");
    return `<div class="md">${md(ans.text)}</div><div class="meta-line">${meta}</div>` +
      (src ? `<details class="sources"><summary>参照したページ</summary><ul class="plain">${src}</ul></details>` : "");
  }

  // 文章の回答を、書けたところから順に表示する
  async function streamInto(el, prompt, { search = false } = {}) {
    el.innerHTML = `<div class="md cursor"><p style="color:var(--muted)">考えています…</p></div>`;
    try {
      const r = await Core.ask({
        apiKey: key(), model: model(), system: sys(), prompt, search, stream: true,
        onRestart: () => { el.innerHTML = `<div class="md cursor"></div>`; },
        onText: (_, all) => { el.innerHTML = `<div class="md cursor">${md(all)}</div>`; },
        onNote: (n) => { el.innerHTML = `<div class="md cursor"><p style="color:var(--muted)">${E(n)}</p></div>`; },
      });
      if (!r.text) throw new Core.AIError("回答が空でした。もう一度試してください。");
      el.innerHTML = answerHTML(r);
      return r;
    } catch (e) {
      el.innerHTML = `<div class="notice warn">${E(e.message)}</div>`;
      return null;
    }
  }

  // ================================================================ 環境の確認（決めた順番の「手順③」）
  let metaJob = null;
  const metaFresh = (days) => { const a = Core.metaAgeDays(store); return a !== null && a <= days; };

  const AUTO_RETRY_HOURS = 6;
  function autoMetaAllowed() {
    const t = store.meta_last_try ? new Date(store.meta_last_try).getTime() : 0;
    return Date.now() - t > AUTO_RETRY_HOURS * 3600 * 1000;
  }
  function refreshMeta(onNote, { manual = false } = {}) {
    if (metaJob) return metaJob;
    metaJob = (async () => {
      setTop("環境を更新中…", true);
      try {
        // ① まず Limitless の大会結果を直接集計（AIの無料枠を使わない・最新）
        try {
          const r = await Core.limitlessMeta(window.fetch.bind(window), { onNote });
          store.meta_notes = r.text; store.meta_updated_at = r.at.slice(0, 10); store.meta_sources = r.sources; store.meta_source = "limitless";
          await save(); renderMeta();
          return { ok: true, detail: `Limitless の大会結果から環境メモを更新しました（${r.sources.length}大会）` };
        } catch (e) {
          onNote && onNote(`Limitless から取得できませんでした（${e.message}）。AIの検索に切り替えます…`);
        }
        // ② だめなときだけ、AIのGoogle検索で調べる
        if (!key()) return { ok: false, detail: "環境を更新できなかったため、保存済みの環境メモを使います" };
        // AIの検索は無料枠を使うので、自動のときは失敗後6時間あける
        if (!manual && !autoMetaAllowed()) return { ok: false, detail: "少し前にAIの検索に失敗したため、保存済みの環境メモを使います" };
        store.meta_last_try = new Date().toISOString(); save();
        const r = await Core.ask({ apiKey: key(), model: model(), system: sys(), prompt: Core.metaResearchPrompt(store.regulation), search: true, onNote });
        if (r.searched && r.text) {
          store.meta_notes = r.text; store.meta_updated_at = r.at.slice(0, 10); store.meta_sources = r.sources; store.meta_source = "ai";
          await save(); renderMeta();
          return { ok: true, detail: `環境メモを更新しました（参照 ${r.sources.length} ページ）` };
        }
        return { ok: false, detail: "検索結果を得られなかったため、保存済みの環境メモを使います" };
      } catch (e) {
        return { ok: false, detail: `環境の更新に失敗したため、保存済みの環境メモを使います（${e.message}）` };
      } finally { metaJob = null; setTop(); }
    })();
    return metaJob;
  }
  // 7日以内なら最新とみなす。古ければ先に検索して更新。裏で更新中ならそれを待つ
  async function ensureMeta(onNote) {
    if (metaJob) { onNote && onNote("環境の更新を待っています…"); return await metaJob; }
    if (metaFresh(7)) return { ok: true, detail: `環境メモは ${store.meta_updated_at} 更新の最新版です` };
    onNote && onNote("環境メモが古いため、先に最新の大会結果を検索しています…");
    return await refreshMeta(onNote);
  }

  // ================================================================ 画面の切り替え
  function show(tab) {
    document.querySelectorAll("[data-view]").forEach((s) => { s.hidden = s.id !== "v-" + tab; });
    document.querySelectorAll(".tabs button").forEach((btn) => {
      if (btn.dataset.tab === tab) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
    });
    if (tab === "settings") $("gearBtn").setAttribute("aria-current", "page"); else $("gearBtn").removeAttribute("aria-current");
    if (tab === "history") renderHistory();
    if (tab === "decks") renderDecks();
    if (tab === "strategy") renderStrategy();
    if (tab === "meta") renderMeta();
    if (tab === "settings") renderSettings();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(".tabs button").forEach((btn) => btn.addEventListener("click", () => show(btn.dataset.tab)));
  $("gearBtn").addEventListener("click", () => show("settings"));

  // ================================================================ 検討：入力
  function renderDeckSelect(sel, withNone) {
    const names = Object.keys(store.decks);
    const cur = sel.value;
    sel.innerHTML = (withNone ? `<option value="">指定しない</option>` : "") + names.map((n) => `<option>${E(n)}</option>`).join("");
    if (names.includes(cur)) sel.value = cur; else if (store.settings.last_deck && names.includes(store.settings.last_deck)) sel.value = store.settings.last_deck;
  }
  // どちらが自分か：ログの視点 → プレイヤー名 → 選んだデッキの一致、の順で判定（手動で切り替えも可）
  function detectMe(parsed) {
    return Core.identifyMe(parsed, { playerName: store.settings.player_name, deckText: store.decks[$("logDeck").value] || "" });
  }
  function updateLogInfo() {
    const raw = $("logText").value;
    $("analyzeBtn").disabled = !raw.trim();
    const meSel = $("logMe");
    if (!raw.trim()) { $("logInfo").textContent = ""; $("meRow").hidden = true; meSel.dataset.manual = ""; return; }
    const p = Core.parseLog(raw);
    if (!p.ok) { $("logInfo").textContent = "ターンの区切りを読み取れませんでしたが、このまま評価できます"; $("meRow").hidden = true; return; }
    const id = detectMe(p);
    const key2 = p.players.join("|");
    if (meSel.dataset.players !== key2) {
      meSel.innerHTML = p.players.map((n) => `<option>${E(n)}</option>`).join("");
      meSel.dataset.players = key2; meSel.dataset.manual = "";
    }
    if (!meSel.dataset.manual) meSel.value = id.me;
    $("meRow").hidden = false;
    const me = meSel.value, f = Core.extractFacts(p, me), last = f.turns[f.turns.length - 1];
    const how = meSel.dataset.manual ? "手動で選択" : { "ログの視点": "ログの視点から判定", "プレイヤー名": "設定のプレイヤー名から判定", "デッキの一致": "選んだデッキから判定", "推測": "推測" }[id.how];
    let t = `${p.turns.length}ターン読み取り：自分＝${me}（${how}）・${f.went_first}・${f.result}・最終サイド残り 自分${last.my_left}枚／相手${last.opp_left}枚`;
    const dm = id.deckMatch, opp = f.opp;
    if (dm && dm[opp] > dm[me]) t += `\n⚠ 選んだデッキのカードは ${opp} 側に多く出ています。デッキか「自分」の選択を確認してください`;
    $("logInfo").textContent = t;
  }
  $("logMe").addEventListener("change", () => { $("logMe").dataset.manual = "1"; updateLogInfo(); });
  $("logDeck").addEventListener("change", updateLogInfo);
  $("logText").addEventListener("input", updateLogInfo);
  $("pasteBtn").addEventListener("click", async () => {
    try { $("logText").value = await navigator.clipboard.readText(); updateLogInfo(); }
    catch (_) { toast("貼り付けできませんでした。入力欄を長押しして「ペースト」してください"); }
  });
  $("analyzeBtn").addEventListener("click", runPipeline);

  // ================================================================ 検討：決めた順番で実行する
  const STEPS = ["ログの読み取り", "自分と相手の判定、事実の抜き出し", "環境の確認", "形勢の評価と示唆", "事実との照合と保存"];
  function setStep(i, state, detail) {
    const li = $("steps").children[i]; if (!li) return;
    li.className = state;
    if (detail != null) li.querySelector(".d").textContent = detail;
  }

  async function runPipeline() {
    if (needKey()) return;
    const raw = $("logText").value, extra = $("logExtra").value.trim();
    const deckName = $("logDeck").value, deckText = store.decks[deckName] || "";
    store.settings.last_deck = deckName;
    $("composer").hidden = true; $("result").innerHTML = ""; $("progress").hidden = false;
    $("steps").innerHTML = STEPS.map((s, i) => `<li><span class="dot">${i + 1}</span><span><span class="t">${E(s)}</span><span class="d"></span></span></li>`).join("");
    window.scrollTo(0, 0);
    const started = Date.now();

    // ① ログの読み取り
    setStep(0, "active");
    const parsed = Core.parseLog(raw);
    setStep(0, "done", parsed.ok ? `${parsed.turns.length}ターンを読み取りました` : "ターンの区切りは読めませんでしたが、続けます");

    // ② 事実の抜き出し
    setStep(1, "active");
    const me = $("logMe").value || detectMe(parsed).me;
    const facts = Core.extractFacts(parsed, me);
    const digest = Core.factsDigest(facts);
    const last = facts.turns[facts.turns.length - 1];
    setStep(1, "done", last ? `自分＝${facts.me}（${deckName || "デッキ未指定"}）・相手＝${facts.opp}\n${facts.went_first}・${facts.result}・最終サイド残り 自分${last.my_left}枚／相手${last.opp_left}枚` : "");

    // ③ 環境の確認（古ければ先に検索して更新）
    setStep(2, "active", "確認しています…");
    const meta = await ensureMeta((n) => setStep(2, "active", n));
    setStep(2, meta.ok ? "done" : "warn", meta.detail);

    // ④ 盤面の再現と形勢の評価（1回の呼び出しで、ターンごとに「盤面 → 評価 → 最善手」の順に書かせる）
    const N = facts.turns.length;
    setStep(3, "active", "考えています…");
    const prompt = Core.analysisPrompt({ log: Core.formatLogForAI(parsed, raw), me: facts.me, opp: facts.opp, deckName, deck: deckText, meta: store.meta_notes, extra, digest });
    let analysis = null, used = "", failure = "";
    for (let attempt = 0; attempt < 2 && !analysis; attempt++) {
      try {
        const r = await Core.ask({
          apiKey: key(), model: model(), system: sys(), prompt, schema: Core.ANALYSIS_SCHEMA, stream: true, temperature: 0.3,
          onNote: (n) => setStep(3, "active", n),
          onText: (_, all) => {
            if (all.includes('"swing_points"')) { setStep(3, "active", "全ターンの評価が終わりました。勝敗を分けたポイントをまとめています…"); return; }
            const k = (all.match(/"situation"/g) || []).length;
            if (k) setStep(3, "active", `${N ? Math.min(k, N) + " / " + N : k} ターン目を評価しています…`);
          },
        });
        const a = Core.parseJSON(r.text);
        if (!a.turns || !a.turns.length) throw new Core.AIError("ターンごとの評価が空でした");
        analysis = a; used = r.model;
      } catch (e) {
        failure = e.message;
        if (attempt === 0 && !/APIキー|上限|通信/.test(e.message)) setStep(3, "active", "返答をうまく読み取れなかったので、もう一度検討しています…");
        else break;
      }
    }
    setStep(3, analysis ? "done" : "warn", analysis ? `${analysis.turns.length}ターンを評価しました` : `AIの検討に失敗しました（${failure}）。サイド差だけで形勢を出します`);

    // ⑤ 事実との照合と保存
    setStep(4, "active");
    if (analysis) analysis = Core.mergeWithFacts(analysis, facts);
    else if (N) { analysis = Core.fallbackAnalysis(facts); used = "自動評価"; }
    if (!analysis) { setStep(4, "warn", "検討できませんでした。ログを確認してください"); $("composer").hidden = false; return; }
    const rec = {
      id: Math.random().toString(16).slice(2, 10), created_at: Core.nowStamp(), deck_name: deckName,
      raw_log: raw, extra_notes: extra, model: used, analysis,
    };
    store.analyses.unshift(rec); store.current_id = rec.id;
    await save();
    setStep(4, "done", `保存しました（${Math.round((Date.now() - started) / 1000)}秒）`);
    $("logText").value = ""; $("logExtra").value = ""; updateLogInfo();
    resultFrom = "review";
    setTimeout(() => { $("progress").hidden = true; renderResult(rec); }, 600);
  }

  // ================================================================ 検討：結果の表示
  const evClass = (s) => ({ 2: "s2", 1: "s1", 0: "s0", "-1": "sm1", "-2": "sm2" }[Core.clamp(s)]);
  const COL = { me: "#5AA9FF", opp: "#FF7A66", gold: "#F2C14E", ink: "#E9EDF6", muted: "#93A0BD", line: "#2C3858", grid: "#232E4B" };

  function meterHTML(score) {
    const s = Core.clamp(score), pos = (s + 2) / 4 * 100;
    const dim = s > 0 ? `<i style="left:0;width:50%"></i><i style="left:${pos}%;right:0"></i>`
      : s < 0 ? `<i style="left:0;width:${pos}%"></i><i style="left:50%;right:0"></i>`
        : `<i style="left:0;width:49%"></i><i style="left:51%;right:0"></i>`;
    return `<div class="meter"><div class="now">最終盤面<b style="color:${s >= 0 ? (s ? COL.me : COL.muted) : COL.opp}">${s > 0 ? "+" : ""}${s}</b>${Core.evalLabel(s)}</div>
      <div class="bar">${dim}</div><div class="scale"><span>相手優勢</span><span>互角</span><span>自分優勢</span></div></div>`;
  }

  let chartSeq = 0;
  function chartSVG(turns, swings) {
    const W = 340, H = 176, L = 34, R = 8, T = 12, B = 24, n = turns.length;
    const x = (i) => L + (n <= 1 ? 0 : (W - L - R) * i / (n - 1));
    const y = (s) => T + (H - T - B) * (2 - Core.clamp(s)) / 4;
    const mid = y(0), id = "c" + (++chartSeq);
    const pts = turns.map((t, i) => `${x(i).toFixed(1)},${y(t.score).toFixed(1)}`).join(" ");
    const area = `${x(0)},${mid} ${pts} ${x(n - 1)},${mid}`;
    const grid = [2, 1, -1, -2].map((s) => `<line x1="${L}" y1="${y(s)}" x2="${W - R}" y2="${y(s)}" stroke="${COL.grid}"/>`).join("");
    const sw = turns.map((t, i) => (swings.has(t.turn) ? `<line x1="${x(i)}" y1="${T - 4}" x2="${x(i)}" y2="${H - B + 4}" stroke="${COL.gold}" stroke-dasharray="4 4"/>` : "")).join("");
    const dots = turns.map((t, i) => `<circle cx="${x(i)}" cy="${y(t.score)}" r="4.5" fill="${t.player === "自分" ? COL.me : COL.opp}"/>`).join("");
    const step = Math.max(1, Math.ceil(n / 8));
    const xl = turns.map((t, i) => (i % step === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${t.turn}</text>` : "")).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="形勢グラフ"><defs>
      <clipPath id="${id}t"><rect x="0" y="0" width="${W}" height="${mid}"/></clipPath>
      <clipPath id="${id}b"><rect x="0" y="${mid}" width="${W}" height="${H - mid}"/></clipPath></defs>
      ${grid}
      <polygon clip-path="url(#${id}t)" fill="${COL.me}" fill-opacity=".28" points="${area}"/>
      <polygon clip-path="url(#${id}b)" fill="${COL.opp}" fill-opacity=".28" points="${area}"/>
      <line x1="${L}" y1="${mid}" x2="${W - R}" y2="${mid}" stroke="${COL.line}"/>${sw}
      <polyline fill="none" stroke="${COL.ink}" stroke-width="1.7" stroke-linejoin="round" points="${pts}"/>${dots}
      <g font-size="11" fill="${COL.muted}" font-family="Zen Kaku Gothic New, sans-serif" text-anchor="end">
        <text x="${L - 6}" y="${y(2) + 4}">優勢</text><text x="${L - 6}" y="${mid + 4}">互角</text><text x="${L - 6}" y="${y(-2) + 4}">劣勢</text></g>
      <g font-size="12" fill="${COL.muted}" font-family="Barlow Condensed, sans-serif">${xl}</g></svg>`;
  }

  let resultFrom = "review"; // 結果を閉じたときに戻る画面

  function renderResult(rec) {
    const el = $("result");
    if (!rec) { el.innerHTML = ""; $("composer").hidden = false; return; }
    $("composer").hidden = true;
    const a = rec.analysis, turns = (a.turns || []).slice().sort((p, q) => p.turn - q.turn);
    const aiSw = new Map((a.swing_points || []).map((s) => [Number(s.turn), s]));
    const swings = new Set([...aiSw.keys(), ...Core.detectSwings(turns)]);
    const rc = a.result === "勝ち" ? COL.me : a.result === "負け" ? COL.opp : COL.muted;
    const why = a.result === "負け" ? "敗因" : a.result === "勝ち" ? "勝因" : "総評";
    let h = `<div class="resbar"><button class="link" data-act="close" type="button">← 閉じる</button>
        <button class="link" data-act="new" type="button">＋ 別のバトルを評価</button></div>
      <div class="verdict"><div class="top2"><div class="result" style="color:${rc}">${E(a.result || "不明")}</div>
      <div class="facts"><span>自分のデッキ<b>${E(rec.deck_name || "指定なし")}</b></span><span>相手のデッキ<b>${E(a.opponent_deck_guess || "不明")}</b></span>
      <span>手番<b>${E(a.went_first || "不明")}</b></span><span>相手<b>${E(a.opponent_name || "-")}</b></span></div></div></div>`;
    if (rec.model === "自動評価") h += `<div class="notice warn"><b>AIの評価を取得できなかったため、サイド差だけで形勢を表示しています。</b>少し時間をおいて、同じログでもう一度評価してください。</div>`;
    if (a.overall_summary) h += `<h2>${why}</h2><p class="summary">${E(a.overall_summary)}</p>`;

    h += `<h2>勝敗を分けたポイント</h2>`;
    if (!swings.size) h += `<div class="empty">大きく形勢が傾いた場面はありませんでした。</div>`;
    for (const t of [...swings].sort((p, q) => p - q)) {
      const s = aiSw.get(t), row = turns.find((x) => x.turn === t) || {};
      const dd = (rec.deep_dives || {})[t];
      h += `<div class="swing"><div class="head"><span class="t">T${t}</span>${s ? `<span class="conf">確度 ${E(s.confidence || "-")}</span>` : ""}</div>`;
      if (s) {
        h += `<p>${E(s.what_happened)}</p><span class="k">すべきだった手</span><div class="play">${E(s.better_play)}</div>
          <span class="k">理由</span><p style="margin-top:2px">${E(s.why)}</p>`;
        if ((s.alternative_line || []).length) h += `<span class="k">手順</span><ol>${s.alternative_line.map((x) => `<li>${E(x)}</li>`).join("")}</ol>`;
      } else {
        h += `<p>形勢が大きく下がったターンです。${E(row.situation || row.reason || "")}</p><span class="k">示唆</span><div class="play">${E(row.advice || row.better_play || "下のボタンで詳しく検討できます")}</div>`;
      }
      h += `<button class="btn" data-act="deep" data-turn="${t}" type="button">T${t} を深掘りする</button>
        <div class="deep" id="deep-${t}">${dd ? answerHTML(dd) : ""}</div></div>`;
    }

    if (turns.length) {
      h += `<h2>ターン別の形勢</h2>` + meterHTML(turns[turns.length - 1].score);
      h += `<div class="chart">${chartSVG(turns, swings)}</div>
        <div class="legend"><span><span style="color:${COL.me}">●</span> 自分の番</span><span><span style="color:${COL.opp}">●</span> 相手の番</span><span><span style="color:${COL.gold}">┆</span> 形勢が傾いたターン</span></div>`;
      h += `<h2>ターン別の評価と示唆</h2><div class="record">`;
      for (const t of turns) {
        const pl = t.prizes_left, mine = t.player === "自分";
        const advice = t.advice || t.better_play || "", sit = t.situation || t.reason || t.summary || "";
        h += `<div class="trow"><div class="r1"><span class="n">T${t.turn}</span><span class="who ${mine ? "me" : "opp"}">${E(t.player)}</span>
          <span class="ev ${evClass(t.score)}">${Core.evalLabel(t.score)}</span>${swings.has(t.turn) ? `<span class="flag">◆ 転換点</span>` : ""}</div>
          ${advice ? `<p class="advice ${mine ? "mine" : ""}">${E(advice)}</p>` : ""}
          <p class="sit">${E(sit)}${pl ? `${sit ? "　" : ""}サイド残り 自分${pl[0]}・相手${pl[1]}` : ""}</p></div>`;
      }
      h += `</div>`;
    }
    if ((a.lessons || []).length) h += `<h2>次の対戦に活かすこと</h2><ul class="plain">${a.lessons.map((x) => `<li>${E(x)}</li>`).join("")}</ul>`;
    h += `<div class="row2" style="margin-top:28px"><button class="btn" data-act="close" type="button">閉じる</button><button class="btn" data-act="delete" type="button">このバトルを削除</button></div>`;
    el.innerHTML = h;
    el.dataset.id = rec.id;
  }

  function closeResult() {
    store.current_id = null; save();
    renderResult(null);
    if (resultFrom === "history") show("history"); else window.scrollTo(0, 0);
  }

  $("result").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-act]"); if (!btn) return;
    const rec = store.analyses.find((r) => r.id === $("result").dataset.id);
    if (btn.dataset.act === "close") { closeResult(); return; }
    if (btn.dataset.act === "new") { resultFrom = "review"; store.current_id = null; renderResult(null); window.scrollTo(0, 0); $("logText").focus(); return; }
    if (!rec) return;
    if (btn.dataset.act === "delete") {
      if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "もう一度押すと削除します"; return; }
      store.analyses = store.analyses.filter((r) => r.id !== rec.id); store.current_id = null;
      await save(); toast("削除しました"); closeResult(); return;
    }
    if (btn.dataset.act === "deep") {
      if (needKey()) return;
      const t = Number(btn.dataset.turn); btn.disabled = true;
      const r = await streamInto($("deep-" + t), Core.deepDivePrompt(rec.analysis, t, Core.formatLogForAI(Core.parseLog(rec.raw_log), rec.raw_log), store.decks[rec.deck_name] || ""));
      btn.disabled = false;
      if (r) { rec.deep_dives = rec.deep_dives || {}; rec.deep_dives[t] = { text: r.text, model: r.model, at: r.at }; await save(); }
    }
  });

  // ================================================================ 履歴
  function renderHistory() {
    const el = $("v-history"), recs = store.analyses;
    if (!recs.length) { el.innerHTML = `<h2>バトル履歴</h2><div class="empty">まだ評価したバトルがありません。「バトル評価」タブでバトルログを貼り付けると、ここに貯まっていきます。</div>`; return; }
    const res = recs.map((r) => r.analysis.result);
    const w = res.filter((x) => x === "勝ち").length, l = res.filter((x) => x === "負け").length;
    const mu = {};
    for (const r of recs) {
      if (!["勝ち", "負け"].includes(r.analysis.result)) continue;
      const k = r.analysis.opponent_deck_guess || "不明"; mu[k] = mu[k] || [0, 0]; mu[k][r.analysis.result === "勝ち" ? 0 : 1]++;
    }
    let h = `<h2>成績</h2><div class="stats"><div>勝ち<b>${w}</b></div><div>負け<b>${l}</b></div><div>勝率<b>${w + l ? Math.round(w / (w + l) * 100) : 0}%</b></div></div>`;
    const muRows = Object.entries(mu).sort((p, q) => (q[1][0] + q[1][1]) - (p[1][0] + p[1][1]));
    if (muRows.length) h += `<h2>相手デッキ別</h2><div class="mu">${muRows.map(([k, v]) => `<div><span>${E(k)}</span><span><b>${v[0]}</b>勝<b>${v[1]}</b>敗</span></div>`).join("")}</div>`;
    h += `<h2>バトル一覧</h2><div class="list">${recs.map((r) => {
      const c = r.analysis.result === "勝ち" ? COL.me : r.analysis.result === "負け" ? COL.opp : COL.muted;
      return `<button type="button" data-id="${E(r.id)}"><span class="res" style="color:${c}">${E(r.analysis.result || "-")}</span>
        <span class="main"><b>vs ${E(r.analysis.opponent_deck_guess || "不明")}</b><span class="sub">${E(r.created_at)}・${E(r.deck_name || "デッキ指定なし")}</span></span><span class="chev">›</span></button>`;
    }).join("")}</div>`;
    el.innerHTML = h;
  }
  $("v-history").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-id]"); if (!btn) return;
    const rec = store.analyses.find((r) => r.id === btn.dataset.id); if (!rec) return;
    store.current_id = rec.id; resultFrom = "history"; show("review"); $("progress").hidden = true; renderResult(rec);
  });

  // ================================================================ デッキ
  let deckSel = "";
  function renderDecks() {
    const names = Object.keys(store.decks);
    if (deckSel && !names.includes(deckSel)) deckSel = "";
    $("deckChips").innerHTML = names.map((n) => `<button class="chip" type="button" data-deck="${E(n)}" aria-pressed="${n === deckSel}">${E(n)}</button>`).join("") +
      `<button class="chip" type="button" data-deck="" aria-pressed="${!deckSel}">＋ 新しいデッキ</button>`;
    $("deckName").value = deckSel; $("deckText").value = deckSel ? store.decks[deckSel] : "";
    $("deckDelete").hidden = !deckSel;
    updateDeckCount();
  }
  function updateDeckCount() {
    const t = $("deckText").value;
    if (!t.trim()) { $("deckCount").innerHTML = ""; return; }
    const d = Core.parseDeck(t), c = d.counts, ok = d.total === 60 ? "ok" : "ng";
    $("deckCount").innerHTML = `<div>ポケモン<b>${c.pokemon}</b></div><div>トレーナーズ<b>${c.trainer}</b></div><div>エネルギー<b>${c.energy}</b></div><div class="${ok}">合計<b>${d.total}</b></div>`;
  }
  $("deckText").addEventListener("input", updateDeckCount);
  $("deckChips").addEventListener("click", (ev) => { const c = ev.target.closest("[data-deck]"); if (!c) return; deckSel = c.dataset.deck; renderDecks(); });
  $("deckSave").addEventListener("click", async () => {
    const name = $("deckName").value.trim(), text = $("deckText").value.trim();
    if (!name || !text) { toast("デッキ名とデッキリストを入力してください"); return; }
    if (deckSel && deckSel !== name) { delete store.decks[deckSel]; }
    store.decks[name] = text; deckSel = ""; await save(); renderDecks(); renderDeckSelect($("logDeck"), true);
    toast(`「${name}」を登録しました`); window.scrollTo(0, 0);
  });
  $("deckDelete").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "もう一度押すと削除"; setTimeout(() => { btn.dataset.confirm = ""; btn.textContent = "削除"; }, 3000); return; }
    delete store.decks[deckSel]; deckSel = ""; btn.dataset.confirm = ""; btn.textContent = "削除";
    await save(); renderDecks(); renderDeckSelect($("logDeck"), true); toast("削除しました");
  });

  // ================================================================ デッキ別の戦い方・展開
  // 戦い方の解説・環境アドバイス：①環境を確認 → ②最新の環境メモを前提に回答
  let strategyDeck = "";
  function renderStrategy() {
    const el = $("strategyArea"), names = Object.keys(store.decks);
    if (!names.length) { el.innerHTML = `<div class="empty">「デッキ登録」でデッキを登録すると、デッキ別の戦い方・展開と、環境を踏まえたアドバイスを出せます。</div>`; return; }
    if (!names.includes(strategyDeck)) strategyDeck = names.includes(store.settings.last_deck) ? store.settings.last_deck : names[0];
    el.innerHTML = `<label class="f" for="sDeck" style="margin-top:0">デッキ</label>
      <select id="sDeck">${names.map((n) => `<option ${n === strategyDeck ? "selected" : ""}>${E(n)}</option>`).join("")}</select>
      <h2>戦い方・展開</h2>
      <label class="f" for="gFocus">特に知りたいこと（任意）</label><input type="text" id="gFocus" placeholder="後攻1ターン目の動き、ドラパルト対面 など">
      <button class="btn primary" type="button" data-go="guides">戦い方・展開を解説してもらう</button>
      <p class="hint" id="guidesNote"></p><div id="guidesOut">${answerHTML((store.guides || {})[strategyDeck])}</div>
      <h2>環境を踏まえたアドバイス</h2>
      <p class="hint">「環境」タブの最新の大会結果をもとに、相性・対策・構築の調整案を出します。</p>
      <button class="btn primary" type="button" data-go="meta_advice">アドバイスをもらう</button>
      <p class="hint" id="meta_adviceNote"></p><div id="meta_adviceOut">${answerHTML((store.meta_advice || {})[strategyDeck])}</div>`;
  }
  $("strategyArea").addEventListener("change", (ev) => {
    if (ev.target.id === "sDeck") { strategyDeck = ev.target.value; renderStrategy(); }
  });
  $("strategyArea").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-go]"); if (!btn) return;
    if (needKey()) return;
    const kind = btn.dataset.go, deckName = strategyDeck, deck = store.decks[deckName];
    btn.disabled = true;
    const note = $(kind + "Note");
    const m = await ensureMeta((n) => { note.textContent = n; });
    note.textContent = m.ok ? "" : m.detail;
    const prompt = kind === "guides" ? Core.deckGuidePrompt(deck, store.meta_notes, ($("gFocus") || {}).value || "") : Core.metaAdvicePrompt(deck, store.meta_notes);
    const r = await streamInto($(kind + "Out"), prompt, { search: !m.ok }); // 環境を更新できなかったときだけ、回答中に検索させる
    btn.disabled = false;
    if (r) { store[kind] = store[kind] || {}; store[kind][deckName] = { text: r.text, model: r.model, at: r.at, searched: r.searched, sources: r.sources }; await save(); }
  });

  // ================================================================ 環境
  function renderMeta() {
    const age = Core.metaAgeDays(store);
    const src = store.meta_sources || [];
    $("metaStatus").innerHTML = `<div class="notice ${age === null || age > 7 ? "warn" : ""}"><b>最終更新：${E(store.meta_updated_at || "未設定")}${age !== null ? `（${age}日前）` : ""}</b><br>
      ${age === null || age > 7 ? "古くなっています。バトル評価やアドバイスの前に自動で更新されます。" : "バトル評価・アドバイスは、この環境メモを前提に行います。"}
      ${store.meta_source === "limitless" ? "<br>出典：Limitless Play の大会結果（アプリが直接集計）" : ""}
      ${src.length ? `<details class="sources"><summary>参照したページ（${src.length}）</summary><ul class="plain">${src.slice(0, 8).map((s) => `<li><a href="${E(s.url)}" target="_blank" rel="noopener">${E(s.title)}</a></li>`).join("")}</ul></details>` : ""}</div>`;
    $("metaNotes").innerHTML = md(store.meta_notes);
    $("metaEditText").value = store.meta_notes;
  }
  $("metaRefresh").addEventListener("click", async (ev) => {
    if (needKey()) return;
    const btn = ev.currentTarget; btn.disabled = true; btn.textContent = "検索しています…";
    const r = await refreshMeta((n) => { btn.textContent = n; }, { manual: true });
    btn.disabled = false; btn.textContent = "最新の環境を調べる";
    toast(r.ok ? "環境メモを更新しました" : r.detail); renderMeta();
  });
  $("metaEditToggle").addEventListener("click", () => { $("metaEdit").hidden = !$("metaEdit").hidden; });
  $("metaEditSave").addEventListener("click", async () => {
    store.meta_notes = $("metaEditText").value; await save(); renderMeta(); $("metaEdit").hidden = true; toast("環境メモを保存しました");
  });

  // ================================================================ 設定
  function renderSettings() {
    $("setKey").value = store.settings.api_key || "";
    $("setModel").innerHTML = Core.MODELS.map((m) => `<option ${m === model() ? "selected" : ""}>${m}</option>`).join("");
    $("setName").value = store.settings.player_name || "";
    $("setReg").value = store.regulation;
  }
  const bindSetting = (id, keyName) => $(id).addEventListener("change", async () => {
    store.settings[keyName] = $(id).value.trim(); await save(); toast("保存しました");
    if (keyName === "api_key" && key() && !metaFresh(1)) refreshMeta();
  });
  bindSetting("setKey", "api_key"); bindSetting("setModel", "model"); bindSetting("setName", "player_name");
  $("setRegSave").addEventListener("click", async () => { store.regulation = $("setReg").value.trim() || Core.DEFAULT_REGULATION; await save(); toast("保存しました"); });

  $("exportBtn").addEventListener("click", async () => {
    const data = JSON.parse(JSON.stringify(store)); data.settings.api_key = ""; // キーはバックアップに含めない
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const name = `ptcgl_backup_${Core.nowStamp().slice(0, 10)}.json`;
    try {
      const file = new File([blob], name, { type: "application/json" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "PTCGL検討のバックアップ" }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  });
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || typeof data !== "object" || !("decks" in data || "analyses" in data)) throw new Error("形式が違います");
      const keep = { api_key: store.settings.api_key, model: store.settings.model };
      const base = Core.defaultStore(); Object.assign(base, data);
      base.settings = Object.assign(Core.defaultStore().settings, data.settings || {}, keep.api_key ? { api_key: keep.api_key } : {});
      store = base; await save(); renderAll(); toast(`読み込みました（デッキ${Object.keys(store.decks).length}・対局${store.analyses.length}）`);
    } catch (e) { toast("読み込めませんでした。このアプリのバックアップファイルか確認してください"); }
    ev.target.value = "";
  });

  // ================================================================ 起動
  function renderAll() {
    renderDeckSelect($("logDeck"), true); updateLogInfo(); setTop(); renderSettings(); renderMeta();
    const cur = store.analyses.find((r) => r.id === store.current_id);
    $("progress").hidden = true; renderResult(cur || null);
  }

  (async function boot() {
    await load();
    renderAll();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) { /* 任意 */ }
    if ("serviceWorker" in navigator) {
      // 新しい版が公開されていたら、すぐ切り替えて1回だけ読み込み直す
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded) { reloaded = true; location.reload(); } });
      navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => reg.update()).catch(() => {});
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
      });
    }
    if (!key()) { show("settings"); toast("最初に Gemini APIキーを入力してください"); }
    // 環境メモが1日以上前なら、ログを貼っている間に裏で更新しておく（Limitless の集計はAIの無料枠を使わない）
    if (!metaFresh(1)) refreshMeta();
  })();
})();
