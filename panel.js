const STORAGE_KEY = "omsData";
const FORMAT = "opportunity-hunter-oms";
const emptyData = () => ({ schemaVersion: 1, opportunities: [], contacts: [], threads: [], entries: [] });

let data = emptyData();
let view = "opportunities";
let selectedOpportunity = null;
let selectedThread = null;
let searchTerm = "";
const expandedFolders = new Set();
let dialogMode = null;
let dialogId = null;
let pastedImages = [];
let toastTimer;

const main = document.getElementById("main");
const dialog = document.getElementById("formDialog");
const form = document.getElementById("entryForm");
const restoreInput = document.getElementById("restoreInput");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function uid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function prettyDate(value) { if (!value) return ""; const d = new Date(value.length === 10 ? `${value}T12:00:00` : value); return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
function initials(name) { return String(name || "?").split(/\s+/).slice(0,2).map(x => x[0] || "").join("").toUpperCase(); }
function contact(id) { return data.contacts.find(item => item.id === id); }
function spocName(item) { return contact(item.contactId)?.name || (item.contactId ? "Unknown person" : "No SPOC assigned"); }
function spocAvatar(item) { const name = contact(item.contactId)?.name; return name ? initials(name) : "–"; }
function opportunity(id) { return data.opportunities.find(item => item.id === id); }
function thread(id) { return data.threads.find(item => item.id === id); }
function threadsFor(oppId) { return data.threads.filter(item => item.opportunityId === oppId); }
function categoryFor(item) { return item.category?.trim() || "Uncategorized"; }
function normalizedCategory(value) { const category = String(value || "").trim(); return data.opportunities.map(categoryFor).find(existing => existing.toLowerCase() === category.toLowerCase()) || category; }
function entriesFor(threadId) { return data.entries.filter(item => item.threadId === threadId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
function dueThreads() { return data.threads.filter(item => item.status === "open" && item.nextDate).sort((a,b) => a.nextDate.localeCompare(b.nextDate)); }
function isOverdue(value) { return value && value < today(); }
function nextBadge(value) { if (!value) return ""; const label = isOverdue(value) ? "Overdue" : value === today() ? "Today" : prettyDate(value); const cls = isOverdue(value) ? "overdue" : value === today() ? "today" : ""; return `<span class="badge ${cls}">${escapeHtml(label)}</span>`; }
function toast(message) { const el = document.getElementById("toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3000); }
function threadLinks(item) { return Array.isArray(item?.links) ? item.links : []; }
function threadImages(item) { return Array.isArray(item?.images) ? item.images : []; }
function safeHref(value) { try { let text = String(value || "").trim(); if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(text)) text = `https://${text}`; const url = new URL(text, location.href); return ["http:","https:","mailto:","tel:"].includes(url.protocol) ? url.href : "#"; } catch { return "#"; } }
function parseLinks(value) {
  return String(value || "").split(/\n+/).map(text => text.trim()).filter(Boolean).map(text => {
    const [labelPart, ...urlParts] = text.split("|");
    const url = (urlParts.length ? urlParts.join("|") : labelPart).trim();
    const label = (urlParts.length ? labelPart : url).trim();
    return { id:uid(), label, url };
  });
}
async function readImages(files) {
  const images = [...files].filter(file => file.type.startsWith("image/"));
  if (!images.length) return [];
  const limit = 4 * 1024 * 1024;
  const tooLarge = images.find(file => file.size > limit);
  if (tooLarge) throw new Error("Each image must be 4 MB or smaller.");
  return Promise.all(images.map(file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ id:uid(), name:file.name, type:file.type, size:file.size, dataUrl:reader.result, createdAt:now() });
    reader.onerror = () => reject(new Error("Could not read one of the images."));
    reader.readAsDataURL(file);
  })));
}
function renderPastedImages() {
  const preview = document.getElementById("pastedImagePreview");
  if (!preview) return;
  preview.innerHTML = pastedImages.length ? pastedImages.map(image => `<figure><img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name)}"><figcaption>${escapeHtml(image.name)}</figcaption></figure>`).join("") : `<span>Paste copied images here.</span>`;
}
async function addClipboardImages(files) {
  try {
    const images = await readImages(files);
    if (!images.length) return;
    pastedImages.push(...images.map((image, index) => ({ ...image, name:image.name || `Pasted image ${pastedImages.length + index + 1}` })));
    renderPastedImages();
    toast(`${images.length} pasted image${images.length === 1 ? "" : "s"} added.`);
  } catch (error) { toast(error.message); }
}

