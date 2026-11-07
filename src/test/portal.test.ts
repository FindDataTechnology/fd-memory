// Portal contracts (add-yongyi-complete-solution). The portal is a bundled
// static face served by the service process itself at /portal; the page then
// consumes ONLY the existing HTTP faces with the person token's own Bearer
// header. Like http-routes.test.ts, these hit a REAL server over a REAL
// port — the wiring under test is the registration seam (handlePortal first,
// fall through to Service.route) plus the exact call shapes the front-end
// makes.
//
//   node --test dist/test/portal.test.js

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Service } from "../http.js";
import { handlePortal } from "../portal-server.js";
import { newPage } from "../okf.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpData(): string {
  const d = mkdtempSync(join(tmpdir(), "fdm-portal-"));
  dirs.push(d);
  return d;
}

// The integration the main router uses (see portal-server.ts header): portal
// answers /portal* first, everything else falls through to Service.route.
function boot() {
  const svc = new Service({ dataDir: tmpData(), port: 0, pepper: "p" });
  const route = (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route.bind(svc);
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://local").pathname;
    handlePortal(req, res, pathname)
      .then((handled) => (handled ? undefined : route(req, res)))
      .catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal", message: String((err as Error)?.message ?? err) }));
      });
  });
  return new Promise<{ svc: Service; base: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve({ svc, base, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

const json = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });

function stubRes(): { res: ServerResponse; writes: Array<{ status?: number; body?: string }> } {
  const writes: Array<{ status?: number; body?: string }> = [];
  const res = {
    writeHead(status: number) { writes.push({ status }); return undefined as never; },
    end(body?: string) { const last = writes[writes.length - 1]; if (last) last.body = body; else writes.push({ body }); },
  } as unknown as ServerResponse;
  return { res, writes };
}

function stubReq(method = "GET"): IncomingMessage {
  return { method } as unknown as IncomingMessage;
}

const PORTAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "portal");

// Internal brand/coordinate literals that must NEVER appear in shipped
// assets. They are built joined here because this very source file is scanned
// by the repo's leak gate — a contiguous literal in a test would trip it.
const INTERNAL_BRANDS = ["壹" + "座", "萬" + "星", "万" + "星", "寻" + "数"];
const INTERNAL_COORDS = ["100.64.", "10.43.", ".svc.cluster.local", "fd-" + "prod", "yizuo" + "." + "local"];

function readAsset(name: string): string {
  return readFileSync(join(PORTAL_DIR, name), "utf8");
}

// ── 随包内置发行：/portal 由服务进程自身托管，静态资产可达 ──

test("/portal serves the bundled face without auth; unknown assets 404; other methods 405; non-portal falls through", async () => {
  const { base, close } = await boot();
  try {
    const home = await fetch(`${base}/portal`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /text\/html/);
    const html = await home.text();
    assert.match(html, /html lang="zh-CN"/);
    assert.ok(html.includes("永忆"), "brand must be 永忆");

    const js = await fetch(`${base}/portal/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const css = await fetch(`${base}/portal/app.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const missing = await fetch(`${base}/portal/nope.js`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: string }).error, "not_found");

    const post = await fetch(`${base}/portal`, { method: "POST" });
    assert.equal(post.status, 405);

    // Fall-through: a non-portal path reaches Service.route — an unauthenticated
    // data face answers the structured 401 (the page's paste-login premise).
    const mem = await fetch(`${base}/memory?limit=1`);
    assert.equal(mem.status, 401);
    assert.equal(((await mem.json()) as { error: string }).error, "unauthorized");
  } finally { await close(); }
});

test("handlePortal: registration smoke — false outside /portal (no writes), true inside", async () => {
  const outside = stubRes();
  assert.equal(await handlePortal(stubReq(), outside.res, "/healthz"), false);
  assert.equal(await handlePortal(stubReq(), outside.res, "/memory"), false);
  assert.deepEqual(outside.writes, [], "fall-through must not touch the response");

  const inside = stubRes();
  assert.equal(await handlePortal(stubReq(), inside.res, "/portal"), true);
  assert.equal(inside.writes[0]?.status, 200);
  assert.ok(String(inside.writes[0]?.body ?? "").includes("永忆"));

  const method = stubRes();
  assert.equal(await handlePortal(stubReq("DELETE"), method.res, "/portal/app.js"), true);
  assert.equal(method.writes[0]?.status, 405);
});

// ── 品牌边界：静态资产不含内部品牌/内部地址，zh-CN 默认 ─────

test("portal assets carry no internal brands or internal coordinates, and default to zh-CN", () => {
  for (const name of ["index.html", "app.js", "app.css"]) {
    const text = readAsset(name);
    for (const bad of [...INTERNAL_BRANDS, ...INTERNAL_COORDS]) {
      assert.ok(!text.includes(bad), `${name} must not contain internal identifier ${JSON.stringify(bad)}`);
    }
  }
  const html = readAsset("index.html");
  assert.match(html, /html lang="zh-CN"/, "default language must be zh-CN");
  assert.ok(html.includes("永忆"), "branding must be 永忆's own");
});

// ── 前端调用与既有端点形状逐字一致（文本断言）────────────────

