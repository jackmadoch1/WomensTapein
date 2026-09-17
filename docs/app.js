      const SESSION_KEY = "atr-session";
      const TZ = "America/Chicago";
      const API_PATHS = ["/api/tapein", "/.netlify/functions/tapein"];

      function chicagoDate(d = new Date()) {
        return new Intl.DateTimeFormat("en-CA", {
          timeZone: TZ,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(d);
      }
      function weekStartMonday(d = new Date()) {
        const ymd = chicagoDate(d);
        const [y, m, day] = ymd.split("-").map(Number);
        const utc = new Date(Date.UTC(y, m - 1, day, 12));
        const dow = utc.getUTCDay();
        utc.setUTCDate(utc.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
        return utc.toISOString().slice(0, 10);
      }
      function weekEndSunday(start) {
        const [y, m, d] = start.split("-").map(Number);
        const utc = new Date(Date.UTC(y, m - 1, d, 12));
        utc.setUTCDate(utc.getUTCDate() + 6);
        return utc.toISOString().slice(0, 10);
      }
      function formatWeekRange(start) {
        const end = weekEndSunday(start);
        const fmt = (iso) => {
          const [y, mo, da] = iso.split("-").map(Number);
          return new Date(Date.UTC(y, mo - 1, da, 12)).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          });
        };
        return fmt(start) + " – " + fmt(end);
      }
      function formatClock(iso) {
        return new Date(iso).toLocaleString("en-US", {
          timeZone: TZ,
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
      }

      let state = { users: [], visits: [], sessionId: localStorage.getItem(SESSION_KEY) };
      let screen = state.sessionId ? "app" : "auth";
      let authMode = "signup";
      let tab = "confirm";
      let toastMsg = "";
      let toastTimer = 0;
      let checkOpen = false;
      let checkPhoto = null;
      let ready = false;
      let busy = false;
      let pollTimer = 0;
      let lastJson = "";
      const photoCache = {};

      let boardError = "";

      function toast(msg) {
        toastMsg = msg;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          toastMsg = "";
          render();
        }, 2200);
        render();
      }
      function currentUser() {
        return state.users.find((u) => u.id === state.sessionId) || null;
      }
      function thisWeekVisits() {
        const start = weekStartMonday();
        return state.visits.filter((v) => v.weekStart === start);
      }
      function applyServer(data) {
        state.users = data.users || [];
        state.visits = data.visits || [];
        if (data.sessionId) {
          state.sessionId = data.sessionId;
          localStorage.setItem(SESSION_KEY, data.sessionId);
        }
        lastJson = JSON.stringify({ users: state.users, visits: state.visits });
      }

      async function loadPhoto(img) {
        const id = img.getAttribute("data-photo-id");
        if (!id) return;
        if (photoCache[id]) {
          img.src = photoCache[id];
          return;
        }
        try {
          let data = null;
          for (const path of API_PATHS) {
            const res = await fetch(`${path}?photo=${encodeURIComponent(id)}`, { cache: "no-store" });
            const text = await res.text();
            try {
              data = JSON.parse(text);
              break;
            } catch {
              data = null;
            }
          }
          if (data && data.photo) {
            photoCache[id] = data.photo;
            img.src = data.photo;
          }
        } catch {
          /* photo is optional */
        }
      }

      async function api(method, payload) {
        let lastErr = "Could not reach the shared board.";
        for (const path of API_PATHS) {
          try {
            const res = await fetch(path, {
              method,
              headers: method === "POST" ? { "content-type": "application/json" } : undefined,
              body: method === "POST" ? JSON.stringify(payload) : undefined,
              cache: "no-store",
            });
            const text = await res.text();
            let data = {};
            try {
              data = text ? JSON.parse(text) : {};
            } catch {
              lastErr = "The shared board is not live on this deploy yet. Trigger a new Netlify deploy from Deploys.";
              continue;
            }
            if (!res.ok) throw new Error(data.error || lastErr);
            return data;
          } catch (err) {
            lastErr = err.message || lastErr;
          }
        }
        throw new Error(lastErr);
      }

      async function refresh(forceRender) {
        try {
          const data = await api("GET");
          const next = JSON.stringify({ users: data.users || [], visits: data.visits || [] });
          const changed = next !== lastJson;
          applyServer(data);
          boardError = "";
          if (state.sessionId && !currentUser()) {
            state.sessionId = null;
            localStorage.removeItem(SESSION_KEY);
            if (screen === "app") screen = "auth";
          }
          const wasReady = ready;
          ready = true;
          if (forceRender || changed || !wasReady) render();
        } catch (err) {
          const wasReady = ready;
          ready = true;
          boardError = err.message || "Could not load the board.";
          if (!wasReady) render();
        }
      }

      async function signUp(name, password) {
        const n = String(name || "").trim();
        if (n.length < 2) return toast("Enter your name.");
        if (String(password || "").length < 4) return toast("Password must be at least 4 characters.");
        if (busy) return;
        busy = true;
        try {
          const data = await api("POST", { op: "signup", name: n, password });
          applyServer(data);
          screen = "app";
          tab = "confirm";
          toast("Account created.");
        } catch (err) {
          toast(err.message);
        } finally {
          busy = false;
        }
      }
      async function signIn(name, password) {
        if (busy) return;
        busy = true;
        try {
          const data = await api("POST", { op: "signin", name, password });
          applyServer(data);
          screen = "app";
          tab = "confirm";
          render();
        } catch (err) {
          toast(err.message);
        } finally {
          busy = false;
        }
      }
      function signOut() {
        state.sessionId = null;
        localStorage.removeItem(SESSION_KEY);
        screen = "auth";
        authMode = "signin";
        render();
      }
      async function checkIn() {
        const me = currentUser();
        if (!me || busy) return;
        const note = (document.getElementById("check-note") || {}).value || "";
        busy = true;
        try {
          const data = await api("POST", {
            op: "checkin",
            userId: me.id,
            note: String(note).trim(),
            photo: checkPhoto,
          });
          applyServer(data);
          checkOpen = false;
          checkPhoto = null;
          toast("Checked in. Needs 2 yeses.");
        } catch (err) {
          toast(err.message);
        } finally {
          busy = false;
        }
      }
      function readPhoto(file) {
        if (!file || !file.type.startsWith("image/")) {
          toast("Choose a photo.");
          return;
        }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = function () {
          const max = 720;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          checkPhoto = canvas.toDataURL("image/jpeg", 0.72);
          render();
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          toast("Could not read that photo.");
        };
        img.src = url;
      }
      async function vote(visitId, choice) {
        const me = currentUser();
        if (!me || busy) return;
        busy = true;
        try {
          const data = await api("POST", { op: "vote", userId: me.id, visitId, choice });
          applyServer(data);
          if (data.approved) toast("Confirmed. On the board.");
          else if (choice === "yes") toast((data.yesCount || 1) + " of 2");
          else toast("Noted.");
        } catch (err) {
          toast(err.message);
        } finally {
          busy = false;
        }
      }

      function renderLanding() {
        return `
          <header class="header">
            <div class="header-inner"><a class="brand" href="#">ATR TRACKER</a></div>
          </header>
          <main class="hero">
            <h1>ATR Tracker</h1>
            <p class="lede">Check in when you go in. Two teammates confirm it. The board counts the week.</p>
            <div class="stack">
              <button class="btn btn-primary" data-go="signup">Create an account</button>
              <button class="btn btn-outline" data-go="signin">Sign in</button>
            </div>
          </main>`;
      }

      function renderAuth() {
        const title = authMode === "signup" ? "Create account" : "Sign in";
        const cta = authMode === "signup" ? "Create account" : "Sign in";
        const swap = authMode === "signup" ? "Already have an account? Sign in" : "Need an account? Create one";
        return `
          <header class="header">
            <div class="header-inner"><a class="brand" href="#" data-home>ATR TRACKER</a></div>
          </header>
          <main>
            <h1 style="font-size:1.875rem;margin-top:1.25rem">${title}</h1>
            <p class="lede">Two confirms and it counts this week.</p>
            ${boardError ? `<p class="lede" style="color:var(--maroon)">${escapeHtml(boardError)}</p>` : ""}
            <form id="auth-form" class="stack" style="margin-top:2rem">
              <div>
                <label for="name">Name</label>
                <input id="name" name="name" autocomplete="name" required minlength="2" />
              </div>
              <div>
                <label for="password">Password</label>
                <input id="password" name="password" type="password" required minlength="4" />
              </div>
              <button class="btn btn-primary" type="submit">${cta}</button>
            </form>
            <p style="margin-top:1.5rem;text-align:center">
              <button class="linkish" type="button" data-swap>${swap}</button>
            </p>
            <p style="margin-top:1.5rem;text-align:center">
              <button class="linkish" type="button" data-home>Back</button>
            </p>
          </main>`;
      }

      function renderLoading() {
        return `
          <header class="header">
            <div class="header-inner"><span class="brand">ATR TRACKER</span></div>
          </header>
          <main>
            <p class="lede" style="margin-top:2rem">Loading the board…</p>
          </main>`;
      }

      function renderApp() {
        const me = currentUser();
        if (!me) return renderAuth();
        const week = weekStartMonday();
        const visits = thisWeekVisits();
        const toConfirm = visits.filter((v) => v.userId !== me.id && v.status === "pending");
        const myPending = visits.filter((v) => v.userId === me.id && v.status === "pending").length;
        const board = state.users
          .map((u) => {
            const mine = visits.filter((v) => v.userId === u.id);
            return {
              id: u.id,
              name: u.name,
              approved: mine.filter((v) => v.status === "approved").length,
            };
          })
          .sort((a, b) => b.approved - a.approved || a.name.localeCompare(b.name));

        const confirmList = toConfirm.length
          ? toConfirm
              .map((v) => {
                const voted = v.yes.includes(me.id) ? "Yes" : v.no.includes(me.id) ? "No" : null;
                const actions = voted
                  ? `<p class="meta">${voted}</p>`
                  : `<div class="row-btns">
                       <button class="btn btn-primary btn-sm" data-vote="${v.id}" data-choice="yes">Yes</button>
                       <button class="btn btn-outline btn-sm" data-vote="${v.id}" data-choice="no">No</button>
                     </div>`;
                const extra = v.yes.length ? ` · ${v.yes.length}/2` : "";
                const proof = (v.note ? `<p class="note">${escapeHtml(v.note)}</p>` : "") +
                  (v.photo && String(v.photo).indexOf("data:image/") === 0
                    ? `<img class="shot" alt="" src="${v.photo}">`
                    : v.hasPhoto || v.photo
                      ? `<img class="shot" alt="" data-photo-id="${escapeHtml(v.id)}">`
                      : "");
                return `<li class="item">
                  <div class="grow">
                    <p class="name">${escapeHtml(v.name)}</p>
                    <p class="meta">${formatClock(v.createdAt)}${extra}</p>
                    ${proof}
                  </div>
                  ${actions}
                </li>`;
              })
              .join("")
          : `<p class="empty" style="margin-top:0.75rem">When a teammate checks in, it shows up here for everyone.</p>`;

        const boardList = board.length
          ? board
              .map((row, i) => {
                const you = row.id === me.id ? ` <span class="meta" style="display:inline">you</span>` : "";
                return `<li class="item${row.id === me.id ? " you" : ""}">
                  <span class="rank">${i + 1}</span>
                  <p class="name grow">${escapeHtml(row.name)}${you}</p>
                  <span class="count">${row.approved}</span>
                </li>`;
              })
              .join("")
          : `<p class="empty">No one on the board yet.</p>`;

        const checkForm = checkOpen
          ? `<form id="check-form" class="check-form">
                <input id="check-photo" type="file" accept="image/*" capture="environment" style="display:none" />
                ${checkPhoto
                  ? `<img class="shot" alt="Check-in photo" src="${checkPhoto}">
                     <button type="button" class="btn btn-outline" data-clear-photo>Remove photo</button>`
                  : `<button type="button" class="btn btn-outline" data-add-photo>Add a photo</button>`}
                <textarea id="check-note" maxlength="280" placeholder="Add a message"></textarea>
                <div class="row-btns">
                  <button type="button" class="btn btn-outline" style="flex:1" data-cancel-check>Cancel</button>
                  <button type="submit" class="btn btn-primary" style="flex:1">Check in</button>
                </div>
              </form>`
          : `<button class="btn btn-primary" style="width:100%" data-open-check>I went in</button>`;

        const body =
          tab === "confirm"
            ? `<div style="padding-top:1.25rem">
                ${checkForm}
                ${myPending ? `<p class="hint">${myPending} of yours waiting on 2 confirms</p>` : ""}
                <h2 class="section-title">Did you see them?</h2>
                <ul class="list">${confirmList}</ul>
              </div>`
            : `<div style="padding-top:1.25rem">
                <p class="week">${formatWeekRange(week)}</p>
                <h2 class="section-title" style="margin-top:0.25rem">Approved visits</h2>
                <ol class="list">${boardList}</ol>
              </div>`;

        return `
          <header class="header">
            <div class="header-inner">
              <a class="brand" href="#">ATR TRACKER</a>
              <div class="header-actions">
                <span class="user-chip">${escapeHtml(me.name)}</span>
                <button class="ghost" data-out>Sign out</button>
              </div>
            </div>
          </header>
          <main>
            <div class="tabs">
              <button class="tab${tab === "confirm" ? " active" : ""}" data-tab="confirm">Confirm</button>
              <button class="tab${tab === "board" ? " active" : ""}" data-tab="board">Leaderboard</button>
            </div>
            ${body}
          </main>`;
      }

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, "&" + "amp;")
          .replace(/</g, "&" + "lt;")
          .replace(/>/g, "&" + "gt;")
          .replace(/"/g, "&" + "quot;");
      }

      function render() {
        const root = document.getElementById("app");
        const toastHtml = toastMsg ? `<div class="toast">${escapeHtml(toastMsg)}</div>` : "";
        if (!ready) root.innerHTML = renderLoading() + toastHtml;
        else if (screen === "landing") root.innerHTML = renderLanding() + toastHtml;
        else if (screen === "auth") root.innerHTML = renderAuth() + toastHtml;
        else root.innerHTML = renderApp() + toastHtml;

        root.querySelector("[data-go='signup']")?.addEventListener("click", () => {
          authMode = "signup";
          screen = "auth";
          render();
        });
        root.querySelector("[data-go='signin']")?.addEventListener("click", () => {
          authMode = "signin";
          screen = "auth";
          render();
        });
        root.querySelectorAll("[data-home]").forEach((n) =>
          n.addEventListener("click", (e) => {
            e.preventDefault();
            screen = "landing";
            render();
          }),
        );
        root.querySelector("[data-swap]")?.addEventListener("click", () => {
          authMode = authMode === "signup" ? "signin" : "signup";
          render();
        });
        root.querySelector("#auth-form")?.addEventListener("submit", (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          if (authMode === "signup") signUp(fd.get("name"), fd.get("password"));
          else signIn(fd.get("name"), fd.get("password"));
        });
        root.querySelector("[data-out]")?.addEventListener("click", signOut);
        root.querySelector("[data-open-check]")?.addEventListener("click", () => {
          checkOpen = true;
          render();
        });
        root.querySelector("[data-cancel-check]")?.addEventListener("click", () => {
          checkOpen = false;
          checkPhoto = null;
          render();
        });
        root.querySelector("[data-add-photo]")?.addEventListener("click", () => {
          document.getElementById("check-photo")?.click();
        });
        root.querySelector("[data-clear-photo]")?.addEventListener("click", () => {
          checkPhoto = null;
          render();
        });
        root.querySelector("#check-photo")?.addEventListener("change", (e) => {
          const file = e.target.files && e.target.files[0];
          e.target.value = "";
          if (file) readPhoto(file);
        });
        root.querySelector("#check-form")?.addEventListener("submit", (e) => {
          e.preventDefault();
          checkIn();
        });
        root.querySelectorAll("[data-tab]").forEach((n) =>
          n.addEventListener("click", () => {
            tab = n.getAttribute("data-tab");
            render();
          }),
        );
        root.querySelectorAll("[data-vote]").forEach((n) =>
          n.addEventListener("click", () => vote(n.getAttribute("data-vote"), n.getAttribute("data-choice"))),
        );
        root.querySelectorAll("img[data-photo-id]").forEach((img) => {
          void loadPhoto(img);
        });
      }

      render();
      refresh(true);
      clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        if (document.visibilityState === "visible" && screen === "app") refresh(false);
      }, 4000);
