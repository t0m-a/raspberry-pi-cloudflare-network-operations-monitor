import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const INDEX_HTML_PATH = path.join(ROOT_DIR, "public", "index.html");
const RPI5_REPORTER_PATH = path.join(ROOT_DIR, "agents", "rpi5", "rpi5_noc_reporter.py");

function extractInlineScript(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "Expected inline <script> block in public/index.html");
  return m[1];
}

class MockClassList {
  private classes: Set<string>;
  constructor(initial: string[] = []) {
    this.classes = new Set(initial.filter(Boolean));
  }
  add(...tokens: string[]) {
    for (const t of tokens) this.classes.add(t);
  }
  remove(...tokens: string[]) {
    for (const t of tokens) this.classes.delete(t);
  }
  contains(token: string): boolean {
    return this.classes.has(token);
  }
  toggle(token: string, force?: boolean): boolean {
    if (force === undefined) {
      if (this.classes.has(token)) {
        this.classes.delete(token);
        return false;
      }
      this.classes.add(token);
      return true;
    }
    if (force) {
      this.classes.add(token);
      return true;
    }
    this.classes.delete(token);
    return false;
  }
}

class MockElement {
  id: string;
  tagName: string;
  classList: MockClassList;
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  hidden = false;
  textContent = "";
  innerText = "";
  value = "";
  disabled = false;
  children: MockElement[] = [];
  listeners: Record<string, Array<(ev: any) => void>> = {};
  private _innerHTML = "";
  private rect: { top: number; bottom: number; height: number; width: number };
  scrollIntoViewCalls = 0;

  constructor(
    tagName: string,
    opts: {
      id?: string;
      classes?: string[];
      attrs?: Record<string, string>;
      text?: string;
      rect?: Partial<{ top: number; bottom: number; height: number; width: number }>;
    } = {},
  ) {
    this.tagName = tagName.toUpperCase();
    this.id = opts.id || "";
    this.classList = new MockClassList(opts.classes || []);
    if (opts.attrs) Object.assign(this.attributes, opts.attrs);
    if (opts.text) {
      this.textContent = opts.text;
      this.innerText = opts.text;
    }
    this.rect = {
      top: opts.rect?.top ?? 0,
      bottom: opts.rect?.bottom ?? 56,
      height: opts.rect?.height ?? 38,
      width: opts.rect?.width ?? 320,
    };
  }

  get innerHTML(): string {
    return this._innerHTML;
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
  }

  setRect(partial: Partial<{ top: number; bottom: number; height: number; width: number }>) {
    this.rect = { ...this.rect, ...partial };
  }

  getBoundingClientRect() {
    return { ...this.rect };
  }

  setAttribute(k: string, v: string) {
    this.attributes[k] = String(v);
  }

  getAttribute(k: string): string | null {
    return k in this.attributes ? this.attributes[k] : null;
  }