test("portal front-end calls the existing faces with their exact shapes", () => {
  const js = readAsset("app.js");
  // visibility 读面：筛选 + 分页参数（scope/layer/tier/tag/since/until/limit/offset）
  assert.ok(js.includes('"/memory?"'), "list must call GET /memory with query params");
  assert.ok(js.includes('"/memory?limit=1"'), "login probe must reuse the read face");
  for (const key of ["scope", "layer", "tier", "tag", "since", "until", "limit", "offset"]) {
    assert.ok(js.includes(`"${key}"`), `filter bar must submit ${key}`);
  }
  // 晋升手势：候选列表 + {path} 体的接受/忽略
  assert.ok(js.includes('"/memory/promotions"'), "candidates must come from the promotions face");
  assert.ok(js.includes('"/memory/promotions/accept"'));
  assert.ok(js.includes('"/memory/promotions/ignore"'));
  assert.ok(js.includes("JSON.stringify({ path })"), "accept/ignore bodies carry {path}");
  // 纠错：既有 /pages 写入，{project,title,body}
  assert.ok(js.includes('"/pages", {'), "correction must POST /pages");
  assert.ok(js.includes("JSON.stringify({ project: item.project, title, body })"), "page write body is {project,title,body}");
  assert.ok(js.includes('"/pages?project="'), "harness badge lookup rides the project index face");
  // 摘要：既有 digest 面
  assert.ok(js.includes('"/digest?"'), "digest view must call GET /digest with query params");
  // 认证：粘贴的令牌以 Bearer 头出示
  assert.ok(js.includes('"Bearer " +'), "requests must present the person credential as Bearer");
  // 来源徽标：metadata.harness 存在才显示
  assert.ok(js.includes("meta.harness"), "harness badge must read metadata.harness");
});

// ── 晋升手势：接受才翻 tier（tier_origin=human），候选退出 ──

test("promotions accept gesture flips tier with human origin and removes the candidate", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const root = svc.rootForKey("u-alice");
    root.writePage("default", "facts", "f1", newPage("fact", "毛利率口径", "旧结论：毛利率按含退口径", { tier: "draft" }));
    root.db.upsertTierProposal("default", "default/facts/f1.md", {
      proposed_tier: "stable", reason: "多回合引用", proposed_at: new Date().toISOString(),
    });

    const listed = await fetch(`${base}/memory/promotions`, { headers: json(person) });
    assert.equal(listed.status, 200);
    const proposals = ((await listed.json()) as { proposals: Array<{ path: string; proposed_tier: string }> }).proposals;
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].path, "default/facts/f1.md");

    const accepted = await fetch(`${base}/memory/promotions/accept`, {
      method: "POST", headers: json(person), body: JSON.stringify({ path: "default/facts/f1.md" }),
    });
    assert.equal(accepted.status, 200);
    const doc = (await accepted.json()) as { tier: string; tier_origin: string };
    assert.equal(doc.tier, "stable");
    assert.equal(doc.tier_origin, "human", "acceptance must record a human origin");

    const page = root.readPageByRel("default/facts/f1.md");
    assert.equal(String(page?.frontmatter?.tier ?? ""), "stable");
    assert.equal(String(page?.frontmatter?.tier_origin ?? ""), "human");

    const after = await fetch(`${base}/memory/promotions`, { headers: json(person) });
    assert.equal(((await after.json()) as { proposals: unknown[] }).proposals.length, 0, "accepted candidate leaves the list");
  } finally { await close(); }
});

// ── 人工纠错：更正 note 写入用户根，标题/正文带「更正」并引用原页

test("correction action writes a 更正-marked note into the person root via /pages", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const root = svc.rootForKey("u-alice");
    root.writePage("default", "facts", "f1", newPage("fact", "毛利率口径", "旧结论", { tier: "stable" }));

    // This is the exact call shape portal/app.js makes on 「更正」.
    const res = await fetch(`${base}/pages`, {
      method: "POST", headers: json(person),
      body: JSON.stringify({
        project: "default",
        title: "更正：毛利率口径",
        body: "> 更正针对页面：default/facts/f1.md\n\n新结论：毛利率按扣除退货后口径。",
      }),
    });
    assert.equal(res.status, 200);
    const doc = (await res.json()) as { project: string; path: string };
    assert.equal(doc.project, "default");
    assert.match(doc.path, /^default\/notes\//, "correction lands as a note in the person root");

    const note = root.readPageByRel(doc.path);
    assert.ok(note, "correction note must exist");
    assert.ok(String(note!.frontmatter?.title ?? "").startsWith("更正："), "title carries the 更正 marker");
    assert.ok(String(note!.body ?? "").includes("default/facts/f1.md"), "body references the original page");
  } finally { await close(); }
});

// ── 浏览与筛选：tier 筛选语义与读面一致（分页与计数同源）────

test("memory read face honors the tier filter the filter bar submits", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const root = svc.rootForKey("u-alice");
    root.writePage("default", "facts", "f1", newPage("fact", "口径甲", "内容甲", { tier: "draft" }));
    root.writePage("default", "facts", "f2", newPage("fact", "口径乙", "内容乙", { tier: "stable" }));

    const all = await fetch(`${base}/memory?limit=50&offset=0`, { headers: json(person) });
    assert.equal(all.status, 200);
    const allDoc = (await all.json()) as { items: Array<{ tier: string }>; offset: number; limit: number };
    assert.equal(allDoc.items.length, 2);
    assert.equal(allDoc.offset, 0);
    assert.equal(allDoc.limit, 50);

    const filtered = await fetch(`${base}/memory?tier=stable&limit=50&offset=0`, { headers: json(person) });
    assert.equal(filtered.status, 200);
    const doc = (await filtered.json()) as { items: Array<{ tier: string }>; offset: number; limit: number };
    assert.equal(doc.items.length, 1, "only the requested tier is listed");
    assert.equal(doc.items[0].tier, "stable");
    assert.equal(doc.offset, 0);
    assert.equal(doc.limit, 50);
  } finally { await close(); }
});