async function persist(next) {
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  data = next;
  render();
}

async function change(mutator, success) {
  const previousSelection = [view, selectedOpportunity, selectedThread];
  try {
    const next = structuredClone(data);
    mutator(next);
    await persist(next);
    if (success) toast(success);
    return true;
  } catch (error) { [view, selectedOpportunity, selectedThread] = previousSelection; console.error(error); toast("Could not save. Your previous data is unchanged."); return false; }
}

function header(kicker, title, subtitle, button = "") { return `<div class="page-top"><div><p class="eyebrow">${kicker}</p><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}</div>${button}</div>`; }
function empty(title, description, action, label, symbol = "+") { return `<div class="empty"><div class="empty-icon">${symbol}</div><h2>${title}</h2><p>${description}</p>${action ? `<button class="button primary" data-action="${action}" type="button">${label}</button>` : ""}</div>`; }
function categoryTree(compact = false) {
  const categories = [...new Set(data.opportunities.map(categoryFor))].sort((a,b) => a === "Uncategorized" ? 1 : b === "Uncategorized" ? -1 : a.localeCompare(b));
  const visibleCategories = categories.filter(category => category.toLowerCase().includes(searchTerm) || data.opportunities.some(item => categoryFor(item) === category && `${item.title} ${item.summary} ${threadsFor(item.id).map(thread => `${thread.title} ${contact(thread.contactId)?.name || ""}`).join(" ")}`.toLowerCase().includes(searchTerm)));
  return visibleCategories.length ? `<div class="folder-list ${compact ? "compact-tree" : ""}">${visibleCategories.map(category => {
    const allItems = data.opportunities.filter(item => categoryFor(item) === category).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    const items = searchTerm && !category.toLowerCase().includes(searchTerm) ? allItems.filter(item => `${item.title} ${item.summary} ${threadsFor(item.id).map(thread => `${thread.title} ${contact(thread.contactId)?.name || ""}`).join(" ")}`.toLowerCase().includes(searchTerm)) : allItems;
    const expanded = expandedFolders.has(category) || !!searchTerm || items.some(item => item.id === selectedOpportunity);
    return `<section class="folder"><button class="folder-toggle" data-action="toggle-category" data-category="${escapeHtml(category)}" type="button" aria-expanded="${expanded}"><span class="folder-chevron">${expanded ? "▾" : "▸"}</span><span class="folder-icon" aria-hidden="true">${expanded ? "▣" : "▰"}</span><span class="folder-title">${escapeHtml(category)}</span><span class="folder-count">${allItems.length}</span></button>${expanded ? `<div class="folder-contents">${items.map(item => { const linked = threadsFor(item.id).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); return `<div class="tree-opportunity"><button class="tree-opportunity-button ${item.id === selectedOpportunity && !selectedThread ? "active-node" : ""}" data-action="open-opportunity" data-id="${item.id}" type="button"><span class="tree-node-icon" aria-hidden="true">◈</span><span class="tree-node-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.summary || "Open opportunity")}</small></span><span class="badge ${item.status}">${escapeHtml(item.status)}</span></button>${linked.length ? `<div class="tree-threads">${linked.map(item => `<button class="tree-thread ${item.id === selectedThread ? "active-node" : ""}" data-action="open-thread-from-tree" data-id="${item.id}" type="button"><span class="tree-avatar">${escapeHtml(spocAvatar(item))}</span><span class="tree-node-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(spocName(item))}${item.nextDate && item.status === "open" ? ` · Follow up ${escapeHtml(prettyDate(item.nextDate))}` : ""}</small></span></button>`).join("")}</div>` : `<div class="tree-empty">No threads yet</div>`}</div>`; }).join("")}</div>` : ""}</section>`;
  }).join("")}</div>` : "";
}
function workspaceShell(content) {
  return `<div class="workspace-layout"><aside class="workspace-sidebar"><div class="sidebar-head"><p class="eyebrow">Folders</p><button class="button primary small" data-action="add-opportunity" type="button">＋ New</button></div>${data.opportunities.length ? `<input id="search" class="search" type="search" placeholder="Search folders" value="${escapeHtml(searchTerm)}" aria-label="Search categories, opportunities or people">` : ""}${categoryTree(true) || empty("No folders yet", "Create an opportunity to start the folder tree.", "add-opportunity", "Create opportunity", "✦")}</aside><section class="workspace-content">${content}</section></div>`;
}

