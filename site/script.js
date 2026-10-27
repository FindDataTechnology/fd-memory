/* 永忆官网 · 漂浮星群修复程序
   One authored moment: a write lands as amber, then dissolves into the map.
   Reduced-motion users get the still map & a full list, no cycle. */
(function () {
  "use strict";

  var sky = document.getElementById("sky");
  var digestList = document.getElementById("digestList");

  var REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var NS = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 1200 780");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  svg.style.inset = "0";
  svg.style.width = "100%";
  svg.style.height = "100%";
  sky.appendChild(svg);

  /* ── star cloud background ──────────────────────────── */
  function star(x, y, r, o) {
    var c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", x); c.setAttribute("cy", y);
    c.setAttribute("r", r);
    c.setAttribute("fill", "#4fd0d8");
    c.setAttribute("opacity", o);
    svg.insertBefore(c, svg.firstChild);
  }
  var STARS = [
    [90, 80, 1.3, 0.22], [160, 200, 1.1, 0.12], [90, 340, 1.1, 0.10], [220, 110, 1.4, 0.14],
    [380, 60, 1.2, 0.12], [500, 140, 1.1, 0.12], [660, 90, 1.3, 0.16], [820, 120, 1.1, 0.14],
    [1010, 100, 1.2, 0.14], [1100, 260, 1.1, 0.16], [1130, 490, 1.4, 0.12], [1090, 690, 1.1, 0.12],
    [850, 730, 1.3, 0.14], [600, 720, 1.1, 0.12], [330, 700, 1.2, 0.12], [90, 620, 1.2, 0.14],
    [50, 460, 1.2, 0.10], [740, 420, 1.2, 0.2], [940, 380, 1.0, 0.18], [1180, 60, 1.2, 0.10]
  ];
  for (var i = 0; i < STARS.length; i++) star(STARS[i][0], STARS[i][1], STARS[i][2], STARS[i][3]);

  /* ── L0–L3 constellation map ────────────────────────── */
  var CX = 640, CY = 390;

  function circle(x, y, r, fill, stroke, dash) {
    var c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", r);
    c.setAttribute("fill", fill);
    if (stroke) {
      c.setAttribute("stroke", stroke);
      c.setAttribute("stroke-width", 1.4);
      if (dash) c.setAttribute("stroke-dasharray", dash);
    }
    svg.appendChild(c);
    return c;
  }

  function line(x1, y1, x2, y2, stroke, dash, w) {
    var l = document.createElementNS(NS, "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1);
    l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("stroke", stroke);
    l.setAttribute("stroke-width", w || 1);
    if (dash) l.setAttribute("stroke-dasharray", dash);
    svg.insertBefore(l, svg.children[STARS.length]);
    return l;
  }

  function label(x, y, text, size, fill, anchor) {
    var t = document.createElementNS(NS, "text");
    t.setAttribute("x", x); t.setAttribute("y", y);
    t.setAttribute("text-anchor", anchor || "middle");
    t.setAttribute("font-family", "IBM Plex Mono, monospace");
    t.setAttribute("font-size", size || 13);
    t.setAttribute("fill", fill || "#b6ac97");
    t.setAttribute("letter-spacing", "0.08em");
    t.textContent = text;
    svg.appendChild(t);
    return t;
  }

  /* outer rings (roadmap subdued) */
  circle(CX, CY, 270, "none", "#269fa8", "2 6");
  circle(CX, CY, 200, "none", "#269fa8");
  circle(CX, CY, 130, "none", "#269fa8");
  circle(CX, CY, 70, "none", "#8f6a2e", "2 6");

  /* L0 outer ring dot + label (raw observations) */
  var obs = circle(CX, CY - 270, 7, "#4fd0d8", null);
  label(CX, CY - 288, "L0 · observations", 12.5, "#7d7663");

  /* L1 i.e. current (amber center) */
  circle(CX, CY, 15, "#e8b45e", null);
  circle(CX, CY, 24, "none", "#e8b45e", "2 4");
  label(CX, CY + 44, "当前会话 · owner root", 13.5, "#e8b45e");

  /* L1 & L2 orbit nodes */
  var NODES = [
    { x: CX - 130, y: CY - 96, r: 6, kind: "l1", name: "notes" },
    { x: CX + 130, y: CY + 96, r: 6, kind: "l1", name: "handoffs" },
    { x: CX - 200, y: CY + 10, r: 5.5, kind: "l2", name: "facts" },
    { x: CX + 200, y: CY - 10, r: 5.5, kind: "l2", name: "experiences" },
    { x: CX - 270, y: CY - 40, r: 4.5, kind: "l3", name: "profiles (roadmap)", dim: true }
  ];
  var nodeEls = [];
  for (var j = 0; j < NODES.length; j++) {
    var n = NODES[j];
    line(CX, CY, n.x, n.y, "#269fa8", "1 6", 0.9);
    var fill = n.dim ? "#7d7663" : "#4fd0d8";
    var el = circle(n.x, n.y, n.r, fill, "#070c17", null);
    circle(n.x, n.y, n.r + 6, "none", n.dim ? "#7d7663" : "#4fd0d8", "2 4");
    label(n.x, n.y + n.r + 14, n.name, 11.5, n.dim ? "#7d7663" : "#b6ac97");
    nodeEls.push({ el: el, x: n.x, y: n.y, r: n.r, name: n.name, dim: n.dim });
  }

  /* supersede arc between a dim old node and a bright new one */
  var oldNode = circle(CX + 250, CY - 160, 4, "#5a5345", null);
  circle(CX + 250, CY - 160, 9, "none", "#5a5345", "2 4");
  label(CX + 250, CY - 190, "v1 · superseded", 11, "#7d7663");
  var newNode = circle(CX + 330, CY - 120, 6, "#e8b45e", null);
  circle(CX + 330, CY - 120, 12, "none", "#e8b45e", "2 4");
  label(CX + 330, CY - 96, "v2 · candidate", 11.5, "#e8b45e");

  var arcPath = "M " + (CX + 250) + " " + (CY - 150) + " Q " + (CX + 300) + " " + (CY - 150) + " " + (CX + 330) + " " + (CY - 132);
  var arc = document.createElementNS(NS, "path");
  arc.setAttribute("d", arcPath);
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", "#8f6a2e");
  arc.setAttribute("stroke-width", 1.4);
  arc.setAttribute("stroke-dasharray", "4 3");
  svg.appendChild(arc);

  /* supersede chain hover lights (contract: hovered to light the supersede chain) */
  function supHover(on) {
    arc.setAttribute("opacity", on ? 1 : 1);
    arc.setAttribute("stroke", on ? "#e8b45e" : "#8f6a2e");
    arc.setAttribute("stroke-width", on ? 2.4 : 1.4);
    if (on) {
      oldNode.setAttribute("fill", "#b6ac97");
      newNode.setAttribute("r", 9);
    } else {
      oldNode.setAttribute("fill", "#5a5345");
      newNode.setAttribute("r", 6);
    }
  }
  [newNode, oldNode, arc].forEach(function (el) {
    el.addEventListener("mouseenter", function () { supHover(true); });
    el.addEventListener("mouseleave", function () { supHover(false); });
  });

  /* ── digest flow ────────────────────────────────────── */
  var CURATED = [
    { t: "如何验收记忆系统的 own 与 shared 分区作用域", kind: "cyan", tag: "L2·experience" },
    { t: "舰队里怎么汇报状态和派发任务（report_status · dispatch）", kind: "cyan", tag: "L2·experience" },
    { t: "周报口径（用户要求长期记住）", kind: "live", tag: "L1·note" },
    { t: "部署目标已改为 cheap-8（cheap-4 退役）", kind: "live", tag: "L1·note → superseded" },
    { t: "收到 v2 巡检口径接替 v1", kind: "old", tag: "fact_new supersedes fact_old" },
    { t: "如何监控 GitHub 组织仓库的 star 与 issue 动态", kind: "cyan", tag: "L2·experience" },
    { t: "执行每日 mission-protocol 巡检第 17 轮", kind: "cyan", tag: "L2·experience" }
  ];

  function push(entry) {
    if (!digestList) return;
    var li = document.createElement("li");
    li.className = "is-" + entry.kind;
    li.innerHTML = "<strong>" + entry.tag + "</strong>  " + entry.t;
    digestList.insertBefore(li, digestList.firstChild);
    while (digestList.children.length > 7) digestList.removeChild(digestList.lastChild);
  }

  if (!REDUCED) {
    var k = 0;
    var step = function () { push(CURATED[k % CURATED.length]); k++; };
    step();
    setInterval(function () {
      step();
      /* amber flash on the map — one authored moment */
      var flash = circle(CX, CY, 10, "#e8b45e");
      flash.setAttribute("opacity", 0.55);
      var flashLine = line(CX, CY, CX + 90, CY - 70, "#e8b45e", null, 1.2);
      flashLine.setAttribute("opacity", 0.5);
      var anim1 = flash.animate(
        [{ opacity: 0.55, transform: "scale(1.05)" }, { opacity: 0, transform: "scale(1.55)" }],
        { duration: 900, iterations: 1, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
      );
      flashLine.animate(
        [{ opacity: 0.55 }, { opacity: 0 }],
        { duration: 900, iterations: 1, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
      );
      anim1.onfinish = function () { sky.removeChild(flash); sky.removeChild(flashLine); };
    }, 7000);
  } else {
    for (var m = 0; m < CURATED.length; m++) push(CURATED[m]);
  }

  /* ── node hover enlarge ──────────────────────────────── */
  for (var h = 0; h < nodeEls.length; h++) {
    (function (n) {
      n.el.addEventListener("mouseenter", function () {
        n.el.setAttribute("r", n.r + 2);
      });
      n.el.addEventListener("mouseleave", function () {
        n.el.setAttribute("r", n.r);
      });
    })(nodeEls[h]);
  }
})();