  addEventListener(type: string, fn: (ev: any) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  dispatchEvent(type: string, ev: any = {}) {
    for (const fn of this.listeners[type] || []) {
      fn(ev);
    }
  }

  contains(target: any): boolean {
    if (target === this) return true;
    return this.children.some((c) => c.contains(target));
  }

  querySelectorAll(selector: string): MockElement[] {
    if (selector === ".nav-pill") {
      return this.children.filter((c) => c.classList.contains("nav-pill"));
    }
    return [];
  }

  scrollIntoView() {
    this.scrollIntoViewCalls += 1;
  }
}

function createDashboardSandbox(options: {
  innerWidth?: number;
  innerHeight?: number;
  navBottom?: number;
  pillHeight?: number;
  initialStorage?: Record<string, string>;
} = {}) {
  const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  const scriptSrc = extractInlineScript(html);

  const storageMap = new Map<string, string>(Object.entries(options.initialStorage || {}));
  const localStorage = {
    getItem: (k: string) => (storageMap.has(k) ? storageMap.get(k)! : null),
    setItem: (k: string, v: string) => storageMap.set(k, String(v)),
    removeItem: (k: string) => storageMap.delete(k),
  };

  const navSectionMeta = [
    { href: "#sec-gemma-ai", label: "AI NOC Analyst" },
    { href: "#sec-edge-domains", label: "Edge Domains" },
    { href: "#sec-cloud-billing", label: "Workers & Pages" },
    { href: "#sec-durable-objects", label: "Durable Objects" },
    { href: "#sec-workers-ai", label: "Workers AI" },
    { href: "#sec-d1-databases", label: "D1 SQL" },
    { href: "#sec-kv-storage", label: "Workers KV" },
    { href: "#sec-r2-storage", label: "R2 Storage" },
    { href: "#sec-rpi5", label: "🍓 Raspberry Pi 5" },
    { href: "#sec-esp32", label: "📡 ESP-32S" },
  ];

  const pills = navSectionMeta.map(
    (item) =>
      new MockElement("a", {
        classes: ["nav-pill"],
        attrs: { href: item.href },
        text: item.label,
        rect: { height: options.pillHeight ?? 38, top: 0, bottom: options.pillHeight ?? 38 },
      }),
  );

  const navToggle = new MockElement("button", {
    id: "mobile-nav-toggle",
    classes: ["mobile-nav-toggle"],
    attrs: { "aria-expanded": "false" },
    rect: { top: 8, bottom: options.navBottom ?? 56, height: 48 },
  });
  const navCurrent = new MockElement("span", {
    id: "mobile-nav-current",
    classes: ["mobile-nav-current"],
    text: "AI NOC Analyst",
  });
  const navChevron = new MockElement("span", {
    id: "mobile-nav-chevron",
    classes: ["mobile-nav-chevron"],
    text: "▸ Menu",
  });
  const navList = new MockElement("div", {
    id: "nav-pills-list",
    classes: ["nav-pills-list"],
  });
  navList.children = pills;

  const navHint = new MockElement("div", {
    id: "mobile-nav-overflow-hint",
    classes: ["mobile-nav-overflow-hint"],
  });
  navHint.hidden = true;

  const navRoot = new MockElement("nav", {
    id: "noc-nav",
    classes: ["nav-pills"],
  });
  navRoot.children = [navToggle, navList, navHint];

  const elementsById = new Map<string, MockElement>([
    ["noc-nav", navRoot],
    ["mobile-nav-toggle", navToggle],
    ["mobile-nav-current", navCurrent],
    ["mobile-nav-chevron", navChevron],
    ["nav-pills-list", navList],
    ["mobile-nav-overflow-hint", navHint],
    ["gemma-ai-container", new MockElement("div", { id: "gemma-ai-container" })],
    ["domains-container", new MockElement("div", { id: "domains-container" })],
    ["last-updated", new MockElement("span", { id: "last-updated" })],
    ["daemon-health", new MockElement("span", { id: "daemon-health" })],
    ["billing-cycle", new MockElement("span", { id: "billing-cycle" })],
  ]);

  // Sync dynamic AI panel elements whenever gemma-ai-container.innerHTML is rendered
  const aiContainer = elementsById.get("gemma-ai-container")!;
  Object.defineProperty(aiContainer, "innerHTML", {
    get() {
      return (this as any)._renderedHtml || "";
    },
    set(val: string) {
      (this as any)._renderedHtml = val;
      const aiFolded = /id="ai-analyst-body"[^>]*class="[^"]*\bfolded\b/.test(val);
      const aiAriaMatch = val.match(/id="ai-analyst-toggle"[^>]*aria-expanded="(true|false)"/);
      const assessFolded = /id="noc-assessment-body"[^>]*class="[^"]*\bfolded\b/.test(val);
      const assessAriaMatch = val.match(/id="noc-assessment-toggle"[^>]*aria-expanded="(true|false)"/);

      elementsById.set(
        "ai-analyst-toggle",
        new MockElement("button", {
          id: "ai-analyst-toggle",
          attrs: { "aria-expanded": aiAriaMatch ? aiAriaMatch[1] : "false" },
        }),
      );
      elementsById.set(
        "ai-analyst-body",
        new MockElement("div", {
          id: "ai-analyst-body",
          classes: aiFolded ? ["ai-analyst-body", "folded"] : ["ai-analyst-body"],
        }),
      );
      elementsById.set(
        "ai-analyst-chevron",
        new MockElement("span", {
          id: "ai-analyst-chevron",
          text: aiFolded ? "▸ Expand" : "▾ Collapse",
        }),
      );
      elementsById.set(
        "noc-assessment-toggle",
        new MockElement("button", {
          id: "noc-assessment-toggle",
          attrs: { "aria-expanded": assessAriaMatch ? assessAriaMatch[1] : "false" },
        }),
      );
      elementsById.set(
        "noc-assessment-body",
        new MockElement("div", {
          id: "noc-assessment-body",
          classes: assessFolded ? ["assessment-body", "folded"] : ["assessment-body"],
        }),
      );
      elementsById.set(
        "noc-assessment-chevron",
        new MockElement("span", {
          id: "noc-assessment-chevron",
          text: assessFolded ? "▸ Expand" : "▾ Collapse",
        }),
      );
    },
  });

  const docListeners: Record<string, Array<(ev: any) => void>> = {};
  const winListeners: Record<string, Array<(ev: any) => void>> = {};

  const documentMock = {
    getElementById: (id: string) => elementsById.get(id) || null,
    querySelectorAll: (selector: string) => {
      if (selector === ".nav-pills .nav-pill" || selector === "#nav-pills-list .nav-pill") {
        return pills;
      }
      return [];
    },
    querySelector: (selector: string) => {
      if (selector === "#nav-pills-list .nav-pill.active") {
        return pills.find((p) => p.classList.contains("active")) || null;
      }
      return null;
    },
    addEventListener: (type: string, fn: (ev: any) => void) => {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(fn);
    },
    dispatchEvent: (type: string, ev: any = {}) => {
      for (const fn of docListeners[type] || []) fn(ev);
    },
  };

  const windowMock: any = {
    innerWidth: options.innerWidth ?? 390,
    innerHeight: options.innerHeight ?? 667,
    getComputedStyle: () => ({ rowGap: "6px", gap: "6px", paddingTop: "8px", paddingBottom: "8px" }),
    addEventListener: (type: string, fn: (ev: any) => void) => {
      if (!winListeners[type]) winListeners[type] = [];
      winListeners[type].push(fn);
    },
    dispatchEvent: (type: string, ev: any = {}) => {
      for (const fn of winListeners[type] || []) fn(ev);
    },
  };

  const sandbox: any = {
    window: windowMock,
    document: documentMock,
    localStorage,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    setInterval: () => 0,
    clearInterval: () => {},
    alert: () => {},
    console,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    RegExp,
    parseFloat,
    parseInt,
    isFinite,
    Error,
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  const compiled = new vm.Script(scriptSrc, { filename: "public/index.html" });
  compiled.runInContext(ctx);

  return {
    ctx,
    window: windowMock,
    document: documentMock,
    localStorage,
    elementsById,
    pills,
    navRoot,
    navToggle,
    navList,
    navHint,
    navCurrent,
    navChevron,
  };
}