function render() {
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === view));
  const count = dueThreads().filter(item => item.nextDate <= today()).length;
  const pill = document.getElementById("dueCount");
  pill.textContent = count;
  pill.classList.toggle("hidden", count === 0);
  if (view === "settings") renderSettings();
  else if (view === "followups") renderFollowups();
  else if (view === "people") renderPeople();
  else if (selectedThread && thread(selectedThread)) renderThread();
  else if (selectedOpportunity && opportunity(selectedOpportunity)) renderOpportunity();
  else renderOpportunities();
}

function renderOpportunities() {
  selectedOpportunity = null; selectedThread = null;
  const active = data.opportunities.filter(item => item.status === "active").length;
  const due = dueThreads().filter(item => item.nextDate <= today()).length;
  main.innerHTML = header("Your workspace", "Opportunities", "Browse categories, opportunities, and the people moving them forward.", `<button class="button primary" data-action="add-opportunity" type="button">＋ New</button>`) +
    `<div class="summary-strip"><div class="stat"><strong>${data.opportunities.length}</strong><span>Total opportunities</span></div><div class="stat"><strong>${active}</strong><span>Active</span></div><div class="stat"><strong>${due}</strong><span>Due follow-ups</span></div></div>` +
    (data.opportunities.length ? `<div class="toolbar"><input id="search" class="search" type="search" placeholder="Search categories, opportunities or people" value="${escapeHtml(searchTerm)}" aria-label="Search categories, opportunities or people"></div>` : "") +
    (categoryTree() || empty(data.opportunities.length ? "No matching categories" : "Start with an opportunity", data.opportunities.length ? "Try a different search term." : "Give the opportunity a category, then add a thread for each person helping move it forward.", data.opportunities.length ? "" : "add-opportunity", "Create opportunity", "✦"));
}

function renderOpportunity() {
  const item = opportunity(selectedOpportunity);
  const linked = threadsFor(item.id).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  main.innerHTML = workspaceShell(`<button class="back" data-action="back-opportunities" type="button">← All opportunities</button>` +
    `<div class="detail-head"><p class="eyebrow">${escapeHtml(categoryFor(item))} / Opportunity</p><h1>${escapeHtml(item.title)}</h1><p>${escapeHtml(item.summary || "Add a description to clarify what you are pursuing.")}</p><div class="detail-actions"><span class="badge ${item.status}">${escapeHtml(item.status)}</span><button class="button secondary small" data-action="edit-opportunity" type="button">Edit</button><button class="button secondary small" data-action="delete-opportunity" type="button">Delete</button></div></div>` +
    `<div class="section-label"><span>Threads and paths · ${linked.length}</span><button class="button text small" data-action="add-thread" type="button">＋ Add thread</button></div>` +
    (linked.length ? `<div class="card-list">${linked.map(item => { const person = contact(item.contactId); return `<article class="card thread-card" data-action="open-thread" data-id="${item.id}" tabindex="0" role="button"><div class="contact-avatar">${escapeHtml(spocAvatar(item))}</div><div class="thread-main"><div class="card-line"><h2>${escapeHtml(item.title)}</h2><span class="badge ${item.status}">${escapeHtml(item.status)}</span></div><p>${escapeHtml(spocName(item))}${person?.organization ? ` · ${escapeHtml(person.organization)}` : ""}</p>${item.purpose ? `<p>${escapeHtml(item.purpose)}</p>` : ""}<div class="next ${isOverdue(item.nextDate) ? "overdue" : ""}">${item.nextDate && item.status === "open" ? `Follow up ${escapeHtml(prettyDate(item.nextDate))}` : item.status === "done" ? "Completed" : "No follow-up set"}</div></div></article>`; }).join("")}</div>` : empty("No threads yet", "Add a thread for a conversation or route toward this opportunity. You can assign a SPOC later.", "add-thread", "Add first thread", "↗")));
}

