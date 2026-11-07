// 永忆 Portal 前端 — 手写 vanilla ES module：无构建链、无外部依赖（design D2）。
//
// 数据面全部来自既有 HTTP 面（本文件只消费、不定义端点）：
//   GET  /memory                    visibility 列表（scope/layer/tier/tag/since/until/limit/offset）
//   GET  /memory/promotions         晋升候选
//   POST /memory/promotions/accept  {path} 接受（tier_origin=human 由服务端强制）
//   POST /memory/promotions/ignore  {path} 忽略（进冷却）
//   POST /pages                     {project,title,body} 写 note（纠错走这里）
//   GET  /pages?project=…           项目页索引（详情读 metadata.harness，存在才显示来源徽标）
//   GET  /digest?project=…          服务端渲染摘要
//
// 认证：person 令牌粘贴登录。令牌存 localStorage，后续请求以 Bearer 头出示；
// 任何 401 都回到登录面板并给出引导文案，绝不裸报错。

const STORAGE_KEY = "yongyi_portal_token";

const state = {
  cred: "",
  view: "memory",
  filters: { scope: "", layer: "", tier: "", tag: "", since: "", until: "" },
  limit: 20,
  offset: 0,
  items: [],
  detail: null,
  proposals: [],
  // 详情经 /pages 读到的 metadata.harness（按路径缓存；存在才显示徽标）
  harnessByPath: new Map(),
};

const $ = (id) => document.getElementById(id);

// ── 认证与请求骨架 ─────────────────────────────────────────

function authHeaders() {
  return state.cred ? { authorization: "Bearer " + state.cred } : {};
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...authHeaders(), ...(opts.headers ?? {}) } });
  if (res.status === 401) {
    enterLogin("登录已失效或令牌无效：请重新粘贴 person 令牌。");
    throw new Error("unauthorized");
  }
  return res;
}

function setLoginHint(text) {
  $("login-hint").textContent = text;
}

function enterLogin(hint) {
  state.cred = "";
  state.detail = null;
  $("login-panel").hidden = false;
  $("app").hidden = true;
  $("nav").hidden = true;
  $("logout-btn").hidden = true;
  $("login-state").hidden = true;
  setLoginHint(hint ?? "");
}

function enterApp() {
  $("login-panel").hidden = true;
  $("app").hidden = false;
  $("nav").hidden = false;
  $("logout-btn").hidden = false;
  $("login-state").hidden = false;
  $("login-state").textContent = "已登录（person）";
  switchView("memory");
}

async function login() {
  const value = $("login-cred").value.trim();
  if (!value) {
    setLoginHint("请先粘贴 person 令牌（形如 fdm_…，可向部署方索取）。");
    return;
  }
  try {
    // 用既有读面做一次最小校验：200 即有效，401 引导重试。
    const probe = await fetch("/memory?limit=1", { headers: { authorization: "Bearer " + value } });
    if (probe.ok) {
      state.cred = value;
      localStorage.setItem(STORAGE_KEY, value);
      $("login-cred").value = "";
      enterApp();
    } else if (probe.status === 401) {
      setLoginHint("令牌无效或已撤销。请确认粘贴的是 person 令牌；如遗失请联系部署方重新签发。");
    } else {
      setLoginHint("服务返回异常（" + probe.status + "），请稍后重试。");
    }
  } catch {
    setLoginHint("无法连接服务：请确认永忆服务正在运行，且当前地址可达。");
  }
}

function logout() {
  localStorage.removeItem(STORAGE_KEY);
  enterLogin("已退出。");
}

// ── 视图切换 ───────────────────────────────────────────────

function switchView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.view === view);
  }
  for (const id of ["view-memory", "view-promotions", "view-digest"]) {
    $(id).hidden = id !== "view-" + view;
  }
  if (view === "memory") loadMemory(state.offset).catch(() => {});
  if (view === "promotions") loadPromotions().catch(() => {});
}

// ── 记忆浏览（复用既有读面筛选语义）────────────────────────

function readFilters() {
  state.filters = {
    scope: $("f-scope").value.trim(),
    layer: $("f-layer").value,
    tier: $("f-tier").value,
    tag: $("f-tag").value.trim(),
    since: $("f-since").value,
    until: $("f-until").value,
  };
  state.limit = Number($("f-limit").value) || 20;
}

function memoryQuery(offset) {
  // 参数名与既有 visibility 读面逐字对应：scope/layer/tier/tag/since/until + limit/offset。
  const f = state.filters;
  const p = new URLSearchParams();
  if (f.scope) p.set("scope", f.scope);
  if (f.layer) p.set("layer", f.layer);
  if (f.tier) p.set("tier", f.tier);
  if (f.tag) p.set("tag", f.tag);
  if (f.since) p.set("since", f.since);
  if (f.until) p.set("until", f.until);
  p.set("limit", String(state.limit));
  p.set("offset", String(offset));
  return p.toString();
}