describe("Raspberry Pi 5 Monitoring Configuration", () => {
  it("excludes uninstalled NetworkManager, Avahi mDNS, and PostgreSQL services while preserving active targets", () => {
    const src = fs.readFileSync(RPI5_REPORTER_PATH, "utf8");
    const blockMatch = src.match(/def collect_critical_services[\s\S]*?systemd_targets\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(blockMatch, "Expected systemd_targets list inside collect_critical_services()");
    const targetsBlock = blockMatch[1];

    // Uninstalled services must NOT be monitored
    assert.ok(!targetsBlock.includes("NetworkManager.service"), "NetworkManager.service must be removed");
    assert.ok(!targetsBlock.includes("avahi-daemon.service"), "avahi-daemon.service must remain removed");
    assert.ok(!targetsBlock.includes("postgresql.service"), "postgresql.service must remain removed");

    // Expected active services must remain monitored
    const expectedUnits = [
      "cloudflared.service",
      "docker.service",
      "gemini-brain-watcher.service",
      "ssh.service",
      "cron.service",
      "smbd.service",
      "cloudflared-update.timer",
    ];
    for (const unit of expectedUnits) {
      assert.ok(targetsBlock.includes(`"${unit}"`), `Expected ${unit} to remain monitored`);
    }
    assert.ok(src.includes('("edge-qdrant", "Edge Qdrant Vector DB", True)'), "Expected edge-qdrant Docker target");
  });
});

describe("Dashboard Mobile Menu & Collapsible Workers AI Analyst UI", () => {
  it("declares valid markup, mobile folded-by-default CSS, and all-viewport collapsible AI analyst CSS", () => {
    const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");

    // Inline script parses cleanly
    const scriptSrc = extractInlineScript(html);
    assert.doesNotThrow(() => new vm.Script(scriptSrc));

    // Mobile nav markup
    assert.ok(html.includes('id="noc-nav"'));
    assert.ok(html.includes('id="mobile-nav-toggle"') && html.includes('aria-expanded="false"'));
    assert.ok(html.includes('id="nav-pills-list"'));
    assert.ok(html.includes('id="mobile-nav-overflow-hint"'));

    // Mobile CSS folds nav list by default and unfolds under .mobile-expanded
    assert.match(html, /@media\s*\(max-width:\s*768px\)/);
    assert.match(html, /\.nav-pills-list\s*\{\s*display:\s*none;\s*\}/);
    assert.match(html, /\.nav-pills\.mobile-expanded\s+\.nav-pills-list\s*\{[\s\S]*?overflow-y:\s*auto;/);

    // Collapsible AI analyst CSS is defined outside the mobile media query so it applies to every viewport
    const mediaIdx = html.indexOf("@media (max-width: 768px)");
    const aiFoldedCssIdx = html.indexOf(".ai-analyst-body.folded");
    assert.ok(aiFoldedCssIdx > 0 && aiFoldedCssIdx < mediaIdx, "AI analyst collapsible CSS must apply on all viewports");
  });

  it("keeps mobile navigation folded by default, unfolds on click, and fits only viewport-bounded sections", () => {
    const env = createDashboardSandbox({ innerWidth: 390, innerHeight: 667, navBottom: 280, pillHeight: 38 });

    // Folded by default
    assert.equal(env.navRoot.classList.contains("mobile-expanded"), false);
    assert.equal(env.navToggle.getAttribute("aria-expanded"), "false");
    assert.equal(env.navChevron.textContent, "▸ Menu");

    // Unfold on click
    const layout = env.ctx.toggleMobileNav();
    assert.equal(env.navRoot.classList.contains("mobile-expanded"), true);
    assert.equal(env.navToggle.getAttribute("aria-expanded"), "true");
    assert.equal(env.navChevron.textContent, "▾ Close");

    // Available space below navBottom (280) in 667px viewport is 667 - 280 - 16 = 371px.
    // All 10 items need 450px, so only complete items that fit in viewport (7 items) should be shown.
    assert.ok(layout, "Expected computed mobile nav layout");
    assert.equal(layout.visibleCount, 7);
    assert.equal(layout.hasOverflow, true);
    assert.ok(layout.maxHeightPx + 32 <= 667 - 280 - 16, "Unfolded menu must fit within remaining viewport height");
    assert.equal(env.navList.style.maxHeight, `${layout.maxHeightPx}px`);
    assert.equal(env.navList.dataset.visibleCount, "7");
    assert.equal(env.navHint.hidden, false);
    assert.ok(env.navHint.textContent.includes("Showing 7 of 10"));

    // Zero-peek check: 8th pill starts at padTop(8) + 7*38 + 7*6 = 316px; maxHeight must be strictly < 316px
    const nextItemStartPx = 8 + layout.visibleCount * 38 + layout.visibleCount * 6;
    assert.ok(layout.maxHeightPx < nextItemStartPx, `maxHeight (${layout.maxHeightPx}) must not peek into next pill (${nextItemStartPx})`);

    // Fold back on second click
    env.ctx.toggleMobileNav();
    assert.equal(env.navRoot.classList.contains("mobile-expanded"), false);
    assert.equal(env.navToggle.getAttribute("aria-expanded"), "false");
    assert.equal(env.navList.style.maxHeight, "");
    assert.equal(env.navHint.hidden, true);
  });

  it("recalculates visible mobile menu sections dynamically across landscape, tall, and tiny viewports", () => {
    const env = createDashboardSandbox({ innerWidth: 667, innerHeight: 375, navBottom: 56, pillHeight: 38 });

    // Landscape phone (375px tall): ratio cap 0.68 * 375 = 255px -> fits 4 complete sections
    const landscape = env.ctx.toggleMobileNav();
    assert.equal(landscape.visibleCount, 4);
    assert.equal(landscape.hasOverflow, true);
    assert.ok(landscape.maxHeightPx < 255);

    // Tall phone (900px tall): all 10 sections fit cleanly without overflow hint
    env.window.innerWidth = 412;
    env.window.innerHeight = 900;
    env.navToggle.setRect({ bottom: 56 });
    env.window.dispatchEvent("resize");
    assert.equal(env.navList.dataset.visibleCount, "10");
    assert.equal(env.navHint.hidden, true);

    // Extremely tight viewport (160px tall): guarantees at least 1 complete section without negative height
    const tiny = env.ctx.computeMobileNavLayout({
      viewportHeight: 160,
      navBottom: 110,
      itemHeight: 38,
      gap: 6,
      paddingY: 16,
      totalItems: 10,
    });
    assert.equal(tiny.visibleCount, 1);
    assert.equal(tiny.hasOverflow, true);
    assert.ok(tiny.maxHeightPx >= 38);

    // Resizing to desktop (> 768px) resets mobile expanded state and clears mobile maxHeight
    env.window.innerWidth = 1280;
    env.window.dispatchEvent("resize");
    assert.equal(env.navRoot.classList.contains("mobile-expanded"), false);
    assert.equal(env.navList.style.maxHeight, "");
  });

  it("auto-folds mobile menu when selecting a section pill, pressing Escape, or clicking outside", () => {
    const env = createDashboardSandbox({ innerWidth: 375, innerHeight: 667, navBottom: 56 });

    // 1. Selecting a pill folds menu and updates current section badge
    env.ctx.toggleMobileNav();
    assert.equal(env.navRoot.classList.contains("mobile-expanded"), true);
    env.pills[8].dispatchEvent("click"); // Raspberry Pi 5
    assert.equal(env.navRoot.classList.contains("mobile-expanded"), false);
    assert.equal(env.navCurrent.textContent, "🍓 Raspberry Pi 5");

    // 2. Pressing Escape folds menu
    env.ctx.toggleMobileNav();
    assert.equal(env.navRoot.classList.contains("mobile-expanded"), true);
    env.document.dispatchEvent("keydown", { key: "Escape" });
    assert.equal(env.navRoot.classList.contains("mobile-expanded"), false);

    // 3. Clicking outside #noc-nav folds menu
    env.ctx.toggleMobileNav();
    assert.equal(env.navRoot.classList.contains("mobile-expanded"), true);
    env.document.dispatchEvent("click", { target: new MockElement("div") });
    assert.equal(env.navRoot.classList.contains("mobile-expanded"), false);
  });

  it("makes Workers AI Autonomous NOC Analyst collapsible on every viewport (desktop, tablet, mobile) and preserves state across refreshes", () => {
    const sampleAiData = {
      overall_status: "WARNING",
      anomalies_count: 1,
      reason_code: "SCHEDULED",
      model: "@cf/google/gemma-3-12b-it",
      last_analyzed_utc: "2026-11-24 00:45:00 UTC",
      inference_duration_sec: 1.4,
      analysis: "* **Status**: 1 minor warning detected.",
      anomalies: [
        {
          key: "test:warn",
          severity: "WARNING",
          category: "RPi5",
          title: "Test Warning",
          detail: "Sample detail",
        },
      ],
      snoozed_anomalies: [],
    };

    for (const vp of [
      { name: "desktop", width: 1440, height: 900 },
      { name: "tablet", width: 768, height: 1024 },
      { name: "mobile", width: 375, height: 667 },
    ]) {
      const env = createDashboardSandbox({ innerWidth: vp.width, innerHeight: vp.height });
      env.ctx.renderAiSection(sampleAiData);

      const containerHtml = env.elementsById.get("gemma-ai-container")!.innerHTML;
      assert.ok(containerHtml.includes("Workers AI Autonomous NOC Analyst"), `[${vp.name}] missing title`);
      assert.ok(containerHtml.includes("WARNING • 1 finding"), `[${vp.name}] header should display verdict summary`);

      // Initially collapsed (folded) when localStorage is empty
      let body = env.elementsById.get("ai-analyst-body")!;
      let toggle = env.elementsById.get("ai-analyst-toggle")!;
      let chev = env.elementsById.get("ai-analyst-chevron")!;
      assert.equal(body.classList.contains("folded"), true, `[${vp.name}] should start folded`);
      assert.equal(toggle.getAttribute("aria-expanded"), "false", `[${vp.name}] aria-expanded should be false`);

      // Expand panel
      env.ctx.toggleAiAnalyst();
      assert.equal(body.classList.contains("folded"), false, `[${vp.name}] should unfold on toggle`);
      assert.equal(toggle.getAttribute("aria-expanded"), "true", `[${vp.name}] aria-expanded should update to true`);
      assert.equal(chev.innerHTML, "▾ Collapse", `[${vp.name}] chevron should show Collapse`);
      assert.equal(env.localStorage.getItem("noc_ai_analyst_expanded"), "true");

      // Inner assessment toggle remains independently folded until clicked
      const assessBody = env.elementsById.get("noc-assessment-body")!;
      assert.equal(assessBody.classList.contains("folded"), true, `[${vp.name}] inner assessment stays independent`);
      env.ctx.toggleNocAssessment();
      assert.equal(assessBody.classList.contains("folded"), false, `[${vp.name}] inner assessment expands independently`);
      assert.equal(env.elementsById.get("noc-assessment-toggle")!.getAttribute("aria-expanded"), "true");

      // Re-rendering (30s polling refresh) preserves expanded state
      env.ctx.renderAiSection(sampleAiData);
      body = env.elementsById.get("ai-analyst-body")!;
      toggle = env.elementsById.get("ai-analyst-toggle")!;
      assert.equal(body.classList.contains("folded"), false, `[${vp.name}] expanded state must survive re-render`);
      assert.equal(toggle.getAttribute("aria-expanded"), "true");

      // Collapse again
      env.ctx.toggleAiAnalyst();
      assert.equal(body.classList.contains("folded"), true, `[${vp.name}] should fold back on second toggle`);
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      assert.equal(env.localStorage.getItem("noc_ai_analyst_expanded"), "false");
    }
  });
});