function renderThread() {
  const item = thread(selectedThread);
  const opp = opportunity(item.opportunityId);
  const person = contact(item.contactId);
  const entries = entriesFor(item.id);
  const links = threadLinks(item);
  const images = threadImages(item);
  main.innerHTML = workspaceShell(`<section class="chat-window"><header class="chat-header"><button class="back" data-action="back-opportunity" type="button">← ${escapeHtml(opp?.title || "Opportunity")}</button><div class="chat-title-row"><div class="contact-avatar">${escapeHtml(spocAvatar(item))}</div><div><p class="eyebrow">${escapeHtml(spocName(item))}</p><h1>${escapeHtml(item.title)}</h1><p>${escapeHtml(item.purpose || "Record how this thread could move the opportunity ahead.")}</p></div></div><div class="detail-actions"><span class="badge ${item.status}">${escapeHtml(item.status)}</span>${item.nextDate && item.status === "open" ? nextBadge(item.nextDate) : ""}<button class="button secondary small" data-action="edit-thread" type="button">Edit</button><button class="button secondary small" data-action="delete-thread" type="button">Delete</button></div></header><div class="chat-stream">${item.description ? `<article class="chat-bubble note-bubble"><span>Thread description</span><p>${escapeHtml(item.description)}</p></article>` : ""}${links.length || images.length ? `<article class="chat-bubble note-bubble"><span>Links and images</span><div class="asset-grid">${links.map(link => `<a class="asset-link" href="${escapeHtml(safeHref(link.url))}" target="_blank" rel="noreferrer"><span>↗</span><strong>${escapeHtml(link.label || link.url)}</strong><small>${escapeHtml(link.url)}</small></a>`).join("")}${images.map(image => `<figure class="asset-image"><img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name || "Thread image")}"><figcaption>${escapeHtml(image.name || "Image")}</figcaption></figure>`).join("")}</div></article>` : ""}${entries.length ? entries.slice().reverse().map(entry => `<article class="chat-bubble"><div class="entry-top"><span class="badge ${entry.type === "commitment" ? "active" : ""}">${escapeHtml(entry.type)}</span><span>${escapeHtml(prettyDate(entry.createdAt))}</span><button class="icon-button" data-action="delete-entry" data-id="${entry.id}" type="button" aria-label="Delete update" title="Delete update" style="margin-left:auto;font-size:16px;width:24px;height:24px">×</button></div><p>${escapeHtml(entry.text)}</p></article>`).join("") : `<div class="chat-empty">${empty("No updates yet", "Log a conversation, a commitment, or the next step. Your notes stay on this device.", "add-entry", "Add update", "✎")}</div>`}</div><footer class="chat-composer"><button class="button primary" data-action="add-entry" type="button">＋ Add update</button></footer></section>`);
}

function renderFollowups() {
  const items = dueThreads();
  const overdue = items.filter(item => item.nextDate < today());
  const todayItems = items.filter(item => item.nextDate === today());
  const upcoming = items.filter(item => item.nextDate > today());
  function group(label, rows) { return rows.length ? `<div class="section-label">${label} · ${rows.length}</div><div class="card-list">${rows.map(item => { const person = contact(item.contactId); const opp = opportunity(item.opportunityId); return `<article class="card"><div class="card-line"><h2>${escapeHtml(item.title)}</h2>${nextBadge(item.nextDate)}</div><p>${escapeHtml(spocName(item))} · ${escapeHtml(opp?.title || "Unknown opportunity")}</p><div class="meta-row"><button class="button secondary small" data-action="open-followup" data-id="${item.id}" type="button">Open thread</button><button class="button primary small" data-action="complete-followup" data-id="${item.id}" type="button">Mark done</button></div></article>`; }).join("")}</div>` : ""; }
  main.innerHTML = header("Stay in motion", "Follow-ups", "Next actions across all your opportunities.") + (items.length ? group("Overdue",overdue)+group("Today",todayItems)+group("Upcoming",upcoming) : empty("Nothing to follow up", "Set a next follow-up date inside a thread to see it here.", "", "", "✓"));
}

function renderPeople() {
  const items = [...data.contacts].sort((a,b) => a.name.localeCompare(b.name));
  main.innerHTML = header("Your network", "People", "Each person can be linked to several opportunities.", `<button class="button primary" data-action="add-person" type="button">＋ New</button>`) +
    (items.length ? `<div class="card-list">${items.map(person => { const linked = data.threads.filter(item => item.contactId === person.id); return `<article class="card"><div class="person-row"><div class="contact-avatar">${escapeHtml(initials(person.name))}</div><div class="person-copy"><h2>${escapeHtml(person.name)}</h2><p>${escapeHtml([person.role,person.organization].filter(Boolean).join(" · ") || "No organization")}</p></div><button class="button secondary small" data-action="edit-person" data-id="${person.id}" type="button">Edit</button></div><div class="meta-row"><span>${linked.length} linked ${linked.length === 1 ? "thread" : "threads"}</span>${person.email ? `<span>·</span><span>${escapeHtml(person.email)}</span>` : ""}</div></article>`; }).join("")}</div>` : empty("Your network starts here", "Add a person now, or create one while adding a thread.", "add-person", "Add person", "◎"));
}