async function loadMemory(offset) {
  state.offset = Math.max(0, offset);
  const res = await api("/memory?" + memoryQuery(state.offset));
  const doc = await res.json();
  state.items = Array.isArray(doc.items) ? doc.items : [];
  renderMemory();
}

function fmtTime(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString("zh-CN", { hour12: false }); } catch { return String(ts); }
}

function renderMemory() {
  const body = $("mem-body");
  body.textContent = "";
  for (const item of state.items) {
    const tr = document.createElement("tr");
    tr.dataset.path = item.path ?? "";
    const cells = [
      item.title ?? item.path ?? "",
      item.project ?? "",
      item.layer ?? "",
      item.tier ?? "draft",
      state.harnessByPath.get(item.path) ?? "",
      fmtTime(item.ts),
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.append(td);
    }
    tr.addEventListener("click", () => { openDetail(item, tr); });
    body.append(tr);
  }
  const n = state.items.length;
  $("mem-count").textContent = n ? `本页 ${n} 条 · 第 ${state.offset + 1}–${state.offset + n} 条` : "暂无符合条件的记忆页";
  $("pager-pos").textContent = n ? `第 ${Math.floor(state.offset / state.limit) + 1} 页` : "";
  $("prev-btn").disabled = state.offset === 0;
  $("next-btn").disabled = n < state.limit;
}

async function openDetail(item, tr) {
  state.detail = item;
  for (const row of document.querySelectorAll("#mem-body tr")) row.classList.toggle("selected", row === tr);
  $("detail").hidden = false;
  $("d-title").textContent = item.title ?? "(无标题)";
  $("d-path").textContent = item.path ?? "";
  $("d-project").textContent = item.project ?? "";
  $("d-layer").textContent = item.layer ?? "";
  $("d-tier").textContent = item.tier ?? "draft";
  $("d-tags").textContent = Array.isArray(item.tags) && item.tags.length ? item.tags.join("、") : "—";
  $("d-ts").textContent = fmtTime(item.ts);
  await lookupHarness(item).catch(() => {});
}

// 来源徽标：页 metadata 里的 harness 字段，存在才显示（design D2）。
// 列表项本身不带 metadata，这里经既有 /pages 项目索引读取一次并缓存。
async function lookupHarness(item) {
  if (state.harnessByPath.has(item.path)) return renderHarnessBadge(item.path);
  const res = await api("/pages?project=" + encodeURIComponent(item.project ?? "") + "&limit=50");
  if (!res.ok) return;
  const doc = await res.json();
  for (const pg of doc.pages ?? []) {
    let meta = null;
    try { meta = JSON.parse(String(pg.metadata ?? "null")); } catch { /* 无/坏 metadata：跳过 */ }
    const h = meta && typeof meta === "object" ? meta.harness : undefined;
    if (typeof h === "string" && h) state.harnessByPath.set(pg.path, h);
  }
  renderHarnessBadge(item.path);
}

function renderHarnessBadge(path) {
  const h = state.harnessByPath.get(path);
  const el = $("d-harness");
  el.hidden = !h;
  el.textContent = h ? "来源：" + h : "";
  const row = [...document.querySelectorAll("#mem-body tr")].find((r) => r.dataset.path === path);
  if (row && h) row.cells[4].textContent = h;
}

// ── 人工纠错（走既有 /pages 写入，标题/正文带「更正」标识并引用原页）──

function openCorrection() {
  const item = state.detail;
  if (!item) return;
  $("corr-source").textContent = `${item.title ?? ""}（${item.path ?? ""}）`;
  $("corr-body").value = "";
  $("corr-hint").textContent = "";
  $("corr-panel").hidden = false;
  $("corr-body").focus();
}

function closeCorrection() {
  $("corr-panel").hidden = true;
}

async function submitCorrection() {
  const item = state.detail;
  if (!item) return;
  const text = $("corr-body").value.trim();
  if (!text) {
    $("corr-hint").textContent = "请填写新的结论。";
    return;
  }
  const title = "更正：" + (item.title ?? item.path ?? "");
  const body = "> 更正针对页面：" + (item.path ?? "") + "\n\n" + text;
  try {
    const res = await api("/pages", {
      method: "POST",
      body: JSON.stringify({ project: item.project, title, body }),
    });
    if (res.ok) {
      const doc = await res.json();
      closeCorrection();
      toast("更正已写入：" + (doc.path ?? ""));
      loadMemory(state.offset).catch(() => {});
    } else {
      $("corr-hint").textContent = "写入失败（" + res.status + "），请稍后重试。";
    }
  } catch (err) {
    if (String(err?.message ?? err) !== "unauthorized") {
      $("corr-hint").textContent = "网络异常：更正未写入，请重试。";
    }
  }
}

