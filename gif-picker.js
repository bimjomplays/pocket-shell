// GIF picker: a "GIF" button next to the emoji and photo buttons in the chat box.
//
// Picking a GIF hands the real .gif file to Snapchat Web's own photo-upload input (name="uploadImages",
// which accepts image/gif and sends it as a GIF-type media message, not resized). So sending is exactly what
// Snapchat's own upload button does: the GIF shows up in the chat box's media preview, and you send it
// with Enter like any photo. Search results and files come from Giphy through background.js.
(() => {
  if (window.top !== window) return;
  const ask = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? {} : r || {})));
  let panel, grid, search, note, button, next = 0, query = "", loading = false, token = 0;
  let cols = [], heights = [];
  let tab = "trending", favs = null, tabButtons = {}; // favs: [{ id, w, h }], newest first

  const loadFavs = async () => (favs ??= (await chrome.storage.local.get("giphyFavs")).giphyFavs || []);
  const isFav = (id) => favs.some((f) => f.id === id);
  async function toggleFav(g) {
    await loadFavs();
    favs = isFav(g.id) ? favs.filter((f) => f.id !== g.id) : [{ id: g.id, w: g.w, h: g.h }, ...favs];
    await chrome.storage.local.set({ giphyFavs: favs });
    panel.querySelectorAll(`[data-fav-id="${g.id}"]`).forEach(paintStar);
    if (tab === "favorites" && !query) run("");
  }
  function paintStar(star) {
    const on = isFav(star.dataset.favId);
    star.textContent = on ? "★" : "☆";
    star.classList.toggle("dg-gif-fav-on", on);
    star.title = on ? "Remove from favorites" : "Add to favorites";
  }

  // two columns filled shortest-first, so the grid only ever grows downward
  function clearGrid() {
    cols = [0, 1].map(() => Object.assign(document.createElement("div"), { className: "dg-gif-col" }));
    heights = [0, 0];
    grid.replaceChildren(...cols);
  }
  function addTile(g) {
    const i = heights[0] <= heights[1] ? 0 : 1;
    heights[i] += g.h / g.w;
    cols[i].appendChild(tile(g));
  }

  const uploadInput = () => document.querySelector('input[type="file"][name="uploadImages"]');

  function addButton() {
    const input = uploadInput();
    const photo = input && input.closest("button");
    if (!photo || photo.nextElementSibling === button) return;
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "dg-gif-button";
      button.textContent = "GIF";
      button.title = "Send a GIF";
      button.addEventListener("click", (e) => { e.stopPropagation(); panel && panel.isConnected ? close() : open(); });
    }
    button.className = `${photo.className} dg-gif-button`; // same size/shape as the photo button
    photo.after(button);
  }

  function open() {
    if (!panel) build();
    document.body.appendChild(panel);
    place();
    search.value = query;
    search.focus();
    if (!heights[0]) run(query);
  }

  function close() { panel && panel.remove(); }

  function place() {
    const r = button.getBoundingClientRect();
    panel.style.right = `${Math.max(8, innerWidth - r.right)}px`;
    panel.style.bottom = `${innerHeight - r.top + 8}px`;
  }

  function build() {
    panel = document.createElement("div");
    panel.className = "dg-gif-panel";
    search = document.createElement("input");
    search.className = "dg-gif-search";
    search.placeholder = "Search GIPHY";
    note = document.createElement("div");
    note.className = "dg-gif-note";
    grid = document.createElement("div");
    grid.className = "dg-gif-grid";
    const tabs = document.createElement("div");
    tabs.className = "dg-gif-tabs";
    for (const [name, label] of [["trending", "Trending"], ["favorites", "★ Favorites"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => { tab = name; search.value = ""; run(""); });
      tabButtons[name] = b;
      tabs.appendChild(b);
    }
    const credit = document.createElement("div");
    credit.className = "dg-gif-credit";
    credit.textContent = "Powered by GIPHY";
    panel.append(search, tabs, note, grid, credit);

    let t;
    search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => run(search.value), 300); });
    search.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") close(); });
    grid.addEventListener("scroll", () => {
      if (grid.scrollTop + grid.clientHeight > grid.scrollHeight - 200) more();
    });
    panel.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", close);
    addEventListener("resize", () => panel.isConnected && place());
  }

  async function run(q) {
    query = q.trim();
    next = 0;
    clearGrid();
    grid.scrollTop = 0;
    await loadFavs();
    for (const [name, b] of Object.entries(tabButtons)) b.classList.toggle("dg-gif-tab-on", !query && tab === name);
    if (!query && tab === "favorites") {
      ++token; // drop any search still in flight
      loading = false;
      note.textContent = favs.length ? "" : "No favorites yet: tap ☆ on a GIF to save it here";
      favs.forEach(addTile);
      return;
    }
    await more(true);
  }

  async function more(fresh) {
    if ((loading && !fresh) || (!query && tab === "favorites")) return;
    loading = true;
    const mine = ++token;
    const res = await ask({ giphySearch: query, offset: next });
    if (mine !== token) return;
    loading = false;
    if (res.needKey) return askForKey(res.error);
    note.textContent = res.error || (fresh && !(res.results || []).length ? "No GIFs found" : "");
    next = res.next || next;
    for (const g of res.results || []) addTile(g);
  }

  function tile(g) {
    const item = document.createElement("div");
    item.className = "dg-gif-item";
    const img = document.createElement("img");
    img.className = "dg-gif-tile";
    img.alt = "GIF";
    img.style.aspectRatio = `${g.w} / ${g.h}`;
    ask({ giphyPreview: g.id }).then((r) => { if (r.dataUrl) img.src = r.dataUrl; });
    img.addEventListener("click", () => pick(g.id, img));
    const star = document.createElement("button");
    star.type = "button";
    star.className = "dg-gif-fav";
    star.dataset.favId = g.id;
    paintStar(star);
    star.addEventListener("click", (e) => { e.stopPropagation(); toggleFav(g); });
    item.append(img, star);
    return item;
  }

  async function pick(id, img) {
    img.classList.add("dg-gif-busy");
    const r = await ask({ giphyFile: id });
    img.classList.remove("dg-gif-busy");
    const input = uploadInput();
    if (!r.dataUrl || !input) { note.textContent = "Couldn't load that GIF"; return; }
    // decode by hand: fetch() of a data: URL here would go through Snapchat's CSP (and its violation reports)
    const bin = atob(r.dataUrl.slice(r.dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], `${id}.gif`, { type: "image/gif" }));
    const box = document.querySelector('[role="textbox"][contenteditable="true"]');
    const pane = box && (box.closest("[data-dg-column]") || document.body);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    close();
    // Mobile: picking a GIF sends it (like the app). From Snapchat's own bundle: the chat box's Enter/
    // NumpadEnter handler calls its send function whether or not there's typed text - it only needs the
    // file already in the composer's own state (not ours), which is what makes the media preview appear.
    // Only skipped when the box has real typed text, so a half-typed message is never sent along by
    // surprise.
    if (!box || box.textContent.trim()) return;
    const mediaEls = () => pane.querySelectorAll("img[src^='blob:'], video, canvas");
    const before = new Set(mediaEls());
    // Snapchat's composer renders [media preview (with its own "remove" buttons), textbox, send arrow] as
    // siblings, and the send arrow only exists once the composer holds text or files - so "a button AFTER the
    // textbox" is both the ready signal and the thing to press (its onClick is the same send function Enter
    // calls). Run11 took the first button near the box, which was the preview's remove button: the GIF
    // flashed in the bar and vanished. Enter stays as the last resort if the arrow never shows up.
    const sendButton = () => [...box.parentElement.querySelectorAll("button")].find((b) =>
      (box.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) && !b.disabled && !/MyAI/i.test(b.getAttribute("aria-label") || ""));
    const enter = () => {
      try { box.focus({ preventScroll: true }); } catch (e) {}
      for (const type of ["keydown", "keypress", "keyup"])
        box.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    };
    // Phone log (run14): with a GIF picked as the first thing in a chat, the send arrow did not exist until the
    // user tapped the text field - then this loop found it and sent at once. So do that tap for them: focus the
    // field and give it the click Snapchat's composer listens for, again after a moment if the arrow is still
    // missing. The field is blurred again after sending so the keyboard doesn't stay up.
    const wake = () => {
      try { box.focus({ preventScroll: true }); } catch (e) {}
      const r = box.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const type of ["mousedown", "mouseup", "click"]) box.dispatchEvent(new MouseEvent(type, o));
    };
    // What happened between the pick and the send, in trail.txt (device report: sometimes a delay with the GIF
    // sitting in the bar first).
    const t0 = performance.now();
    const log = (text) => { try { window.webkit.messageHandlers.dg.postMessage({ op: "trail", text: "GIF " + Math.round(performance.now() - t0) + "ms " + text }).catch(() => {}); } catch (e) {} };
    // One press only, ever: Snapchat clears the preview when its own send finishes, which can take seconds.
    let tries = 0, woke = 0;
    const wait = () => {
      if (!box.isConnected) return log("box gone");
      const b = sendButton();
      if (!b && (tries === 0 || tries === 3 || tries === 10)) { woke++; wake(); }
      if (b) {
        log("send arrow found, tries " + tries + " wakes " + woke + " focused " + (document.activeElement === box));
        return void setTimeout(() => {
          if (b.isConnected && !b.disabled) { b.click(); log("clicked"); } else { enter(); log("enter (arrow gone)"); }
          setTimeout(() => { try { box.blur(); } catch (e) {} }, 250);
        }, 60);
      }
      if (++tries > 90) { enter(); return void log("gave up, enter"); } // ~9s: never saw the arrow, try Enter rather than stay silent
      setTimeout(wait, 100);
    };
    setTimeout(wait, 60);
  }

  function askForKey(error) {
    clearGrid();
    note.replaceChildren();
    const p = document.createElement("p");
    p.textContent = (error ? error + ". " : "") +
      "GIF search needs a free GIPHY API key: developers.giphy.com → Create an App → API. Paste the key here:";
    const key = document.createElement("input");
    key.className = "dg-gif-search";
    key.placeholder = "GIPHY API key";
    key.addEventListener("keydown", async (e) => {
      e.stopPropagation();
      if (e.key !== "Enter" || !key.value.trim()) return;
      await ask({ giphyKey: key.value });
      note.replaceChildren();
      run(search.value);
    });
    note.append(p, key);
    key.focus();
  }

  let queued = false;
  (function observe() {
    if (!document.body) return void setTimeout(observe, 50);
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; addButton(); });
    }).observe(document.body, { childList: true, subtree: true });
    addButton();
  })();
})();