function renderSettings() {
  main.innerHTML = `<button class="back" data-action="back-opportunities" type="button">← Opportunities</button>` + header("Data and privacy", "Backup & restore", "Your CRM stays on this device and works without an internet connection.") +
    `<div class="note-box">A backup contains every opportunity, contact, thread, update and follow-up. Save the file somewhere outside Chrome so you can restore it later.</div><div class="settings-list"><article class="card"><h2>Download complete backup</h2><p>Save your entire CRM as one JSON file.</p><button class="button primary" data-action="backup" type="button">Download backup</button></article><article class="card"><h2>Restore from backup</h2><p>Choose a backup made by Opportunity Hunter. Restore replaces the CRM currently on this device.</p><button class="button secondary" data-action="restore" type="button">Choose backup file</button></article></div><div class="divider"></div><p class="field-hint">This extension has no account, server connection, or cloud sync. Keep a copy of your backup in a safe place.</p>`;
}

function field(label, name, value = "", opts = {}) { const required = opts.required ? " required" : ""; const hint = opts.hint ? `<span class="field-hint">${opts.hint}</span>` : ""; const control = opts.type === "textarea" ? `<textarea name="${name}"${required} placeholder="${escapeHtml(opts.placeholder || "")}">${escapeHtml(value)}</textarea>` : opts.type === "select" ? `<select name="${name}"${required}>${opts.options.map(([v,l]) => `<option value="${escapeHtml(v)}"${v === value ? " selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select>` : `<input name="${name}" type="${opts.type || "text"}" value="${escapeHtml(value)}"${required} placeholder="${escapeHtml(opts.placeholder || "")}" ${opts.maxlength ? `maxlength="${opts.maxlength}"` : ""}>`; return `<label class="field">${label}${control}${hint}</label>`; }

function openDialog(mode, id = null) {
  dialogMode = mode; dialogId = id;
  pastedImages = [];
  const opp = mode.includes("opportunity") && id ? opportunity(id) : null;
  const person = mode.includes("person") && id ? contact(id) : null;
  const item = mode.includes("thread") && id ? thread(id) : null;
  const titles = { "add-opportunity": ["New opportunity", "What could happen?"], "edit-opportunity": ["Opportunity", "Edit opportunity"], "add-person": ["New contact", "Add a person"], "edit-person": ["Contact", "Edit person"], "add-thread": ["New path", "Add a thread"], "edit-thread": ["Thread", "Edit thread"], "add-entry": ["Thread update", "Capture what happened"] };
  document.getElementById("dialogEyebrow").textContent = titles[mode][0];
  document.getElementById("dialogTitle").textContent = titles[mode][1];
  let html = "";
  if (mode.includes("opportunity")) { const categories = [...new Set(data.opportunities.map(categoryFor).filter(name => name !== "Uncategorized"))].sort((a,b) => a.localeCompare(b)); html = field("Opportunity name", "title", opp?.title, { required:true, maxlength:120, placeholder:"e.g. Partner with Northstar" }) + field("What is the opportunity?", "summary", opp?.summary, { type:"textarea", placeholder:"A short description of the possibility" }) + `<label class="field">Category<input name="category" type="text" list="categorySuggestions" value="${escapeHtml(opp?.category || "")}" maxlength="80" placeholder="e.g. Venture Capital"><span class="field-hint">Choose an existing category or type a new one. Leave blank for Uncategorized.</span></label><datalist id="categorySuggestions">${categories.map(name => `<option value="${escapeHtml(name)}"></option>`).join("")}</datalist>` + field("Status", "status", opp?.status || "active", { type:"select", options:[["active","Active"],["paused","Paused"],["closed","Closed"]] }); }
  if (mode.includes("person")) html = field("Name", "name", person?.name, { required:true, maxlength:120 }) + field("Organization", "organization", person?.organization, { maxlength:120 }) + field("Role", "role", person?.role, { maxlength:120 }) + field("Email or other contact detail", "email", person?.email, { maxlength:200 });
  if (mode.includes("thread")) { const options = [["","No SPOC yet"], ...data.contacts.map(p => [p.id, `${p.name}${p.organization ? ` · ${p.organization}` : ""}`]), ["__new__","＋ Add new person"]]; html = field("Thread name", "title", item?.title, { required:true, maxlength:120, placeholder:"e.g. Introduction to decision maker" }) + field("Person / SPOC (optional)", "contactId", item?.contactId || "", { type:"select", options }) + `<div id="newPersonField" class="hidden">${field("New person's name", "newPersonName", "", { maxlength:120, placeholder:"Full name" })}</div>` + field("How could this thread move the opportunity forward?", "purpose", item?.purpose, { type:"textarea", placeholder:"Possible approach, contribution, or next step" }) + field("Thread description", "description", item?.description, { type:"textarea", placeholder:"Context, background, constraints, or anything useful to remember." }) + field("Links", "links", threadLinks(item).map(link => `${link.label && link.label !== link.url ? `${link.label} | ` : ""}${link.url}`).join("\n"), { type:"textarea", placeholder:"One per line. Use Label | https://example.com if you want a custom label.", hint:"Links are stored locally with the thread and included in backups." }) + `<label class="field">Images<input name="images" type="file" accept="image/*" multiple><span class="field-hint">${threadImages(item).length ? `${threadImages(item).length} saved image${threadImages(item).length === 1 ? "" : "s"}. New selections are added to the thread.` : "Optional. Images are saved inside your local CRM backup."}</span></label><label class="field">Paste images<div id="pasteTarget" class="paste-target" tabindex="0"><div id="pastedImagePreview" class="paste-preview"><span>Paste copied images here.</span></div></div><span class="field-hint">Click the box and press Paste. Pasted images are saved with uploaded images.</span></label>` + field("Next follow-up date", "nextDate", item?.nextDate, { type:"date", hint:"Optional. It will appear in Follow-ups." }) + field("Status", "status", item?.status || "open", { type:"select", options:[["open","Open"],["done","Done"]] }); }
  if (mode === "add-entry") html = field("Update type", "type", "conversation", { type:"select", options:[["conversation","Conversation"],["commitment","Commitment"],["next step","Next step"],["insight","Insight / surprise"],["note","Note"]] }) + field("What happened?", "text", "", { type:"textarea", required:true, placeholder:"Capture the useful detail, agreement, or next action." });
  document.getElementById("formFields").innerHTML = html;
  document.getElementById("saveDialog").textContent = mode.startsWith("add") ? "Create" : "Save changes";
  dialog.showModal();
  renderPastedImages();
  dialog.querySelector("input:not([type=date]),textarea,select")?.focus();
}

async function saveForm(event) {
  event.preventDefault();
  const formData = new FormData(form);
  const values = Object.fromEntries(formData.entries());
  const trimmed = key => String(values[key] || "").trim();
  if (dialogMode.includes("thread") && values.contactId === "__new__" && !trimmed("newPersonName")) { toast("Enter the new person's name."); return; }
  let addedImages = [];
  try { if (dialogMode.includes("thread")) addedImages = [...await readImages(formData.getAll("images")), ...pastedImages]; }
  catch (error) { toast(error.message); return; }
  const mode = dialogMode, id = dialogId, stamp = now();
  const saved = await change(next => {
    if (mode === "add-opportunity") { const category = normalizedCategory(trimmed("category")); const opp = { id:uid(), title:trimmed("title"), summary:trimmed("summary"), category, status:values.status, createdAt:stamp, updatedAt:stamp }; next.opportunities.push(opp); expandedFolders.add(category || "Uncategorized"); selectedOpportunity = opp.id; selectedThread = null; view = "opportunities"; }
    if (mode === "edit-opportunity") { const opp = next.opportunities.find(x => x.id === id); const category = normalizedCategory(trimmed("category")); Object.assign(opp, { title:trimmed("title"), summary:trimmed("summary"), category, status:values.status, updatedAt:stamp }); expandedFolders.add(category || "Uncategorized"); }
    if (mode === "add-person") next.contacts.push({ id:uid(), name:trimmed("name"), organization:trimmed("organization"), role:trimmed("role"), email:trimmed("email"), createdAt:stamp });
    if (mode === "edit-person") { const person = next.contacts.find(x => x.id === id); Object.assign(person, { name:trimmed("name"), organization:trimmed("organization"), role:trimmed("role"), email:trimmed("email") }); }
    if (mode === "add-thread" || mode === "edit-thread") { let personId = values.contactId || null; if (personId === "__new__") { personId = uid(); next.contacts.push({ id:personId, name:trimmed("newPersonName"), organization:"", role:"", email:"", createdAt:stamp }); } const existing = mode === "edit-thread" ? next.threads.find(x => x.id === id) : null; const update = { title:trimmed("title"), contactId:personId, purpose:trimmed("purpose"), description:trimmed("description"), links:parseLinks(values.links), images:[...threadImages(existing || {}), ...addedImages], nextDate:values.status === "done" ? "" : values.nextDate, status:values.status, updatedAt:stamp }; if (mode === "add-thread") { const newThread = { id:uid(), opportunityId:selectedOpportunity, ...update, createdAt:stamp }; next.threads.push(newThread); selectedThread = newThread.id; } else Object.assign(existing, update); const opp = next.opportunities.find(x => x.id === selectedOpportunity); if (opp) opp.updatedAt = stamp; }
    if (mode === "add-entry") { next.entries.push({ id:uid(), threadId:selectedThread, type:values.type, text:trimmed("text"), createdAt:stamp }); const item = next.threads.find(x => x.id === selectedThread); item.updatedAt = stamp; const opp = next.opportunities.find(x => x.id === item.opportunityId); if (opp) opp.updatedAt = stamp; }
  }, "Saved locally");
  if (saved) dialog.close();
}

async function removeOpportunity() { if (!confirm("Delete this opportunity and all its threads and updates? This cannot be undone unless you have a backup.")) return; const id = selectedOpportunity; await change(next => { const ids = new Set(next.threads.filter(t => t.opportunityId === id).map(t => t.id)); next.opportunities = next.opportunities.filter(x => x.id !== id); next.threads = next.threads.filter(x => x.opportunityId !== id); next.entries = next.entries.filter(x => !ids.has(x.threadId)); selectedOpportunity = null; selectedThread = null; }, "Opportunity deleted"); }
async function removeThread() { if (!confirm("Delete this thread and its updates?")) return; const id = selectedThread; await change(next => { next.threads = next.threads.filter(x => x.id !== id); next.entries = next.entries.filter(x => x.threadId !== id); selectedThread = null; }, "Thread deleted"); }
async function removeEntry(id) { if (!confirm("Delete this update?")) return; await change(next => { next.entries = next.entries.filter(x => x.id !== id); }, "Update deleted"); }

function downloadBackup() {
  const backup = { format:FORMAT, schemaVersion:1, exportedAt:now(), data };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `opportunity-hunter-backup-${today()}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast("Complete backup downloaded");
}

function validateBackup(value) {
  if (!value || value.format !== FORMAT || value.schemaVersion !== 1 || !value.data) throw new Error("This is not a supported Opportunity Hunter backup.");
  const candidate = value.data;
  for (const name of ["opportunities","contacts","threads","entries"]) if (!Array.isArray(candidate[name])) throw new Error(`Backup is missing ${name}.`);
  const ids = new Set();
  for (const name of ["opportunities","contacts","threads","entries"]) for (const item of candidate[name]) { if (!item || typeof item.id !== "string" || ids.has(item.id)) throw new Error("Backup contains an invalid or duplicate record ID."); ids.add(item.id); }
  const oppIds = new Set(candidate.opportunities.map(x => x.id)), personIds = new Set(candidate.contacts.map(x => x.id)), threadIds = new Set(candidate.threads.map(x => x.id));
  for (const item of candidate.opportunities) if (typeof item.title !== "string" || (item.category !== undefined && typeof item.category !== "string")) throw new Error("Backup contains an invalid opportunity.");
  for (const item of candidate.contacts) if (typeof item.name !== "string") throw new Error("Backup contains an invalid contact.");
  for (const item of candidate.threads) {
    if (!oppIds.has(item.opportunityId) || (item.contactId != null && item.contactId !== "" && !personIds.has(item.contactId)) || typeof item.title !== "string") throw new Error("Backup contains a broken thread link.");
    if (item.description !== undefined && typeof item.description !== "string") throw new Error("Backup contains an invalid thread description.");
    if (item.links !== undefined && (!Array.isArray(item.links) || item.links.some(link => !link || typeof link.url !== "string"))) throw new Error("Backup contains an invalid thread link.");
    if (item.images !== undefined && (!Array.isArray(item.images) || item.images.some(image => !image || typeof image.dataUrl !== "string" || !image.dataUrl.startsWith("data:image/")))) throw new Error("Backup contains an invalid thread image.");
  }
  for (const item of candidate.entries) if (!threadIds.has(item.threadId) || typeof item.text !== "string") throw new Error("Backup contains a broken update link.");
  return candidate;
}

async function restoreBackup(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const candidate = validateBackup(parsed);
    if (!confirm(`Restore backup from ${prettyDate(parsed.exportedAt || "") || "an unknown date"}? This replaces all current CRM data on this device.`)) return;
    await persist(candidate);
    view = "opportunities"; selectedOpportunity = null; selectedThread = null; searchTerm = ""; render();
    toast("CRM restored successfully");
  } catch (error) { console.error(error); toast(error.message || "Could not restore this backup."); }
  finally { restoreInput.value = ""; }
}

document.querySelector(".tabs").addEventListener("click", event => { const tab = event.target.closest("[data-view]"); if (!tab) return; view = tab.dataset.view; selectedOpportunity = null; selectedThread = null; render(); });
const openTabButton = document.getElementById("openTabButton");
if (new URLSearchParams(location.search).has("tab")) { openTabButton.classList.add("hidden"); document.body.classList.add("tab-layout"); }
openTabButton.addEventListener("click", async () => {
  try { await chrome.tabs.create({ url: chrome.runtime.getURL("panel.html?tab=1") }); }
  catch (error) { console.error(error); toast("Could not open a separate tab."); }
});
document.getElementById("settingsButton").addEventListener("click", () => { view = "settings"; render(); });
document.getElementById("closeDialog").addEventListener("click", () => dialog.close());
document.getElementById("cancelDialog").addEventListener("click", () => dialog.close());
form.addEventListener("submit", saveForm);
form.addEventListener("change", event => { if (event.target.name === "contactId") { const el = document.getElementById("newPersonField"); el.classList.toggle("hidden", event.target.value !== "__new__"); el.querySelector("input").required = event.target.value === "__new__"; } });
form.addEventListener("paste", event => { if (!dialogMode?.includes("thread")) return; const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean); if (files.length) { event.preventDefault(); addClipboardImages(files); } });
restoreInput.addEventListener("change", () => { if (restoreInput.files[0]) restoreBackup(restoreInput.files[0]); });
main.addEventListener("input", event => { if (event.target.id === "search") { searchTerm = event.target.value.toLowerCase().trim(); const pos = event.target.selectionStart; render(); const input = document.getElementById("search"); input?.focus(); input?.setSelectionRange(pos,pos); } });
main.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === " ") && event.target.matches('[role="button"][data-action]')) { event.preventDefault(); event.target.click(); } });
main.addEventListener("click", async event => {
  const target = event.target.closest("[data-action]"); if (!target) return;
  const action = target.dataset.action, id = target.dataset.id;
  if (["add-opportunity","edit-opportunity","add-person","edit-person","add-thread","edit-thread","add-entry"].includes(action)) { openDialog(action, action === "edit-opportunity" ? selectedOpportunity : action === "edit-thread" ? selectedThread : id); return; }
  if (action === "open-opportunity") { selectedOpportunity = id; selectedThread = null; render(); }
  if (action === "toggle-category") { const category = target.dataset.category; if (expandedFolders.has(category)) expandedFolders.delete(category); else expandedFolders.add(category); renderOpportunities(); }
  if (action === "open-thread-from-tree") { const item = thread(id); selectedOpportunity = item.opportunityId; selectedThread = id; render(); }
  if (action === "open-thread") { selectedThread = id; render(); }
  if (action === "open-followup") { const item = thread(id); selectedOpportunity = item.opportunityId; selectedThread = id; view = "opportunities"; render(); }
  if (action === "back-opportunities") { view = "opportunities"; selectedOpportunity = null; selectedThread = null; render(); }
  if (action === "back-opportunity") { selectedThread = null; render(); }
  if (action === "delete-opportunity") await removeOpportunity();
  if (action === "delete-thread") await removeThread();
  if (action === "delete-entry") await removeEntry(id);
  if (action === "complete-followup") await change(next => { const item = next.threads.find(x => x.id === id); item.nextDate = ""; item.updatedAt = now(); }, "Follow-up completed");
  if (action === "backup") downloadBackup();
  if (action === "restore") restoreInput.click();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]?.newValue) return;
  try { data = validateBackup({ format:FORMAT, schemaVersion:1, data:changes[STORAGE_KEY].newValue }); render(); }
  catch (error) { console.error("Ignoring invalid storage update", error); }
});

(async () => {
  try { const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]; if (stored) data = validateBackup({ format:FORMAT, schemaVersion:1, data:stored }); render(); }
  catch (error) { console.error(error); main.innerHTML = empty("Could not load CRM", "The local data could not be read. Please check Chrome storage before making changes.", "", "", "!"); }
})();