// ── 晋升手势（接受才翻 tier，忽略进冷却）───────────────────

async function loadPromotions() {
  const res = await api("/memory/promotions");
  const doc = await res.json();
  state.proposals = Array.isArray(doc.proposals) ? doc.proposals : [];
  const list = $("promo-list");
  list.textContent = "";
  for (const p of state.proposals) {
    const li = document.createElement("li");
    li.className = "promo-item";
    const main = document.createElement("div");
    main.className = "promo-main";
    const title = document.createElement("div");
    title.className = "promo-title";
    title.textContent = p.title ?? p.path ?? "";
    const meta = document.createElement("div");
    meta.className = "promo-meta";
    meta.textContent = `${p.path ?? ""} · ${p.current_tier ?? "draft"} → ${p.proposed_tier ?? ""} · 提议方 ${p.proposed_by ?? "ai"} · ${fmtTime(p.proposed_at)}${p.reason ? " · " + p.reason : ""}`;
    main.append(title, meta);
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "primary";
    accept.textContent = "接受";
    accept.addEventListener("click", () => { actProposal("accept", p.path).catch(() => {}); });
    const ignore = document.createElement("button");
    ignore.type = "button";
    ignore.textContent = "忽略";
    ignore.addEventListener("click", () => { actProposal("ignore", p.path).catch(() => {}); });
    li.append(main, accept, ignore);
    list.append(li);
  }
  $("promo-count").textContent = state.proposals.length
    ? `共 ${state.proposals.length} 条待确认`
    : "暂无待确认的晋升候选";
}

async function actProposal(action, path) {
  // 端点字面量保持显式：/memory/promotions/accept 与 /memory/promotions/ignore
  // 均为既有面，体为 {path}；接受才翻 tier（服务端强制 tier_origin=human）。
  const url = action === "accept" ? "/memory/promotions/accept" : "/memory/promotions/ignore";
  const res = await api(url, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
  if (res.ok) {
    const doc = await res.json();
    toast(action === "accept"
      ? `已接受：tier → ${doc.tier ?? ""}（来源 human）`
      : "已忽略：该候选进入冷却。");
  } else if (res.status === 409) {
    toast("该页已被其他途径定级（stale），候选已移除。");
  } else if (res.status === 404) {
    toast("候选已不存在，列表已刷新。");
  } else {
    toast("操作失败（" + res.status + "）。");
  }
  await loadPromotions();
}

// ── 今日摘要（既有 digest 面，服务端渲染）──────────────────

async function loadDigest() {
  const project = $("digest-project").value.trim() || "default";
  const q = $("digest-q").value.trim();
  const p = new URLSearchParams({ project });
  if (q) p.set("q", q);
  const res = await api("/digest?" + p.toString());
  if (!res.ok) {
    $("digest-note").textContent = "生成失败（" + res.status + "）。";
    return;
  }
  const doc = await res.json();
  $("digest-out").textContent = String(doc.digest ?? "");
  $("digest-note").textContent = doc.model_note
    ? "提示：" + doc.model_note
    : `共 ${doc.items ?? 0} 条记忆块、${doc.notes ?? 0} 条笔记入摘要。`;
}

// ── 提示浮层 ───────────────────────────────────────────────

let toastTimer = null;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ── 装配 ───────────────────────────────────────────────────

function init() {
  $("login-btn").addEventListener("click", () => { login().catch(() => {}); });
  $("login-cred").addEventListener("keydown", (e) => { if (e.key === "Enter") login().catch(() => {}); });
  $("logout-btn").addEventListener("click", logout);

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  }

  $("filter-form").addEventListener("submit", (e) => { e.preventDefault(); readFilters(); loadMemory(0).catch(() => {}); });
  $("prev-btn").addEventListener("click", () => loadMemory(state.offset - state.limit).catch(() => {}));
  $("next-btn").addEventListener("click", () => loadMemory(state.offset + state.limit).catch(() => {}));

  $("corr-open").addEventListener("click", openCorrection);
  $("corr-cancel").addEventListener("click", closeCorrection);
  $("corr-submit").addEventListener("click", () => { submitCorrection().catch(() => {}); });

  $("digest-form").addEventListener("submit", (e) => { e.preventDefault(); loadDigest().catch(() => {}); });

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    // enterApp 内部经 switchView 发起首个读面请求；令牌失效时 api() 统一
    // 拦截 401 并回到登录面板给出引导文案。
    state.cred = saved;
    enterApp();
  } else {
    enterLogin("");
  }
}

init();
