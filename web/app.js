(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const state = { s: null, requests: [], tab: "dashboard" };
  const fmtTok = (n) => (n == null ? "–" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "k" : String(n));
  const fmtUsd = (n) => (n == null ? "–" : "$" + n.toFixed(n < 1 ? 3 : 2));
  const fmtTime = (ms) =>
    ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "–";
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function rel(iso, now = Date.now()) {
    if (!iso) return "–";
    const t = typeof iso === "number" ? iso : Date.parse(iso);
    if (!isFinite(t)) return "–";
    let d = Math.round((t - now) / 1000);
    const past = d < 0;
    d = Math.abs(d);
    const days = Math.floor(d / 86400),
      h = Math.floor((d % 86400) / 3600),
      m = Math.floor((d % 3600) / 60),
      s = d % 60;
    const out = days ? `${days} day${days === 1 ? "" : "s"} ${h} hr` : h ? `${h} hr ${m} min` : m ? `${m} min` : `${s} sec`;
    return past ? out + " ago" : out;
  }
  const api = async (p, init) => {
    const r = await fetch(p, init);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  };
  const showErr = (sel, err) => {
    const el = $(sel);
    if (el) el.innerHTML = `<tr><td colspan="12" class="muted">${esc(err.message)}</td></tr>`;
  };

  // theme: light / dark / system, persisted per browser
  const themeBtn = $("#theme");
  const applyThemeIcon = () => {
    const t = document.documentElement.dataset.theme || "";
    $("#theme-icon").textContent = t === "light" ? "☀" : t === "dark" ? "☾" : "◐";
    themeBtn.title = `Theme: ${t || "follows system"}. Click to cycle light / dark / system`;
  };
  themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || "";
    const next = cur === "" ? "light" : cur === "light" ? "dark" : "";
    document.documentElement.dataset.theme = next;
    try {
      if (next) localStorage.setItem("cm-theme", next);
      else localStorage.removeItem("cm-theme");
    } catch {}
    applyThemeIcon();
  });
  applyThemeIcon();

  // tabs
  $$("nav button").forEach((b) =>
    b.addEventListener("click", () => {
      $$("nav button").forEach((x) => x.classList.toggle("active", x === b));
      $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
      state.tab = b.dataset.tab;
      if (state.tab === "requests") loadRequests();
      if (state.tab === "sessions") loadSessions();
      if (state.tab === "stats") loadStats();
    }),
  );

  // controls
  const thr = $("#threshold");
  thr.addEventListener("input", () => ($("#thresholdVal").textContent = thr.value));
  thr.addEventListener("change", () =>
    api("/api/policy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threshold: Number(thr.value) }) }),
  );
  const wthr = $("#weeklyThreshold");
  wthr.addEventListener("input", () => ($("#weeklyThresholdVal").textContent = wthr.value));
  wthr.addEventListener("change", () =>
    api("/api/policy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ weeklyThreshold: Number(wthr.value) }) }),
  );
  let routeBusy = false;
  const setRoute = async (body) => {
    if (routeBusy) return;
    routeBusy = true;
    $("#route-on").disabled = true;
    $("#route-direct").disabled = true;
    try {
      await api("/api/route", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (err) {
      alert(`could not change routing: ${err.message}`);
    } finally {
      routeBusy = false;
      $("#route-on").disabled = false;
      $("#route-direct").disabled = false;
    }
  };
  // "via claudemanager" ignores clicks while it is the active mode
  $("#route-on").addEventListener("click", () => {
    if (!state.s || state.s.nativeRouting) return;
    setRoute({ on: true });
  });
  // the direct dropdown always switches: to direct mode, and to the chosen account
  $("#route-direct").addEventListener("change", (e) => {
    const v = e.target.value;
    if (v === "") return;
    setRoute({ on: false, account: v === "stock" ? "stock" : v });
  });
  const post = (body) => api("/api/policy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  $("#preferSooner").addEventListener("change", (e) => post({ preferSoonerReset: e.target.checked }));
  $("#perishableHours").addEventListener("change", (e) => post({ perishableHours: Number(e.target.value) }));
  $("#modelAware").addEventListener("change", (e) => post({ modelAwareAllocation: e.target.checked }));
  $("#distribute").addEventListener("change", (e) => post({ distribute: e.target.checked }));
  $("#pin").addEventListener("change", (e) => {
    const v = e.target.value;
    if (v) api(`/api/accounts/${encodeURIComponent(v)}/pin`, { method: "POST" });
    else api("/api/unpin", { method: "POST" });
  });

  function meter(label, w, threshold) {
    const u = w && w.utilization != null ? w.utilization : null;
    const pct = u == null ? 0 : Math.min(100, u);
    const cls = u == null ? "" : u >= threshold ? "bad" : u >= threshold * 0.75 ? "warn" : "";
    const reset = w && w.resetsAt ? `resets in ${rel(w.resetsAt)}` : u === 0 ? "not started" : "";
    return `<div class="meter"><div class="lbl"><span>${esc(label)}</span><span><b>${u == null ? "?" : Math.round(u) + "%"}</b> <span class="muted">${esc(reset)}</span></span></div>
      <div class="track"><div class="fill ${cls}" style="width:${pct}%"></div><div class="mark" style="left:${threshold}%"></div></div></div>`;
  }
  const planLabel = (a) => {
    const m = /max_(\d+)x/.exec(a.tier || "");
    return m ? `Max ${m[1]}x` : a.subscriptionType ? a.subscriptionType[0].toUpperCase() + a.subscriptionType.slice(1) : "";
  };
  const orgLabel = (a) => (a.orgName && a.email && a.orgName.toLowerCase() !== `${a.email.toLowerCase()}'s organization` ? a.orgName : "");

  function renderDashboard() {
    const s = state.s;
    if (!s) return;
    const now = Date.now();
    const sess = s.sessions || {};
    const totalSess = Object.values(sess).reduce((a, b) => a + b, 0);
    $("#active").textContent = totalSess ? String(totalSess) : "0";
    $("#active").parentElement.title = totalSess
      ? `active in the last 10 min: ${Object.entries(sess)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}`
      : "no Claude Code sessions in the last 10 minutes";
    if (document.activeElement !== thr) {
      thr.value = s.policy.threshold;
      $("#thresholdVal").textContent = s.policy.threshold;
    }
    if (document.activeElement !== wthr) {
      wthr.value = s.policy.weeklyThreshold;
      $("#weeklyThresholdVal").textContent = s.policy.weeklyThreshold;
    }
    if (document.activeElement !== $("#preferSooner")) $("#preferSooner").checked = s.policy.preferSoonerReset !== false;
    if (document.activeElement !== $("#perishableHours")) $("#perishableHours").value = s.policy.perishableHours ?? 24;
    if (document.activeElement !== $("#modelAware")) $("#modelAware").checked = s.policy.modelAware !== false;
    if (document.activeElement !== $("#distribute")) $("#distribute").checked = !!s.policy.distribute;
    if (!routeBusy) {
      const on = !!s.nativeRouting;
      const stock = s.stockAccount && s.stockAccount.email ? s.stockAccount.email : "stored login";
      const d = s.direct || { account: null, options: [] };
      $("#route-on").className = on ? "on" : "";
      $("#route-direct-wrap").className = "seg-select" + (on ? "" : " off");
      const activeName = on ? null : d.account;
      const activeEmail = activeName ? (d.options.find((o) => o.name === activeName) || {}).email || "" : stock;
      const activeLabel = activeName ? `${activeName} · ${activeEmail}` : stock;
      $("#route-direct-lbl").textContent = on ? "direct to Anthropic" : `direct as ${activeName || "stored login"}`;
      $("#route-direct-wrap").title = on ? "Send new sessions straight to Anthropic as…" : `New sessions go straight to Anthropic as ${activeLabel}`;
      const sel = $("#route-direct");
      const opts = [
        `<option value="" disabled ${on ? "selected" : ""}>send new sessions direct to Anthropic as…</option>`,
        `<option value="stock" ${!on && !d.account ? "selected" : ""}>${esc(stock)} (stored ~/.claude login)</option>`,
        ...d.options.map(
          (o) =>
            `<option value="${esc(o.name)}" ${!on && d.account === o.name ? "selected" : ""} ${o.hasToken ? "" : "disabled"}>${esc(o.name)} · ${esc(o.email || "")}${o.hasToken ? "" : " (needs a long-lived token)"}</option>`,
        ),
      ].join("");
      if (sel.innerHTML !== opts) sel.innerHTML = opts;
      $("#routing").title = on
        ? `New Claude Code sessions send requests to claudemanager at ${s.nativeRouting}. Running sessions keep their route.`
        : `New Claude Code sessions go straight to Anthropic as ${activeLabel}; claudemanager is bypassed. Running sessions keep their route.`;
    }
    const pinSel = $("#pin");
    const opts = [
      '<option value="">auto</option>',
      ...s.accounts.map((a) => `<option value="${esc(a.name)}" ${s.pinned === a.name ? "selected" : ""}>${esc(a.name)}</option>`),
    ].join("");
    if (pinSel.innerHTML !== opts) pinSel.innerHTML = opts;
    const fsel = $("#f-account");
    const fopts = ['<option value="">all accounts</option>', ...s.accounts.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}</option>`)].join("");
    if (fsel.innerHTML !== fopts) fsel.innerHTML = fopts;

    $("#cards").innerHTML =
      s.accounts
        .map((a) => {
          const u = a.usage;
          const models = u ? Object.keys(u.models).sort() : [];
          const nSess = sess[a.name] || 0;
          let pill = '<span class="pill on">ok</span>';
          let note = "";
          if (a.disabled) pill = '<span class="pill">disabled</span>';
          else if (a.needsLogin && a.hasInferenceToken) {
            pill =
              '<span class="pill on">routing ok</span> <span class="pill warn" title="The long-lived token cannot read usage; log in to see weekly and per-model numbers">no usage login</span>';
            note = `<code>cm accounts login ${esc(a.name)}</code> restores the usage numbers`;
          } else if (a.needsLogin) {
            pill = '<span class="pill off">needs re-login</span>';
            note = `<code>cm accounts login ${esc(a.name)}</code>`;
          } else if (!a.tokenOk) pill = '<span class="pill off">auth error</span>';
          else if (a.exhaustedUntil && a.exhaustedUntil > now) pill = `<span class="pill off">exhausted · ${rel(a.exhaustedUntil)}</span>`;
          else if (a.eligible === false && a.eligibilityTier === 2)
            pill = `<span class="pill warn" title="Over a switch threshold; used only if no account is within thresholds">over ${esc(a.ineligibleReason || "limit")} · fallback</span>`;
          else if (a.eligible === false) pill = `<span class="pill off">${esc(a.ineligibleReason || "limit")} at 100%</span>`;
          else if (a.lastError && /rate-limited/.test(a.lastError)) {
            pill = '<span class="pill on">ok</span>';
            note = `poll backoff: ${esc(a.lastError.replace(/usage poll rate-limited; /, ""))}`;
          } else if (a.lastError) {
            pill = `<span class="pill warn" title="${esc(a.lastError)}">error</span>`;
            note = `⚠ ${esc(a.lastError)}`;
          } else if (!u) pill = '<span class="pill">no data</span>';
          const isActive = nSess > 0;
          const org = orgLabel(a);
          const plan = planLabel(a);
          return `<div class="card ${isActive ? "active" : ""} ${a.disabled || (!a.tokenOk && !a.hasInferenceToken) ? "bad" : ""}">
        <div class="card-head">
          <div class="card-title">
            <h2>${esc(a.name)}</h2>
            ${pill}
            ${nSess ? `<span class="pill info" title="Claude Code sessions currently assigned here">${nSess} session${nSess === 1 ? "" : "s"}</span>` : ""}
            ${s.pinned === a.name ? '<span class="pill info">pinned</span>' : ""}
          </div>
          <div class="actions">
            ${s.pinned === a.name ? `<button data-act="unpin" title="Return to automatic routing">unpin</button>` : `<button data-act="pin" data-name="${esc(a.name)}" title="Send all new sessions here">pin</button>`}
            <div class="menu"><button data-act="menu" title="More">⋯</button>
              <div class="menu-list">
                <button data-act="rename" data-name="${esc(a.name)}">Rename…</button>
                <button data-act="login" data-name="${esc(a.name)}">Sign in again</button>
                <button data-act="setup-token" data-name="${esc(a.name)}">${a.hasInferenceToken ? "Replace long-lived token" : "Set up long-lived token"}</button>
                <button data-act="${a.disabled ? "enable" : "disable"}" data-name="${esc(a.name)}">${a.disabled ? "Enable" : "Disable"}</button>
                <button data-act="remove" data-name="${esc(a.name)}" class="danger">Remove from cm…</button>
              </div>
            </div>
          </div>
        </div>
        <div class="ident">
          <span class="email">${esc(a.email || "")}</span>
          ${plan ? `<span class="plan">${esc(plan)}</span>` : ""}
          ${org ? `<span class="muted">· ${esc(org)}</span>` : ""}
          ${a.hasInferenceToken ? '<span class="tok" title="Traffic uses a long-lived setup-token; no refresh needed">long-lived token</span>' : ""}
          ${a.profile && a.profile.nextBillingAt ? `<span class="muted" title="Estimated from the subscription start date (${esc((a.profile.subscriptionCreatedAt || "").slice(0, 10))}); Anthropic does not expose the billing cycle directly${a.profile.subscriptionStatus ? ` · subscription ${esc(a.profile.subscriptionStatus)}` : ""}">· renews ~${esc(new Date(a.profile.nextBillingAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}${a.profile.subscriptionStatus && a.profile.subscriptionStatus !== "active" ? ` <b style="color:var(--yellow)">${esc(a.profile.subscriptionStatus)}</b>` : ""}</span>` : ""}
        </div>
        ${meter("session · 5 h", u && u.fiveHour, s.policy.threshold)}
        ${meter("weekly · all models", u && u.sevenDay, s.policy.weeklyThreshold)}
        ${models.map((m) => meter(`weekly · ${m}`, u.models[m], s.policy.weeklyThreshold)).join("")}
        <div class="card-foot">
          <span>${u ? `updated ${rel(u.fetchedAt)}${u.source === "headers" ? " · live" : ""}` : "no usage data yet"}${a.requestCount ? ` · ${a.requestCount} req since start` : ""}</span>
          ${note ? `<span class="note">${note}</span>` : ""}
        </div>
      </div>`;
        })
        .join("") || '<div class="panel muted">No accounts yet. Run <code>cm accounts add &lt;name&gt;</code>.</div>';
    $$("#cards button").forEach((b) =>
      b.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const act = b.dataset.act,
          n = b.dataset.name;
        const post = (path, body) =>
          api(path, { method: "POST", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).catch((e) =>
            alert(e.message),
          );
        if (act === "menu") {
          const m = b.parentElement;
          const open = m.classList.contains("open");
          $$(".menu.open").forEach((x) => x.classList.remove("open"));
          if (!open) m.classList.add("open");
          return;
        }
        $$(".menu.open").forEach((x) => x.classList.remove("open"));
        if (act === "pin") return post(`/api/accounts/${encodeURIComponent(n)}/pin`);
        if (act === "unpin") return post("/api/unpin");
        if (act === "rename") {
          const to = prompt(`New name for "${n}" (letters, digits, . _ -):`, n);
          if (to && to !== n) return post(`/api/accounts/${encodeURIComponent(n)}/rename`, { name: to.trim() });
          return;
        }
        if (act === "login") {
          if (confirm(`Open a browser sign-in for "${n}"?`)) return post(`/api/accounts/${encodeURIComponent(n)}/login`);
          return;
        }
        if (act === "setup-token") {
          if (confirm(`Run claude setup-token for "${n}"? A browser sign-in opens; sign in as this account. The token is stored automatically.`))
            return post(`/api/accounts/${encodeURIComponent(n)}/setup-token`);
          return;
        }
        if (act === "remove") {
          if (confirm(`Remove "${n}" from claudemanager? Its login stays on this machine (CLAUDE_CONFIG_DIR=… claude auth logout removes it).`))
            return api(`/api/accounts/${encodeURIComponent(n)}`, { method: "DELETE" }).catch((e) => alert(e.message));
          return;
        }
        return post(`/api/accounts/${encodeURIComponent(n)}/${act}`);
      }),
    );
    document.addEventListener("click", () => $$(".menu.open").forEach((x) => x.classList.remove("open")), { once: true });
    // promotions (offers): one panel per active offer; nothing when none
    const offersEl = $("#offers");
    const offersList = s.offers || [];
    offersEl.innerHTML = offersList
      .map((x) => {
        const p = x.plan;
        const pillFor = (q) =>
          q.status === "reset-now"
            ? '<span class="pill warn">RESET NOW</span>'
            : q.status === "used"
              ? '<span class="pill on">used</span>'
              : q.status === "scheduled"
                ? '<span class="pill info">scheduled</span>'
                : `<span class="pill">${esc(q.status)}</span>`;
        return `<div class="panel freereset" data-offer="${esc(x.id)}">
        <div class="cap-head">
          <h3>${esc(x.title)} <span class="muted">· ${esc(p.summary)} · until ${esc(x.deadline.slice(0, 10))}</span></h3>
          <label class="pol" title="Route new sessions to one unused account at a time so it fills early and its reset is worth a full window"><input type="checkbox" class="fr-concentrate" ${p.concentrate ? "checked" : ""}> <span class="k">concentrate traffic</span></label>
        </div>
        ${x.description ? `<div class="muted" style="font-size:12px;margin-bottom:6px">${esc(x.description)}${x.url ? ` <a href="${esc(x.url)}" target="_blank" rel="noopener">details</a>` : ""}</div>` : ""}
        <div>${p.plans
          .map(
            (q) => `<div class="fr-row ${q.status === "reset-now" ? "now" : ""}">
          <b>${esc(q.account)}${p.drainTarget === q.account ? ' <span class="muted" title="new sessions are being routed here to fill it">◀ filling</span>' : ""}</b>
          <span>${pillFor(q)}</span>
          <span class="why">${q.weeklyUtil == null ? "" : `${esc(q.bindingWindow)} ${Math.round(q.weeklyUtil)}%, natural reset ${rel(q.weeklyResetsAt)} · `}${esc(q.reason)}</span>
          <span>${q.status === "used" ? `<button data-fr="unused" data-name="${esc(q.account)}">undo</button>` : q.status === "expired" ? "" : `<button data-fr="used" data-name="${esc(q.account)}" title="Click after using the reset in the Claude app (the daemon also detects it)">I used it</button>`}</span>
        </div>`,
          )
          .join("")}</div>
      </div>`;
      })
      .join("");
    $$("#offers .fr-row button").forEach((b) =>
      b.addEventListener("click", () =>
        api(`/api/offers/${encodeURIComponent(b.closest("[data-offer]").dataset.offer)}/${encodeURIComponent(b.dataset.name)}/${b.dataset.fr}`, {
          method: "POST",
        }).catch((e) => alert(e.message)),
      ),
    );
    $$("#offers .fr-concentrate").forEach((cb) => cb.addEventListener("change", (e) => post({ offers: { concentrate: e.target.checked } })));
    // jobs (login / setup-token in progress)
    $("#jobs").innerHTML = (s.jobs || [])
      .filter((j) => j.status === "running" || Date.now() - (j.finishedAt || 0) < 120000)
      .map(
        (j) => `<div class="job ${j.status}"><div class="row2">
      <b>${j.kind === "login" ? "Sign-in" : "Long-lived token"}</b> <span>${esc(j.account)}</span>
      <span class="pill ${j.status === "running" ? "info" : j.status === "done" ? "on" : "off"}">${j.status}</span>
      ${j.status === "running" ? (j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener">open the sign-in page</a> <span class="muted">if the browser did not open</span>` : `<span class="muted">waiting for the browser sign-in…</span>`) + ` <button data-job="${esc(j.id)}" class="cancel">cancel</button>` : ""}
      ${j.result ? `<span>${esc(j.result)}</span>` : ""}${j.error ? `<span style="color:var(--red)">${esc(j.error)}</span>` : ""}
    </div>${j.output ? `<pre>${esc(j.output.slice(-1500))}</pre>` : ""}</div>`,
      )
      .join("");
    $$("#jobs button.cancel").forEach((b) => b.addEventListener("click", () => api(`/api/jobs/${b.dataset.job}/cancel`, { method: "POST" })));
    $("#events").innerHTML =
      [...(s.events || [])]
        .reverse()
        .slice(0, 40)
        .map((e) => {
          const t = new Date(e.at).toLocaleTimeString();
          let txt = esc(e.type);
          if (e.type === "switch")
            txt = `<span class="pill ${e.reason === "relaxed" ? "warn" : "info"}">${e.reason === "relaxed" ? "switch · nothing within thresholds" : e.reason === "perishable" ? "switch · quota resets soon" : "switch"}</span> ${e.session ? `<span class="muted">session ${esc(e.session.slice(0, 8))}</span> ` : ""}${esc(e.from || "(none)")} → <b>${esc(e.to)}</b> <span class="muted">(${esc(e.reason)})</span>`;
          else if (e.type === "assign")
            txt = `<span class="pill">new session</span> <span class="muted">${esc(e.session.slice(0, 8))}</span> → <b>${esc(e.account)}</b>${e.relaxed ? ' <span class="muted">(over threshold, best available)</span>' : ""}`;
          else if (e.type === "exhausted")
            txt = `<span class="pill off">exhausted</span> ${esc(e.account)} <span class="muted">(${esc(e.claim || "?")}, until ${rel(e.until)})</span>`;
          else if (e.type === "all_exhausted")
            txt = `<span class="pill off">all exhausted</span> <span class="muted">earliest reset ${rel(e.earliestResetAt)}</span>`;
          else if (e.type === "limit")
            txt =
              e.kind === "reset"
                ? `<span class="pill on">reset</span> ${esc(e.account)} ${esc(e.window)} <span class="muted">(+${Math.round(e.freed)}%)</span>`
                : `<span class="pill ${e.kind === "recovered" ? "on" : e.kind === "exhausted" ? "off" : "warn"}">${esc(e.kind)}</span> <b>${esc(e.family)}</b> <span class="muted">pooled ${Math.round(e.headroom)}%${e.nextResetAt ? ", next reset " + rel(e.nextResetAt) : ""}</span>`;
          else if (e.type === "free_reset")
            txt = `<span class="pill ${e.kind === "used" ? "on" : "warn"}">${e.kind === "used" ? "free reset used" : "free reset: use it now"}</span> <b>${esc(e.account)}</b> <span class="muted">${esc(e.detail)}</span>`;
          else if (e.type === "model_fallback")
            txt = `<span class="pill info">model fallback</span> ${esc(e.from)} → <b>${esc(e.to)}</b> <span class="muted">session ${esc((e.session || "?").slice(0, 8))} · ${esc(e.reason)}</span>`;
          else if (e.type === "fallback")
            txt = `<span class="pill off">fail-open</span> ${esc(e.reason)} <span class="muted">— requests are using the caller's own login</span>`;
          else if (e.type === "error") txt = `<span class="pill warn">error</span> ${esc(e.account || "")} ${esc(e.message)}`;
          return `<li><span class="t">${t}</span><span>${txt}</span></li>`;
        })
        .join("") || '<li class="muted">no events yet</li>';
    const p = s.perf && (s.perf.lastMinute || s.perf.current);
    $("#dbinfo").innerHTML =
      (s.db
        ? `${s.db.requests} requests logged · ${s.db.sizeMb} MB file (${s.db.liveMb ?? s.db.sizeMb} MB live) · bodies: ${esc(s.log.bodies)} · retention ${s.log.retentionDays}d · writer: ${esc(s.writerMode || "off")}`
        : "request logging disabled") +
      (p
        ? `<br>proxy perf (${s.perf.lastMinute ? "last minute" : "so far"}): event-loop lag p99 <b>${p.loopP99Ms} ms</b> max <b>${p.loopMaxMs} ms</b> · overhead per request p50 <b>${p.overheadP50Ms ?? "–"} ms</b> p99 <b>${p.overheadP99Ms ?? "–"} ms</b> · upstream first byte p50 <b>${p.ttfbP50Ms ?? "–"} ms</b> · ${p.requests} req`
        : "");
  }

  // requests
  function reqRow(r) {
    const st = r.error
      ? `<span class="pill off" title="${esc(r.error)}">${r.statusCode ?? "err"}</span>`
      : r.retried
        ? `<span class="pill warn">${r.statusCode} retry</span>`
        : `<span class="pill ${r.statusCode >= 400 ? "off" : "on"}">${r.statusCode ?? "…"}</span>`;
    return `<tr data-id="${r.id}"><td>${r.id}</td><td>${fmtTime(r.startedAt)}</td><td>${esc(r.account || "–")}</td><td>${esc((r.model || "–").replace("claude-", ""))}${r.modelFallbackFrom ? ` <span class="pill info" title="requested ${esc(r.modelFallbackFrom)}">fallback</span>` : ""}</td><td title="${esc(r.sessionId || "")}">${esc((r.sessionId || "").slice(0, 8))}</td>
      <td class="r">${fmtTok(r.inputTokens)}</td><td class="r">${fmtTok(r.outputTokens)}</td><td class="r">${fmtTok(r.cacheReadTokens)}</td><td class="r">${fmtUsd(r.estCostUsd)}</td><td class="r">${r.latencyMs ?? "–"}</td><td>${st}</td><td class="prompt">${esc(r.lastUserText || "")}</td></tr>`;
  }
  async function loadRequests() {
    const q = new URLSearchParams();
    const set = (k, v) => v && q.set(k, v);
    set("q", $("#f-q").value);
    set("account", $("#f-account").value);
    set("model", $("#f-model").value);
    set("session", $("#f-session").value);
    q.set("limit", "200");
    let rows;
    try {
      rows = await api("/api/requests?" + q);
    } catch (e) {
      showErr("#requests tbody", e);
      return;
    }
    state.requests = rows;
    $("#requests tbody").innerHTML = rows.map(reqRow).join("") || '<tr><td colspan="12" class="muted">no requests yet</td></tr>';
  }
  $("#f-apply").addEventListener("click", loadRequests);
  $("#f-q").addEventListener("keydown", (e) => e.key === "Enter" && loadRequests());
  $("#requests tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) showRequest(Number(tr.dataset.id));
  });
  $("#sessions tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-session]");
    if (tr) showContext(tr.dataset.session);
  });

  function block(role, content) {
    const body =
      typeof content === "string"
        ? esc(content)
        : (Array.isArray(content) ? content : [content])
            .map((c) => {
              if (!c) return "";
              if (typeof c === "string") return esc(c);
              if (c.type === "text") return esc(c.text);
              if (c.type === "thinking") return `<span class="muted">[thinking] ${esc(c.thinking)}</span>`;
              if (c.type === "tool_use") return `<b>[tool_use ${esc(c.name)}]</b> ${esc(JSON.stringify(c.input, null, 1))}`;
              if (c.type === "tool_result")
                return `<b>[tool_result]</b> ${esc(typeof c.content === "string" ? c.content : JSON.stringify(c.content, null, 1))}`;
              return esc(JSON.stringify(c));
            })
            .join("\n");
    return `<div class="msg ${esc(role)}"><div class="role">${esc(role)}</div>${body}</div>`;
  }
  async function showRequest(id) {
    const r = await api(`/api/requests/${id}`);
    const b = r.body,
      p = r.response;
    let html = `<h3 style="margin:0 0 8px">request #${r.id}</h3>
      <div class="kv"><span>time <b>${fmtTime(r.startedAt)}</b></span><span>account <b>${esc(r.account)}</b></span><span>model <b>${esc(r.model)}</b></span><span>session <b>${esc(r.sessionId || "–")}</b></span><span>status <b>${r.statusCode}</b></span><span>latency <b>${r.latencyMs} ms</b></span>
      <span>in <b>${fmtTok(r.inputTokens)}</b></span><span>out <b>${fmtTok(r.outputTokens)}</b></span><span>cache read <b>${fmtTok(r.cacheReadTokens)}</b></span><span>cache write <b>${fmtTok(r.cacheWriteTokens)}</b></span><span>cost <b>${fmtUsd(r.estCostUsd)}</b></span><span>stop <b>${esc(r.stopReason || "–")}</b></span>
      ${r.retried ? "<span class='pill warn'>retried</span>" : ""}${r.switchedFrom ? `<span class='pill info'>switched from ${esc(r.switchedFrom)}</span>` : ""}
      ${r.rl ? `<span>ratelimit 5h <b>${r.rl.fiveHourUtil}%</b> 7d <b>${r.rl.sevenDayUtil}%</b> ${esc(r.rl.status || "")} ${esc(r.rl.claim || "")}</span>` : ""}</div>`;
    if (b) {
      if (b.system) html += `<details><summary>system prompt (${b.system.length} chars)</summary>${block("system", b.system)}</details>`;
      if (b.tools) html += `<details><summary>${b.tools.length} tools</summary><div class="msg">${esc(b.tools.map((t) => t.name).join(", "))}</div></details>`;
      const msgs = Array.isArray(b.messages) ? b.messages : [];
      html += `<details open><summary>${msgs.length} messages${b.mode === "lastTurn" ? " (last turn only)" : ""}</summary>${msgs.map((m) => block(m.role, m.content)).join("")}</details>`;
      if (b.params && Object.keys(b.params).length) html += `<details><summary>params</summary><pre>${esc(JSON.stringify(b.params, null, 2))}</pre></details>`;
    } else html += `<p class="muted">body not stored</p>`;
    if (p) {
      html += `<h4 style="margin:12px 0 4px">response</h4>`;
      html += p.content ? block("assistant", p.content) : "";
      if (p.rawError) html += `<div class="msg" style="border-color:var(--red)">${esc(p.rawError)}</div>`;
    }
    $("#modal-body").innerHTML = html;
    $("#modal").classList.remove("hidden");
  }
  $("#modal-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
  $("#modal").addEventListener("click", (e) => e.target === $("#modal") && $("#modal").classList.add("hidden"));

  async function loadSessions() {
    const hours = $("#at-hours").value;
    let r;
    try {
      r = await api(`/api/attribution?hours=${hours}&limit=200`);
    } catch (e) {
      showErr("#sessions tbody", e);
      return;
    }
    $("#at-meta").textContent =
      `pool consumed ${r.weeklyConsumed == null ? "?" : Math.round(r.weeklyConsumed) + "% weekly"} · ${r.sessionConsumed == null ? "?" : Math.round(r.sessionConsumed) + "% of 5-hour windows"} · est. ${fmtUsd(r.totalCostUsd)} at API prices`;
    $("#sessions tbody").innerHTML =
      r.sessions
        .map(
          (s) =>
            `<tr data-session="${esc(s.sessionId)}"><td title="${esc(s.sessionId)}">${esc(s.sessionId.slice(0, 8))}</td><td class="r"><b>${Math.round(s.share * 100)}%</b></td><td class="r">${s.weeklyPct == null ? "–" : s.weeklyPct.toFixed(1)}</td><td class="r">${s.sessionPct == null ? "–" : s.sessionPct.toFixed(1)}</td><td class="r">${s.requests}</td><td class="r">${fmtTok(s.cacheReadTokens)}</td><td class="r">${fmtTok(s.maxContext)}</td><td>${esc(
              Object.entries(s.familyShare)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
                .join(" "),
            )}</td><td>${esc(s.accounts || "")}</td><td class="prompt">${esc((s.firstPrompt || "").replace(/\s+/g, " ").slice(0, 80))}</td><td>${fmtTime(s.lastSeen)}</td></tr>`,
        )
        .join("") || '<tr><td colspan="11" class="muted">no sessions in this window</td></tr>';
  }
  $("#at-hours").addEventListener("change", loadSessions);

  async function showContext(sid) {
    let r;
    try {
      r = await api(`/api/sessions/${encodeURIComponent(sid)}/context`);
    } catch (e) {
      alert(e.message);
      return;
    }
    const peak = Math.max(1, r.peakContext);
    const W = 640,
      H = 120;
    const pts = r.turns.map((t, i) => [r.turns.length > 1 ? (i / (r.turns.length - 1)) * W : W / 2, H - (t.context / peak) * (H - 10)]);
    const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const area = pts.length ? `${path} L${pts[pts.length - 1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z` : "";
    const writes = r.turns
      .map((t, i) =>
        t.cacheWriteTokens > 2000
          ? `<circle cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="3" fill="var(--yellow)"><title>turn #${t.id}: cache write ${fmtTok(t.cacheWriteTokens)}</title></circle>`
          : "",
      )
      .join("");
    let html = `<h3 style="margin:0 0 6px">session ${esc(sid.slice(0, 8))} · context growth</h3>
      <div class="kv"><span>turns <b>${r.turns.length}</b></span><span>context <b>${fmtTok(r.firstContext)} → ${fmtTok(r.lastContext)}</b></span><span>peak <b>${fmtTok(r.peakContext)}</b></span><span>cache read <b>${fmtTok(r.cacheReadTotal)}</b></span><span>cache write <b>${fmtTok(r.cacheWriteTotal)}</b> <span class="muted">(rebuilt rather than reused)</span></span></div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block;background:var(--bg);border:1px solid var(--border);border-radius:6px"><path d="${area}" fill="rgba(122,162,247,.18)"></path><path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2"></path>${writes}</svg>
      <div class="muted" style="font-size:11px;margin:4px 0 10px">prompt tokens per turn (uncached input + cache read + cache write); yellow dots mark turns that re-wrote cache</div>`;
    if (r.biggestJumps.length)
      html += `<div class="kv"><span>biggest jumps: ${r.biggestJumps.map((t) => `<b>#${t.id}</b> +${fmtTok(t.delta)}`).join(", ")}</span></div>`;
    if (r.latest) {
      html += `<div class="kv"><span>latest prompt: system <b>${fmtTok(r.latest.systemChars)}</b> chars</span><span><b>${r.latest.toolsCount}</b> tools (${fmtTok(r.latest.toolsChars)} chars)</span><span><b>${r.latest.messages}</b> messages</span><span>tool results <b>${fmtTok(r.latest.totalToolResultChars)}</b> chars</span></div>`;
      if (r.latest.largestToolResults.length)
        html += `<h4 style="margin:10px 0 4px">largest tool results in the latest prompt</h4><table class="grid"><thead><tr><th class="r">chars</th><th>tool</th><th>preview</th></tr></thead><tbody>${r.latest.largestToolResults.map((x) => `<tr><td class="r">${fmtTok(x.chars)}</td><td>${esc(x.tool || "?")}</td><td class="prompt">${esc(x.preview.replace(/\s+/g, " "))}</td></tr>`).join("")}</tbody></table>`;
    } else html += `<p class="muted">no stored prompt for this session (log.bodies is none?)</p>`;
    $("#modal-body").innerHTML = html;
    $("#modal").classList.remove("hidden");
  }
  async function loadStats() {
    const by = $("#s-by").value,
      since = $("#s-since").value;
    let rows;
    try {
      rows = await api(`/api/stats?by=${by}${since ? `&since=${Date.now() - Number(since) * 3600e3}` : ""}`);
    } catch (e) {
      showErr("#stats tbody", e);
      return;
    }
    $("#stats tbody").innerHTML =
      rows
        .map(
          (r) =>
            `<tr><td>${esc(String(r.key ?? "–").replace("claude-", ""))}</td><td class="r">${r.requests}</td><td class="r">${r.errors}</td><td class="r">${r.retried ?? 0}</td><td class="r">${fmtTok(r.inputTokens)}</td><td class="r">${fmtTok(r.outputTokens)}</td><td class="r">${fmtTok(r.cacheReadTokens)}</td><td class="r">${fmtTok(r.cacheWriteTokens)}</td><td class="r">${fmtUsd(r.estCostUsd)}</td><td class="r">${Math.round(r.avgLatencyMs || 0)}</td></tr>`,
        )
        .join("") || '<tr><td colspan="10" class="muted">nothing yet</td></tr>';
    const hist = await api("/api/usage-history?hours=24");
    const byAcc = {};
    for (const h of hist) (byAcc[h.account] ||= []).push(h);
    $("#history").innerHTML =
      Object.keys(byAcc)
        .sort()
        .map((a) => `<div class="panel"><h3>${esc(a)}</h3><canvas data-acc="${esc(a)}" width="600" height="180"></canvas></div>`)
        .join("") || '<p class="muted">no history yet</p>';
    for (const cv of $$("#history canvas")) {
      const pts = byAcc[cv.dataset.acc],
        ctx = cv.getContext("2d"),
        W = cv.width,
        H = cv.height;
      const t0 = Date.now() - 24 * 3600e3,
        t1 = Date.now();
      ctx.clearRect(0, 0, W, H);
      const thrY = H - ((state.s?.policy.threshold ?? 90) / 100) * H;
      ctx.strokeStyle = "rgba(255,93,93,.5)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, thrY);
      ctx.lineTo(W, thrY);
      ctx.stroke();
      ctx.setLineDash([]);
      const draw = (key, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        for (const p of pts) {
          if (p[key] == null) continue;
          const x = ((p.at - t0) / (t1 - t0)) * W,
            y = H - (Math.min(100, p[key]) / 100) * H;
          started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          started = true;
        }
        ctx.stroke();
      };
      draw("fiveHourUtil", "#3ddc84");
      draw("sevenDayUtil", "#7aa2f7");
    }
  }
  $("#s-by").addEventListener("change", loadStats);
  $("#s-since").addEventListener("change", loadStats);

  $("#add-account").addEventListener("click", async () => {
    const name = prompt("Account name (an alias you choose; letters, digits, . _ -):");
    if (!name) return;
    const email = prompt("Email to pre-fill on the sign-in page (optional):") || undefined;
    try {
      await api("/api/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim(), email }) });
    } catch (e) {
      alert(e.message);
    }
  });

  // runway
  const hrs = (h) => (h == null ? "–" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(1)} d`);
  async function loadRunway() {
    let r;
    try {
      r = await api("/api/runway");
    } catch (e) {
      $("#rw-body").textContent = `runway unavailable: ${e.message}`;
      return;
    }
    if (!r || !Array.isArray(r.windows)) {
      $("#rw-body").textContent = "runway needs a newer daemon: run `cm daemon restart`";
      return;
    }
    const colors = { ok: "var(--green)", tight: "var(--yellow)", critical: "var(--red)", unknown: "var(--muted)" };
    const wins = r.windows
      .map((w) => {
        const segs = w.perAccount
          .map(
            (p) =>
              `<div class="seg" style="width:${(Math.min(100, p.utilization ?? 0) / w.capacity) * 100}%;background:${colors[w.status]}" title="${esc(p.account)} ${p.utilization == null ? "?" : Math.round(p.utilization) + "%"}"></div><div class="seg" style="width:${(Math.max(0, 100 - (p.utilization ?? 0)) / w.capacity) * 100}%"></div>`,
          )
          .join("");
        const next = w.nextReset
          ? `next reset <b>${esc(w.nextReset.account)}</b> +${Math.round(w.nextReset.frees)}% in <b>${hrs((w.nextReset.at - r.now) / 3600e3)}</b>`
          : "no reset pending";
        const empty =
          w.burnPerHour24h == null && w.burnPerHour7d == null
            ? "no burn measured"
            : `empty in <b>${w.emptyInHours24h == null ? "> 7 d" : hrs(w.emptyInHours24h)}</b> at the 24 h pace · <b>${w.emptyInHours7d == null ? "> 7 d" : hrs(w.emptyInHours7d)}</b> at the 7 d pace`;
        return `<div class="rw-win ${esc(w.status)}">
        <div class="lbl"><span>${esc(w.label)}</span><span><b>${Math.round(w.headroom)}%</b> of ${w.capacity}% left</span></div>
        <div class="track">${segs}</div>
        <div class="note">burn ${w.burnPerHour24h == null ? "–" : w.burnPerHour24h.toFixed(1) + "%/h"} (24 h) · ${w.burnPerHour7d == null ? "–" : w.burnPerHour7d.toFixed(1) + "%/h"} (7 d)</div>
        <div class="note">${empty}</div>
        <div class="note">${next}</div>
      </div>`;
      })
      .join("");
    $("#rw-body").className = "";
    $("#rw-body").innerHTML =
      `<div class="verdict ${r.verdict === "tight" ? "more" : r.verdict === "close" ? "fewer" : r.verdict === "comfortable" ? "right" : "insufficient_data"}"><span class="big">${esc(r.headline)}</span><span class="muted">${esc(r.detail)}</span></div><div class="rw-grid">${wins}</div>`;
    $("#rw-meta").textContent =
      `${Math.round(r.coverageHours)} h of history · last 7 days: ${r.signals.relaxedEvents} over-threshold assignments, ${r.signals.fallbackEvents} fail-open, ${r.signals.dryEvents} pool-dry`;
    const pct = (x) => (x == null ? "–" : Math.round(x * 100) + "%");
    $("#rw-models tbody").innerHTML =
      (r.models || [])
        .map(
          (m) =>
            `<tr><td><b>${esc(m.model.replace(/^claude-/, ""))}</b> <span class="muted">${esc(m.family)}</span></td><td class="r">${m.requests24h} / ${m.requests7d}</td><td class="r">${pct(m.share24h)}</td><td class="r">${pct(m.share7d)}</td><td class="r">${m.burnPerHour24h == null ? "–" : m.burnPerHour24h.toFixed(2) + "%"}</td><td>${esc(m.bindingWindow)}</td><td class="r">${Math.round(m.headroom)}%</td><td class="r">${m.eligibleAccounts}</td><td class="r">${m.hoursAtOwnPace24h == null ? "–" : m.hoursAtOwnPace24h > 168 ? "> 7 d" : hrs(m.hoursAtOwnPace24h)}</td><td class="r">${m.hoursAtOwnPace7d == null ? "–" : m.hoursAtOwnPace7d > 168 ? "> 7 d" : hrs(m.hoursAtOwnPace7d)}</td><td>${m.nextReset ? `${esc(m.nextReset.account)} +${Math.round(m.nextReset.frees)}% in ${hrs((m.nextReset.at - r.now) / 3600e3)}` : "–"}</td></tr>`,
        )
        .join("") || '<tr><td colspan="11" class="muted">no requests logged yet</td></tr>';
    // timeline: one lane per account; weekly fill (blue) with reset tick, per-model (magenta) lower half, session (green) upper half
    const H = r.horizonHours * 3600e3,
      t0 = r.now;
    const x = (t) => Math.max(0, Math.min(100, ((t - t0) / H) * 100));
    const weekly = r.windows.find((w) => w.key === "weekly"),
      session = r.windows.find((w) => w.key === "session");
    const models = r.windows.filter((w) => w.kind === "model");
    const lanes = (weekly ? weekly.perAccount : [])
      .map((p) => {
        const parts = [];
        const wk = weekly.perAccount.find((q) => q.account === p.account);
        if (wk && wk.resetsAt) {
          const t = Date.parse(wk.resetsAt);
          parts.push(
            `<div class="fill" style="width:${x(t)}%" title="weekly ${Math.round(wk.utilization ?? 0)}% used"></div><div class="tick" style="left:${x(t)}%" data-l="week +${Math.round(wk.utilization ?? 0)}%"></div>`,
          );
        }
        for (const mw of models) {
          const m = mw.perAccount.find((q) => q.account === p.account);
          if (m && m.resetsAt && (m.utilization ?? 0) > 0) {
            const t = Date.parse(m.resetsAt);
            parts.push(
              `<div class="fill model" style="width:${x(t)}%" title="${esc(mw.label)} ${Math.round(m.utilization ?? 0)}%"></div><div class="tick model" style="left:${x(t)}%" data-l="${esc(mw.key)} +${Math.round(m.utilization ?? 0)}%"></div>`,
            );
          }
        }
        const ss = session && session.perAccount.find((q) => q.account === p.account);
        if (ss && ss.resetsAt && (ss.utilization ?? 0) > 0) {
          const t = Date.parse(ss.resetsAt);
          parts.push(
            `<div class="fill session" style="width:${x(t)}%" title="session ${Math.round(ss.utilization ?? 0)}%"></div><div class="tick session" style="left:${x(t)}%" data-l="5h"></div>`,
          );
        }
        return `<div class="name" title="${esc(p.account)}">${esc(p.account)}</div><div class="lane">${parts.join("")}</div>`;
      })
      .join("");
    const days = Array.from({ length: 8 }, (_, i) => `<span>${i === 0 ? "now" : "+" + i + "d"}</span>`).join("");
    $("#rw-timeline").innerHTML = lanes
      ? `${lanes}<div class="axis">${days}</div><div class="legend" style="grid-column:2"><span><i style="background:rgba(122,162,247,.5)"></i>weekly</span><span><i style="background:rgba(198,120,221,.6)"></i>per-model weekly</span><span><i style="background:rgba(61,220,132,.6)"></i>session (5 h)</span> <span>ticks mark resets; bar length = time until that reset</span></div>`
      : '<span class="muted">no accounts</span>';
  }
  loadRunway();
  setInterval(loadRunway, 60_000);

  // live connection
  function connect() {
    const es = new EventSource("/api/events");
    es.onopen = () => {
      $("#conn").textContent = "live";
      $("#conn").className = "pill on";
    };
    es.onerror = () => {
      $("#conn").textContent = "reconnecting";
      $("#conn").className = "pill off";
    };
    es.addEventListener("state", (e) => {
      state.s = JSON.parse(e.data);
      renderDashboard();
    });
    es.addEventListener("request", (e) => {
      if (state.tab !== "requests" || !$("#f-live").checked) return;
      const r = JSON.parse(e.data);
      const tb = $("#requests tbody");
      if (tb.firstElementChild && !tb.firstElementChild.dataset.id) tb.innerHTML = "";
      tb.insertAdjacentHTML("afterbegin", reqRow(r));
      while (tb.children.length > 200) tb.lastElementChild.remove();
    });
  }
  connect();
  setInterval(() => {
    if (state.tab === "dashboard" && !document.querySelector("#cards button:hover")) renderDashboard();
  }, 5000);
})();
