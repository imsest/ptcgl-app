/* PTCGL 対局検討 — ロジック部分（画面以外）
 * ・デッキとバトルログの読み取り
 * ・ログから確実な事実（サイド・きぜつ・ワザ）を抜き出す
 * ・Gemini への問い合わせ（自動リトライ／モデル切替／ストリーミング／Google検索）
 * ・プロンプト
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ 形勢の定義
  const EVAL_LABELS = { 2: "優勢", 1: "やや優勢", 0: "互角", "-1": "やや劣勢", "-2": "劣勢" };
  const clamp = (n) => Math.max(-2, Math.min(2, Math.round(Number(n) || 0)));
  const evalLabel = (s) => EVAL_LABELS[clamp(s)];

  const DEFAULT_REGULATION =
    "スタンダード（2026-27シーズン）：レギュレーションマーク H・I・J 以降のカードのみ使用可能。" +
    "G マークのカードは 2026年3月26日（PTCGL）／4月10日（公式大会）のローテーションで使用不可。";

  const DEFAULT_META_NOTES = `【初期データ：2026年8月下旬時点の上位デッキ（使用率順）】
1. メガドリュウズex（Mega Excadrill ex）
2. ドラパルトex
3. Festival Lead
4. ドラパルトex / バシャーモex
5. ヤドキング（Slowking）
6. フーディン / ノココッチ（Alakazam / Dudunsparce）
7. ドラパルトex / ヨノワール
8. N のゾロアーク
9. オーロンゲ / ユキメノコ（Grimmsnarl / Froslass）
10. ダダリン（Dhelmise）
※出典：GeekyDomain Standard Meta Tier List（2026-08-31）。アプリが自動で最新に更新します。`;

  const pad = (n) => String(n).padStart(2, "0");
  const nowStamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const todayJa = () => { const d = new Date(); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };

  function metaAgeDays(store) {
    const s = (store.meta_updated_at || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const then = new Date(s + "T00:00:00");
    const now = new Date(); now.setHours(0, 0, 0, 0);
    return Math.round((now - then) / 86400000);
  }

  function defaultStore() {
    return {
      settings: { player_name: "", api_key: "", model: "gemini-flash-latest" },
      decks: {}, regulation: DEFAULT_REGULATION, meta_notes: DEFAULT_META_NOTES,
      meta_updated_at: "2026-08-31", meta_sources: [], analyses: [], guides: {}, meta_advice: {},
    };
  }

  // ------------------------------------------------------------------ デッキ
  const CAT = [
    ["pokemon", /^(pok[eé]mon|ポケモン)\s*[:：]/i],
    ["trainer", /^(trainer|トレーナーズ|グッズ|サポート)\s*[:：]/i],
    ["energy", /^(energy|エネルギー)\s*[:：]/i],
  ];
  function parseDeck(text) {
    const r = { pokemon: [], trainer: [], energy: [], other: [] };
    let cur = "other";
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^total cards/i.test(line)) continue;
      const c = CAT.find(([, re]) => re.test(line));
      if (c) { cur = c[0]; continue; }
      const m = line.match(/^\*?\s*(\d+)\s+(.+?)\s*$/);
      if (m) r[cur].push({ count: +m[1], name: m[2] });
    }
    const counts = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.reduce((a, c) => a + c.count, 0)]));
    return { ...r, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  }

  // ------------------------------------------------------------------ バトルログ
  // 実際のPTCGL：「S_Tobari's Turn」（番号なし）／旧形式・表記ゆれ：「Turn # 3 - Name's Turn」「〇〇のターン」
  const RE_TURN_NUM = /^\s*(?:Turn|ターン)\s*#?\s*(\d+)\s*[-–—:：]\s*(.+?)\s*(?:'s Turn|’s Turn|のターン)?\s*$/i;
  const RE_TURN = /^\s*(\S+?)\s*(?:'s Turn|’s Turn|のターン)\s*$/i;
  const RE_END = /(wins\.|won the game|conceded|降参|勝利|の勝ち)/i;

  function parseLog(text) {
    const setup = [], turns = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) continue;
      let m = line.match(RE_TURN_NUM);
      if (m) { turns.push({ number: +m[1], player: m[2].trim(), lines: [] }); continue; }
      m = line.match(RE_TURN);
      if (m) { turns.push({ number: turns.length + 1, player: m[1].trim(), lines: [] }); continue; }
      (turns.length ? turns[turns.length - 1].lines : setup).push(line.trim());
    }
    const players = [];
    for (const t of turns) if (!players.includes(t.player)) players.push(t.player);
    const ending = [];
    if (turns.length) {
      const last = turns[turns.length - 1];
      last.lines = last.lines.filter((l) => (RE_END.test(l) ? (ending.push(l), false) : true));
    }
    return { setup, turns, players, ending, ok: turns.length > 0 };
  }

  // 評価に関係しない行を省いて、AIが読む量を減らす（速さのため。中身は削らない）
  function compactLines(lines) {
    const out = [];
    let inBreakdown = false;
    for (const l of lines) {
      if (/^- Damage breakdown:/i.test(l)) { inBreakdown = true; continue; }
      if (inBreakdown && /^•/.test(l) && /damage/i.test(l)) continue;
      inBreakdown = false;
      if (/shuffled their deck\.?$/i.test(l)) continue;
      if (/^- \d+ drawn cards\.?$/i.test(l)) continue;
      out.push(l);
    }
    return out;
  }

  function formatLogForAI(parsed, raw) {
    if (!parsed.ok) return raw;
    const out = ["[準備フェーズ]", ...compactLines(parsed.setup)];
    for (const t of parsed.turns) { out.push(`\n[ターン${t.number}：${t.player}]`, ...compactLines(t.lines)); }
    if (parsed.ending.length) out.push("\n[試合終了]", ...parsed.ending);
    return out.join("\n");
  }

  // ------------------------------------------------------------------ 事実の抽出
  const RE_PRIZE = /^(\S+) took (a|\d+) Prize cards?/i;
  const RE_KO = /^(\S+?)'s (.+?) was Knocked Out!/i;
  const RE_ATTACK = /^(\S+?)'s (.+?) used (.+?) on (\S+?)[’']s (.+?) for (\d+) damage/i;
  const RE_PLAYED = /^(\S+) played (.+?)(?: to the (?:Bench|Active Spot))?\.$/i;
  const RE_EVOLVED = /^(\S+) evolved (.+?) to (.+?) (?:on|in) the/i;
  const RE_FIRST = /^(\S+) decided to go (first|second)/i;
  const RE_WIN = /(\S+) wins\./i;

  function baselineScore(myLeft, oppLeft) {
    const d = oppLeft - myLeft; // 相手の残りが多いほど自分が有利
    return d >= 3 ? 2 : d >= 1 ? 1 : d === 0 ? 0 : d >= -2 ? -1 : -2;
  }

  function extractFacts(parsed, me) {
    const players = parsed.players;
    if (!players.includes(me)) me = players[1] || players[0] || me || "自分";
    const opp = players.find((p) => p !== me) || "相手";
    let wentFirst = "不明", result = "不明";
    for (const l of parsed.setup) {
      const m = l.match(RE_FIRST);
      if (m) {
        const first = m[2].toLowerCase() === "first" ? m[1] : (m[1] === me ? opp : me);
        wentFirst = first === me ? "先攻" : "後攻";
      }
    }
    for (const l of parsed.ending) { const m = l.match(RE_WIN); if (m) result = m[1] === me ? "勝ち" : "負け"; }
    const left = { [me]: 6, [opp]: 6 };
    const turns = parsed.turns.map((t) => {
      const info = { turn: t.number, player: t.player === me ? "自分" : "相手", attacks: [], kos: [], played: [], evolved: [] };
      for (const l of t.lines) {
        let m;
        if ((m = l.match(RE_PRIZE))) { if (m[1] in left) left[m[1]] -= m[2].toLowerCase() === "a" ? 1 : +m[2]; }
        else if ((m = l.match(RE_KO))) info.kos.push((m[1] === me ? "自分の" : "相手の") + m[2]);
        else if ((m = l.match(RE_ATTACK))) info.attacks.push(`${m[2]}の${m[3]} → ${m[5]}に${m[6]}ダメージ`);
        else if ((m = l.match(RE_EVOLVED))) info.evolved.push(`${m[2]}→${m[3]}`);
        else if ((m = l.match(RE_PLAYED))) info.played.push(m[2]);
      }
      info.my_left = Math.max(0, left[me]); info.opp_left = Math.max(0, left[opp]);
      info.baseline = baselineScore(info.my_left, info.opp_left);
      return info;
    });
    return { me, opp, went_first: wentFirst, result, turns };
  }

  function factsDigest(f) {
    const out = [`自分＝${f.me}／相手＝${f.opp}／自分は${f.went_first}／結果：${f.result}`];
    for (const t of f.turns) {
      out.push(`[ターン${t.turn}：${t.player}] 終了時のサイド残り 自分${t.my_left}枚・相手${t.opp_left}枚`);
      if (t.attacks.length) out.push("  ワザ：" + t.attacks.join("／"));
      if (t.kos.length) out.push("  きぜつ：" + t.kos.join("、"));
      if (t.evolved.length) out.push("  進化：" + t.evolved.join("、"));
      if (t.played.length) out.push("  使用・展開：" + t.played.slice(0, 12).join("、"));
    }
    return out.join("\n");
  }

  function fallbackAnalysis(f, note) {
    return {
      my_name: f.me, opponent_name: f.opp, opponent_deck_guess: "不明", result: f.result, went_first: f.went_first,
      overall_summary: note || "AIの検討を取得できなかったため、サイドの取り合いだけで形勢を表示しています。",
      turns: f.turns.map((t) => {
        const bits = t.attacks.slice(0, 1).concat(t.kos.map((k) => `${k}がきぜつ`));
        return {
          turn: t.turn, player: t.player, score: t.baseline,
          summary: bits.length ? bits.join("、") : (t.played.length || t.evolved.length ? "展開・準備" : "大きな動きなし"),
          reason: `サイド残り 自分${t.my_left}枚・相手${t.opp_left}枚（サイド差による自動評価）`,
          key_actions: t.evolved.concat(t.played).slice(0, 4), better_play: "",
        };
      }),
      swing_points: [], lessons: [],
    };
  }

  // AIの結果を、プログラムで確認した事実で補正する（ターン抜け・勝敗・手番の誤りを直す）
  function mergeWithFacts(a, f) {
    if (f.result !== "不明") a.result = f.result;
    if (f.went_first !== "不明") a.went_first = f.went_first;
    a.my_name = f.me; a.opponent_name = f.opp;
    const byTurn = new Map((a.turns || []).map((t) => [Number(t.turn), t]));
    const fb = new Map(fallbackAnalysis(f).turns.map((t) => [t.turn, t]));
    if (f.turns.length) {
      a.turns = f.turns.map((t) => {
        const row = { ...(byTurn.get(t.turn) || fb.get(t.turn)) };
        row.turn = t.turn; row.player = t.player;
        row.score = Number.isFinite(Number(row.score)) ? clamp(row.score) : t.baseline;
        row.key_actions = row.key_actions || []; row.better_play = row.better_play || "";
        row.prizes_left = [t.my_left, t.opp_left];
        return row;
      });
    }
    a.swing_points = (a.swing_points || []).filter((s) => a.turns.some((t) => t.turn === Number(s.turn)));
    return a;
  }

  function detectSwings(turns) {
    const out = []; let prev = null;
    for (const t of turns) {
      const s = clamp(t.score);
      if (prev !== null && ((prev >= 1 && s <= -1) || prev - s >= 2)) out.push(Number(t.turn));
      prev = s;
    }
    return out;
  }

  // ------------------------------------------------------------------ プロンプト
  function systemPrompt(regulation) {
    return `あなたはポケモンカードゲーム（Pokémon TCG Live / スタンダード）のトッププレイヤー兼コーチです。
将棋の解説者のように、各ターン終了時点の形勢を自分（ユーザー）視点で評価し、悪手と最善手を指摘します。

## 前提（最重要）
- 今日は ${todayJa()} です。
- 現在のレギュレーション：${regulation}
- あなたの学習データは古い可能性があります。ユーザーが渡す「環境メモ」や検索結果を、自分の記憶より常に優先してください。
- ローテーションで使用不可になったカードや、古い環境のデッキを前提にした助言はしないでください。

## PTCGL のログの癖
- ダメカンを「のせかえる」特性などで、移した先のポケモンの持ち主名がログ上で誤って表示されることがある。文脈で判断する。
- "Pokémon Checkup" はターン終了時の処理（どく・やけどのダメージ）。

## ルール
- 回答はすべて日本語。カード名はログの表記のままでよい。
- 相手の手札など見えない情報は断定せず、確率で語り、確度を示す。
- 対局の検討で提案に使うカードは、「自分のデッキリスト」か「バトルログに登場したカード」に含まれるものだけに限定する。
- 構築の変更案などでデッキ外のカードを勧めるときは、カード名の後ろに（収録弾・レギュレーションマーク）を必ず書き、H 以降と確認できないカードは勧めない。`;
  }

  function analysisPrompt({ log, me, deck, meta, extra, digest }) {
    return [
      `次の順番で、1ターンずつ検討してください。各ターンのJSONも、この順番どおりの項目で書きます。
(1) そのターン終了時の盤面を再現する（my_active〜threats）：場のポケモン、受けたダメージ量、エネルギー、道具、手札の推定。
    きぜつ・入れ替え・進化・回復・ダメカンの移動を反映する。分からない部分は推測と明記する。
(2) 盤面をもとに評価する（reason → score）：サイド残りの差 → 盤面 → 手札 → 次の番にお互い何枚サイドを取れるか、の順で考える。
    score は自分視点で +2優勢 / +1やや優勢 / 0互角 / -1やや劣勢 / -2劣勢。
(3) 自分のターンなら、より良い手があったかを考える（better_play）。そのターン開始時の盤面と手札で本当に実行できたかを確認してから書く。
全ターンを終えたら、形勢が +1以上 から -1以下 に落ちた、または2段階以上悪化した自分のターンを swing_points に必ず入れる。`,
      `## プログラムで確認した事実（サイド枚数・きぜつ・ワザ。正確なので必ず前提にする）\n${digest || "（なし）"}`,
      `## 自分のプレイヤー名\n${me || "（ログから推測）"}`,
      `## 自分のデッキリスト\n${deck || "（未登録）"}`,
      `## 現在の環境メモ（最新情報。記憶より優先する）\n${meta || "（なし）"}`,
      `## ユーザーからの補足（手札の状況など）\n${extra || "（なし）"}`,
      `## バトルログ\n${log}`,
      "turns には、事実のまとめにある全ターン（同じターン番号）を1件ずつ、漏れなく入れてください。",
    ].join("\n\n");
  }

  const S = (type, extra) => Object.assign({ type }, extra || {});
  const STR = S("STRING"), INT = S("INTEGER"), STRS = S("ARRAY", { items: STR });
  function obj(props, order) { return S("OBJECT", { properties: props, required: order, propertyOrdering: order }); }
  const TURN_ORDER = ["turn", "player", "my_active", "my_bench", "opp_active", "opp_bench", "my_hand", "opp_hand",
    "threats", "reason", "score", "summary", "key_actions", "better_play"];
  const TURN_SCHEMA = obj({
    turn: INT, player: S("STRING", { description: "'自分' または '相手'" }),
    my_active: S("STRING", { description: "自分のバトル場：ポケモン名（ダメージ量・エネルギー・道具）" }),
    my_bench: STRS, opp_active: STR, opp_bench: STRS,
    my_hand: S("STRING", { description: "自分の手札の推定" }), opp_hand: S("STRING", { description: "相手の手札の推定" }),
    threats: S("STRING", { description: "次の番に起こりうること（お互い何枚サイドを取れるか）" }),
    reason: S("STRING", { description: "評価の根拠" }), score: INT,
    summary: S("STRING", { description: "そのターンに起きたことを1〜2文で" }),
    key_actions: STRS, better_play: S("STRING", { description: "自分のターンでより良い手。なければ空文字" }),
  }, TURN_ORDER);
  const SWING_ORDER = ["turn", "what_happened", "better_play", "why", "alternative_line", "confidence"];
  const SWING_SCHEMA = obj({
    turn: INT, what_happened: STR, better_play: S("STRING", { description: "打つべきだった手。カード名と順番を具体的に" }),
    why: S("STRING", { description: "その手が良い理由。相手の返しも考慮" }), alternative_line: STRS,
    confidence: S("STRING", { description: "高 / 中 / 低" }),
  }, SWING_ORDER);
  const ANALYSIS_ORDER = ["my_name", "opponent_name", "opponent_deck_guess", "went_first", "result", "turns",
    "swing_points", "overall_summary", "lessons"];
  const ANALYSIS_SCHEMA = obj({
    my_name: STR, opponent_name: STR, opponent_deck_guess: STR, went_first: STR, result: STR,
    turns: S("ARRAY", { items: TURN_SCHEMA }), swing_points: S("ARRAY", { items: SWING_SCHEMA }),
    overall_summary: S("STRING", { description: "試合全体の流れの総評（3〜5文）" }),
    lessons: S("ARRAY", { items: STR, description: "次の試合に活かせる教訓（3〜5個）" }),
  }, ANALYSIS_ORDER);

  const BRIEF = "各見出しは3〜6行の箇条書きで、要点だけを短く書いてください。前置きや挨拶は不要です。";
  const NOTES_FIRST = "下の「環境メモ」は最近検索した最新情報です。これを今の環境として扱ってください。";

  function metaResearchPrompt(regulation) {
    const ym = new Date(); const ymJa = `${ym.getFullYear()}年${ym.getMonth() + 1}月`;
    return `必ず Google 検索を使ってください。あなたの記憶にある環境は古いので、記憶だけで答えてはいけません。
今日（${todayJa()}）時点の Pokémon TCG スタンダード環境（${regulation}）について、
「Limitless TCG standard meta」「ポケカ 環境 デッキ ${ymJa}」などで検索し、直近1か月の大会結果を調べてください。

出力形式（日本語・Markdown）：
- 冒頭に「調査日：${todayJa()}」
- 上位デッキ 8〜10個を使用率の高い順に番号つきリストで。各デッキは「デッキ名（日本語名／英語名）— 主なアタッカー — 特徴（1文）」
- 最後に「直近の変更点」（新弾、禁止カード、ルール変更など）があれば箇条書き`;
  }

  function deckGuidePrompt(deck, meta, focus) {
    return `${NOTES_FIRST}
次のデッキの戦い方を、今の環境に合わせて解説してください。${BRIEF}

## デッキリスト
${deck}

## 環境メモ
${meta || "（なし）"}

## 特に知りたいこと
${focus || "（特になし）"}

以下の見出し（### を使う）で、カード名と順番を出して具体的に書いてください。
### コンセプトと勝ち筋
### 理想の展開（先攻1ターン目／後攻1ターン目／2ターン目以降）
### 序盤の判断基準
### 中盤〜終盤のサイドプラン
### 今の上位デッキとの相性
### よくあるミス
### 構築の見直し候補（使用可能なカードのみ・理由つき）`;
  }

  function metaAdvicePrompt(deck, meta) {
    return `${NOTES_FIRST}
自分のデッキへ、今の環境を踏まえたアドバイスをください。${BRIEF}

## 自分のデッキ
${deck}

## 環境メモ
${meta || "（なし）"}

以下の見出し（### を使う）で：
### 今の環境での立ち位置（有利・不利な相手）
### 不利な相手への対策
### 構築の調整案（IN / OUT を枚数つきで。使用可能なカードのみ）
### 練習で意識すること`;
  }

  function deepDivePrompt(analysis, turn, log, deck) {
    return `以前の検討結果とバトルログをもとに、ターン${turn}の局面を深掘りしてください。

## 自分のデッキ
${deck || "（未登録）"}

## 検討結果（JSON。各ターンの盤面の再現を含む）
${JSON.stringify(analysis)}

## バトルログ
${log}

以下の見出し（### を使う）で：
### ターン${turn}開始時点の状況（盤面・サイド・手札の推定）
### 考えられた選択肢（2〜3案。手順、メリット、リスク、相手の返し）
### 最善と思われる手とその理由
### 同じような局面で使える原則`;
  }

  // ------------------------------------------------------------------ Gemini 呼び出し
  const MODELS = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
  const FALLBACK = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-flash-latest"];
  const API = "https://generativelanguage.googleapis.com/v1beta/models/";

  class AIError extends Error {}
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  function classify(e) {
    const st = e.status || 0, m = String(e.message || "");
    if (st === 503 || st === 500 || /UNAVAILABLE|INTERNAL|overloaded/i.test(m)) return "busy";
    if (st === 429 || /RESOURCE_EXHAUSTED/.test(m)) return "quota";
    if (st === 404 || /NOT_FOUND/.test(m)) return "model";
    if (st === 401 || st === 403 || /API key|API_KEY|UNAUTHENTICATED|PERMISSION_DENIED/i.test(m)) return "auth";
    if (e.name === "TypeError") return "network";
    return "other";
  }
  const ERR = {
    busy: "Geminiのサーバーが混み合っています（Google側の一時的な混雑）。数分おいてから、もう一度試してください。",
    quota: "無料枠の利用上限に達しました。1分ほど待ってから、もう一度試してください。",
    quota_day: "今日の無料枠を使い切りました。日本時間の16時ごろ（Googleの日付の切り替わり）にリセットされます。",
    model: "選んだモデルが見つかりませんでした。設定でモデルを変更してください。",
    auth: "APIキーが使えませんでした。設定でAPIキーを確認してください。",
    network: "通信できませんでした。電波の良いところで、もう一度試してください。",
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 429 の中身から「1日の上限」か「1分の上限」か、何秒待てばよいかを読み取る
  function quotaInfo(e) {
    const s = String(e.message || "") + " " + String(e.details || "");
    const daily = /PerDay|per day|daily/i.test(s);
    const m = s.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) || s.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
    return { daily, wait: m ? Math.ceil(parseFloat(m[1])) : null };
  }

  function buildBody({ system, prompt, schema, search, temperature }) {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: temperature ?? 0.4 },
    };
    if (schema) { body.generationConfig.responseMimeType = "application/json"; body.generationConfig.responseSchema = schema; }
    if (search) body.tools = [{ google_search: {} }];
    return body;
  }

  function collectSources(json, into) {
    for (const c of json.candidates || []) {
      for (const ch of (c.groundingMetadata && c.groundingMetadata.groundingChunks) || []) {
        if (ch.web && ch.web.uri && !into.some((s) => s.url === ch.web.uri)) into.push({ title: ch.web.title || ch.web.uri, url: ch.web.uri });
      }
    }
  }
  const textOf = (json) => (json.candidates || []).flatMap((c) => ((c.content && c.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "")).join("");

  // 1つのモデルに1回問い合わせる。stream=true なら書けた分から onText に渡す
  async function callOnce(fetchFn, { apiKey, model, body, stream, onText }) {
    const url = API + encodeURIComponent(model) + (stream ? ":streamGenerateContent?alt=sse" : ":generateContent");
    const res = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify(body) });
    if (!res.ok) {
      let msg = "", details = "";
      try { const j = await res.json(); msg = (j.error && (j.error.status + " " + j.error.message)) || ""; details = JSON.stringify((j.error && j.error.details) || []); } catch (_) { /* 本文なし */ }
      const err = new HttpError(res.status, msg || "HTTP " + res.status);
      err.details = details;
      throw err;
    }
    const sources = [];
    if (!stream) { const j = await res.json(); collectSources(j, sources); return { text: textOf(j), sources }; }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let j; try { j = JSON.parse(payload); } catch (_) { continue; }
        if (j.error) throw new HttpError(j.error.code || 500, j.error.status + " " + j.error.message);
        collectSources(j, sources);
        const t = textOf(j);
        if (t) { text += t; if (onText) onText(t, text); }
      }
    }
    return { text, sources };
  }

  // 混雑(503)は待って再試行、上限(429)やモデル不在は別モデルへ切り替える
  async function ask(opts) {
    const fetchFn = opts.fetch || root.fetch.bind(root);
    const body = buildBody(opts);
    const models = [opts.model].concat(FALLBACK.filter((m) => m !== opts.model));
    let lastKind = "other", lastMsg = "";
    const tried = [];
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (opts.onRestart) opts.onRestart();
          const r = await callOnce(fetchFn, { apiKey: opts.apiKey, model: m, body, stream: !!opts.stream, onText: opts.onText });
          return { ...r, model: m, searched: !!opts.search && r.sources.length > 0, at: nowStamp() };
        } catch (e) {
          let kind = classify(e); lastMsg = `${m}：${e.message}`; tried.push(`${m}=${e.status || "?"}`);
          if (kind === "quota") {
            const q = quotaInfo(e);
            if (q.daily) kind = "quota_day";
            // 1分あたりの上限で、待ち時間が短ければ、待ってから同じモデルでやり直す
            else if (attempt === 0 && q.wait !== null && q.wait <= 60) {
              for (let s = q.wait; s > 0; s -= 5) { opts.onNote && opts.onNote(`1分あたりの上限に達したため、${s}秒待ってから再開します…`); await sleep(Math.min(5, s) * 1000); }
              continue;
            }
          }
          lastKind = kind;
          if (kind === "auth" || kind === "network" || kind === "other") throw new AIError((ERR[kind] || "AIの呼び出しに失敗しました。") + `\n（${m}／Googleからの返答：${String(e.message).slice(0, 300)}）`);
          if (kind === "busy" && attempt === 0) { opts.onNote && opts.onNote(`${m} が混雑中。数秒待って再試行しています…`); await sleep(3000); continue; }
          break;
        }
      }
      if (i + 1 < models.length) opts.onNote && opts.onNote(`${m} が使えないため ${models[i + 1]} に切り替えます…`);
    }
    throw new AIError((ERR[lastKind] || "AIの呼び出しに失敗しました。") + `\n（試したモデル：${tried.join("、")}／最後のGoogleからの返答：${lastMsg.slice(0, 300)}）`);
  }

  function parseJSON(text) {
    const t = String(text || "").trim();
    try { return JSON.parse(t); } catch (_) { /* 前後の余計な文字を除いて再挑戦 */ }
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) throw new AIError("AIの返答を読み取れませんでした。");
    try { return JSON.parse(m[0]); } catch (_) { throw new AIError("AIの返答を読み取れませんでした。"); }
  }

  const Core = {
    EVAL_LABELS, evalLabel, clamp, DEFAULT_REGULATION, DEFAULT_META_NOTES, MODELS, defaultStore, metaAgeDays, nowStamp,
    parseDeck, parseLog, compactLines, formatLogForAI, extractFacts, factsDigest, fallbackAnalysis, mergeWithFacts,
    detectSwings, baselineScore, systemPrompt, analysisPrompt, ANALYSIS_SCHEMA, metaResearchPrompt, deckGuidePrompt,
    metaAdvicePrompt, deepDivePrompt, ask, parseJSON, AIError,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Core; else root.Core = Core;
})(typeof globalThis !== "undefined" ? globalThis : this);
