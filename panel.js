const STORAGE_KEY = "omsData";
const VIEW_KEY = "omsView";
const FORMAT = "opportunity-hunter-oms";
const emptyData = () => ({ schemaVersion: 1, categories: [], opportunities: [], contacts: [], threads: [], entries: [], tasks: [] });
const validViews = new Set(["opportunities","followups","tasks","people","nextsteps","settings"]);

let data = emptyData();
let view = validViews.has(localStorage.getItem(VIEW_KEY)) ? localStorage.getItem(VIEW_KEY) : "opportunities";
let selectedOpportunity = null;
let selectedThread = null;
let searchTerm = "";
let sidebarCollapsed = localStorage.getItem("omsSidebarCollapsed") === "true";
const expandedFolders = new Set();
let dialogMode = null;
let dialogId = null;
let pastedImages = [];
let toastTimer;
let contextEntryId = null;
let editPanelOpen = false;
let opportunityCategoryPreset = "";
let taskPage = 1;
let taskPageSize = Number(localStorage.getItem("omsTaskPageSize") || 12);
let taskFilters = { kind:"all", severity:"all", status:"open" };
let peoplePage = 1;
let peoplePageSize = Number(localStorage.getItem("omsPeoplePageSize") || 12);
let peopleFilters = { search:"", link:"all", contact:"all" };

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
function routeThread(id) { return `#thread/${encodeURIComponent(id)}`; }
function setRoute(replace = false) {
  const target = selectedThread && thread(selectedThread) ? routeThread(selectedThread) : location.pathname + location.search;
  if (selectedThread && location.hash === target) return;
  if (!selectedThread && !location.hash) return;
  history[replace ? "replaceState" : "pushState"](null, "", target);
}
function applyRouteFromUrl() {
  const match = location.hash.match(/^#thread\/(.+)$/);
  if (!match) return false;
  const item = thread(decodeURIComponent(match[1]));
  if (!item) { selectedThread = null; setRoute(true); return false; }
  view = "opportunities";
  selectedOpportunity = item.opportunityId;
  selectedThread = item.id;
  expandedFolders.add(categoryFor(opportunity(item.opportunityId) || {}));
  return true;
}
function threadsFor(oppId) { return data.threads.filter(item => item.opportunityId === oppId); }
function categoryFor(item) { return item.category?.trim() || "Uncategorized"; }
function categoryNames(source = data) { return [...new Set([...(Array.isArray(source.categories) ? source.categories : []), ...source.opportunities.map(categoryFor)].filter(Boolean))]; }
function normalizedCategory(value) { const category = String(value || "").trim(); return categoryNames().find(existing => existing.toLowerCase() === category.toLowerCase()) || category; }
function categoryFromValues(values, trimmed) { return normalizedCategory(values.categorySelect === "__new__" ? trimmed("newCategory") : values.categorySelect); }
function entriesFor(threadId) { return data.entries.filter(item => item.threadId === threadId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
function nextStepEntries() { return data.entries.filter(entry => entry.type === "next step").map(entry => ({ entry, thread:thread(entry.threadId) })).filter(item => item.thread).sort((a,b) => b.entry.createdAt.localeCompare(a.entry.createdAt)); }
function dueThreads() { return data.threads.filter(item => item.status === "open" && item.nextDate).sort((a,b) => a.nextDate.localeCompare(b.nextDate)); }
function isOverdue(value) { return value && value < today(); }
function nextBadge(value) { if (!value) return ""; const label = isOverdue(value) ? "Overdue" : value === today() ? "Today" : prettyDate(value); const cls = isOverdue(value) ? "overdue" : value === today() ? "today" : ""; return `<span class="badge ${cls}">${escapeHtml(label)}</span>`; }
function toast(message) { const el = document.getElementById("toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3000); }
function threadLinks(item) { return Array.isArray(item?.links) ? item.links : []; }
function threadImages(item) { return Array.isArray(item?.images) ? item.images : []; }
function entryAttachments(item) { return Array.isArray(item?.attachments) ? item.attachments : []; }
const updateTypeOptions = [["conversation","💬 Conversation"],["commitment","🤝 Commitment"],["next step","➡️ Next step"],["insight","💡 Insight / surprise"],["note","📝 Note"]];
function updateTypeLabel(type) { return updateTypeOptions.find(([value]) => value === type)?.[1] || type; }
const threadOutcomeOptions = [["exploring","🔎 Exploring"],["promising","🌱 Promising"],["successful","✅ Successful"],["dead-end","⛔ Dead end"],["limbo","⏳ Limbo"],["unresponsive","📭 Unresponsive"],["paused","⏸️ Paused"]];
function threadOutcome(item) { return item?.outcomeStatus || "exploring"; }
function threadOutcomeLabel(item) { return threadOutcomeOptions.find(([value]) => value === threadOutcome(item))?.[1] || "🔎 Exploring"; }
function taskList() { return Array.isArray(data.tasks) ? data.tasks : []; }
function luckValue(item) { const value = Number(item?.luck ?? 0); return Math.max(-5, Math.min(5, Number.isFinite(value) ? value : 0)); }
function luckLabel(value) {
  const score = Number(value);
  if (score <= -5) return "Catastrophe";
  if (score <= -3) return "Bad luck";
  if (score < 0) return "Unlucky";
  if (score === 0) return "Neutral";
  if (score < 3) return "Lucky";
  if (score < 5) return "Very lucky";
  return "Serendipitous";
}
function taskKindLabel(value) { return value === "want" ? "Want" : "Need"; }
const taskPriorityOptions = [["low","Low"],["medium","Medium"],["high","High"]];
function taskPriorityLabel(value) { return taskPriorityOptions.find(([key]) => key === value)?.[1] || "Medium"; }
function taskPriorityValue(value) { return taskPriorityOptions.some(([key]) => key === value) ? value : "medium"; }
function taskPriorityScore(value) { const normalized = taskPriorityValue(value); return normalized === "high" ? 3 : normalized === "medium" ? 2 : 1; }
function taskGapValue(item) { const value = Number(item?.gap ?? 1); return Math.max(1, Math.min(5, Number.isFinite(value) ? value : 1)); }
function problemIndex(item) { return taskGapValue(item) * taskPriorityScore(item?.importance) * taskPriorityScore(item?.urgency); }
function problemIndexLabel(value) {
  if (value >= 36) return "Critical";
  if (value >= 24) return "High";
  if (value >= 12) return "Moderate";
  return "Low";
}
function problemIndexClass(value) { return `problem-${problemIndexLabel(value).toLowerCase()}`; }
function matchesTaskFilters(item) {
  const severity = problemIndexLabel(problemIndex(item)).toLowerCase();
  if (taskFilters.kind !== "all" && (item.kind === "want" ? "want" : "need") !== taskFilters.kind) return false;
  if (taskFilters.severity !== "all" && severity !== taskFilters.severity) return false;
  if (taskFilters.status === "open" && item.done) return false;
  if (taskFilters.status === "done" && !item.done) return false;
  return true;
}
function taskThreadLabel(item) {
  const mappedThread = thread(item?.threadId);
  if (!mappedThread) return "No thread mapped";
  return threadOptionLabel(mappedThread);
}
function threadOptionLabel(mappedThread) {
  const opp = opportunity(mappedThread.opportunityId);
  return `${mappedThread.title}${opp ? ` · ${opp.title}` : ""}`;
}
const taskIconOptions = ["✓","★","⚑","⚙","↗","💡","📌","💰","📚","🧭","🧪","🛠"];
function taskIcon(item) { return taskIconOptions.includes(item?.icon) ? item.icon : "✓"; }
function taskPageSizeOptions() { return [6, 9, 12, 16, 24]; }
function linkedThreadsForPerson(id) { return data.threads.filter(item => item.contactId === id); }
function hasPersonContactInfo(person) { return !!(person?.email || person?.phone || contactLinks(person?.socialLinks).length); }
function personSearchText(person) { return [person?.name, person?.organization, person?.role, person?.email, person?.phone, person?.socialLinks].filter(Boolean).join(" ").toLowerCase(); }
function matchesPeopleFilters(person) {
  const search = peopleFilters.search.trim().toLowerCase();
  const linkedCount = linkedThreadsForPerson(person.id).length;
  if (search && !personSearchText(person).includes(search)) return false;
  if (peopleFilters.link === "linked" && !linkedCount) return false;
  if (peopleFilters.link === "unlinked" && linkedCount) return false;
  if (peopleFilters.contact === "with" && !hasPersonContactInfo(person)) return false;
  if (peopleFilters.contact === "missing" && hasPersonContactInfo(person)) return false;
  return true;
}
const luckScale = [["-5","Catastrophe"],["-4","Disaster"],["-3","Bad luck"],["-2","Trouble"],["-1","Friction"],["0","Neutral"],["+1","Small luck"],["+2","Lucky"],["+3","Fortunate"],["+4","Very lucky"],["+5","Serendipitous"]];
function luckScaleMarkup() { return `<div class="luck-scale" aria-hidden="true">${luckScale.map(([number, name]) => `<span><strong>${escapeHtml(number)}</strong><em>${escapeHtml(name)}</em></span>`).join("")}</div>`; }
const gapScale = [["1","Small"],["2","Noticeable"],["3","Meaningful"],["4","Large"],["5","Wide"]];
function gapScaleMarkup() { return `<div class="gap-scale" aria-hidden="true">${gapScale.map(([number, name]) => `<span><strong>${escapeHtml(number)}</strong><em>${escapeHtml(name)}</em></span>`).join("")}</div>`; }
function safeHref(value) { try { let text = String(value || "").trim(); if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(text)) text = `https://${text}`; const url = new URL(text, location.href); return ["http:","https:","mailto:","tel:"].includes(url.protocol) ? url.href : "#"; } catch { return "#"; } }
function contactLinks(value) {
  return String(value || "").split(/\n+/).map(text => text.trim()).filter(Boolean).map(text => {
    const [labelPart, ...urlParts] = text.split("|");
    const url = (urlParts.length ? urlParts.join("|") : labelPart).trim();
    const label = (urlParts.length ? labelPart : url).trim();
    return { label, url };
  });
}
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
async function readAttachments(files) {
  const attachments = [...files].filter(file => file && file.name && file.size > 0);
  if (!attachments.length) return [];
  const limit = 8 * 1024 * 1024;
  const tooLarge = attachments.find(file => file.size > limit);
  if (tooLarge) throw new Error("Each attachment must be 8 MB or smaller.");
  return Promise.all(attachments.map(file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ id:uid(), name:file.name, type:file.type || "application/octet-stream", size:file.size, dataUrl:reader.result, createdAt:now() });
    reader.onerror = () => reject(new Error("Could not read one of the attachments."));
    reader.readAsDataURL(file);
  })));
}
function fileSize(bytes) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function renderEntryAttachments(entry) {
  const attachments = entryAttachments(entry);
  if (!attachments.length) return "";
  return `<div class="entry-attachments">${attachments.map(file => {
    const type = file.type || "";
    if (type.startsWith("image/")) return `<figure class="entry-media"><img src="${escapeHtml(file.dataUrl)}" alt="${escapeHtml(file.name || "Attachment")}"><figcaption>${escapeHtml(file.name || "Image")}</figcaption></figure>`;
    if (type.startsWith("video/")) return `<figure class="entry-media"><video src="${escapeHtml(file.dataUrl)}" controls></video><figcaption>${escapeHtml(file.name || "Video")}</figcaption></figure>`;
    if (type.startsWith("audio/")) return `<div class="entry-file"><span>♫</span><div><strong>${escapeHtml(file.name || "Audio")}</strong><audio src="${escapeHtml(file.dataUrl)}" controls></audio><small>${escapeHtml(fileSize(file.size))}</small></div></div>`;
    return `<a class="entry-file" href="${escapeHtml(file.dataUrl)}" download="${escapeHtml(file.name || "attachment")}" target="_blank" rel="noreferrer"><span>□</span><div><strong>${escapeHtml(file.name || "Attachment")}</strong><small>${escapeHtml([file.type, fileSize(file.size)].filter(Boolean).join(" · "))}</small></div></a>`;
  }).join("")}</div>`;
}
function renderEntry(entry) {
  return `<article class="chat-bubble" data-entry-id="${escapeHtml(entry.id)}"><div class="entry-top"><span class="badge ${entry.type === "commitment" ? "active" : ""}">${escapeHtml(updateTypeLabel(entry.type))}</span><span>${escapeHtml(prettyDate(entry.createdAt))}</span><button class="icon-button" data-action="delete-entry" data-id="${entry.id}" type="button" aria-label="Delete update" title="Delete update" style="margin-left:auto;font-size:16px;width:24px;height:24px">×</button></div>${entry.text ? `<p>${escapeHtml(entry.text)}</p>` : ""}${renderEntryAttachments(entry)}</article>`;
}
function renderComposer() {
  return `<form class="chat-composer" data-action="quick-entry"><div class="attachment-picker"><button class="icon-button attach-button" data-action="toggle-attachment-menu" type="button" aria-label="Add attachment" title="Add attachment">＋</button><div class="attachment-menu" aria-label="Attachment options"><button data-action="choose-attachment" data-kind="media" type="button"><span>▧</span>Photo or video</button><button data-action="choose-attachment" data-kind="file" type="button"><span>□</span>File</button><button data-action="choose-attachment" data-kind="camera" type="button"><span>▣</span>Camera</button><button data-action="choose-attachment" data-kind="audio" type="button"><span>♫</span>Audio</button></div><input data-attachment-input="media" name="attachments" type="file" accept="image/*,video/*" multiple hidden><input data-attachment-input="file" name="attachments" type="file" multiple hidden><input data-attachment-input="camera" name="attachments" type="file" accept="image/*" capture="environment" hidden><input data-attachment-input="audio" name="attachments" type="file" accept="audio/*" multiple hidden></div><label class="composer-type"><span>Type</span><select name="type" aria-label="Update type">${updateTypeOptions.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}</select></label><label class="composer-text"><span>Update</span><textarea name="text" rows="1" placeholder="Type an update for this thread"></textarea></label><button class="button primary composer-send" type="submit">Send</button><div class="attachment-preview" aria-live="polite"></div></form>`;
}
function renderThreadEditor(item) {
  const options = [["","No SPOC yet"], ...data.contacts.map(person => [person.id, `${person.name}${person.organization ? ` · ${person.organization}` : ""}`])];
  return `<aside class="thread-editor-panel"><form data-action="save-thread-panel"><div class="panel-head"><div><p class="eyebrow">Edit thread</p><h2>${escapeHtml(item.title)}</h2></div><button class="icon-button" data-action="close-thread-editor" type="button" aria-label="Close editor">×</button></div><div class="form-fields">${field("Thread name", "title", item.title, { required:true, maxlength:120 })}${field("Person / SPOC", "contactId", item.contactId || "", { type:"select", options })}${field("Opportunity outcome", "outcomeStatus", threadOutcome(item), { type:"select", options:threadOutcomeOptions })}${field("How could this thread move the opportunity forward?", "purpose", item.purpose, { type:"textarea" })}${field("Thread description", "description", item.description, { type:"textarea" })}${field("Links", "links", threadLinks(item).map(link => `${link.label && link.label !== link.url ? `${link.label} | ` : ""}${link.url}`).join("\n"), { type:"textarea", hint:"One per line. Use Label | https://example.com for custom labels." })}${field("Next follow-up date", "nextDate", item.nextDate, { type:"date" })}${field("Workflow", "status", item.status || "open", { type:"select", options:[["open","Open"],["done","Done"]] })}</div><div class="panel-actions"><button class="button secondary" data-action="close-thread-editor" type="button">Cancel</button><button class="button primary" type="submit">Save changes</button></div></form></aside>`;
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
function sidebarIcon(type) {
  if (type === "thread") return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6.5A3.5 3.5 0 0 1 8.5 3h7A3.5 3.5 0 0 1 19 6.5v4a3.5 3.5 0 0 1-3.5 3.5h-4.4L6.5 18v-4H8.5A3.5 3.5 0 0 1 5 10.5z"></path><path d="M8.5 7.5h7M8.5 10.5h4.5"></path></svg>`;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2.5h6A2.5 2.5 0 0 1 20.5 10v6.5A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z"></path><path d="M4 9.5h16"></path></svg>`;
}
function categoryTree(compact = false) {
  const categories = categoryNames().sort((a,b) => a === "Uncategorized" ? 1 : b === "Uncategorized" ? -1 : a.localeCompare(b));
  const visibleCategories = categories.filter(category => category.toLowerCase().includes(searchTerm) || data.opportunities.some(item => categoryFor(item) === category && `${item.title} ${item.summary} ${threadsFor(item.id).map(thread => `${thread.title} ${contact(thread.contactId)?.name || ""}`).join(" ")}`.toLowerCase().includes(searchTerm)));
  return visibleCategories.length ? `<div class="folder-list ${compact ? "compact-tree" : ""}">${visibleCategories.map(category => {
    const allItems = data.opportunities.filter(item => categoryFor(item) === category).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    const items = searchTerm && !category.toLowerCase().includes(searchTerm) ? allItems.filter(item => `${item.title} ${item.summary} ${threadsFor(item.id).map(thread => `${thread.title} ${contact(thread.contactId)?.name || ""}`).join(" ")}`.toLowerCase().includes(searchTerm)) : allItems;
    const expanded = expandedFolders.has(category) || !!searchTerm || items.some(item => item.id === selectedOpportunity);
    return `<section class="folder"><div class="folder-header"><button class="folder-toggle" data-action="toggle-category" data-category="${escapeHtml(category)}" type="button" aria-expanded="${expanded}"><span class="folder-chevron">${expanded ? "▾" : "▸"}</span><span class="folder-icon" aria-hidden="true">${sidebarIcon("folder")}</span><span class="folder-title">${escapeHtml(category)}</span><span class="folder-count">${allItems.length}</span></button><button class="folder-add-opportunity" data-action="add-opportunity-to-category" data-category="${escapeHtml(category)}" type="button" aria-label="Add opportunity to ${escapeHtml(category)}" title="Add opportunity">+O</button></div>${expanded ? `<div class="folder-contents">${items.map(item => { const linked = threadsFor(item.id).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); return `<div class="tree-opportunity"><div class="tree-opportunity-row ${item.id === selectedOpportunity && !selectedThread ? "active-node" : ""}"><button class="tree-opportunity-button" data-action="open-opportunity" data-id="${item.id}" type="button"><span class="tree-node-icon" aria-hidden="true">◈</span><span class="tree-node-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.summary || "Open opportunity")}</small></span><span class="badge ${item.status}">${escapeHtml(item.status)}</span></button><button class="tree-add-thread" data-action="add-thread-to-opportunity" data-id="${item.id}" type="button" aria-label="Add thread to ${escapeHtml(item.title)}" title="Add thread">+T</button></div>${linked.length ? `<div class="tree-threads">${linked.map(item => `<button class="tree-thread ${item.id === selectedThread ? "active-node" : ""}" data-action="open-thread-from-tree" data-id="${item.id}" type="button"><span class="thread-icon" aria-hidden="true">${sidebarIcon("thread")}</span><span class="tree-avatar">${escapeHtml(spocAvatar(item))}</span><span class="tree-node-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(spocName(item))}${item.nextDate && item.status === "open" ? ` · Follow up ${escapeHtml(prettyDate(item.nextDate))}` : ""}</small></span></button>`).join("")}</div>` : `<div class="tree-empty">No threads yet</div>`}</div>`; }).join("")}</div>` : ""}</section>`;
  }).join("")}</div>` : "";
}
function workspaceShell(content) {
  return `<div class="workspace-layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}"><aside class="workspace-sidebar" aria-label="Categories sidebar"><div class="sidebar-head"><p class="eyebrow">Categories</p><div class="sidebar-actions"><button class="icon-button sidebar-toggle" data-action="toggle-sidebar" type="button" aria-label="${sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}" title="${sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}">${sidebarCollapsed ? "›" : "‹"}</button><button class="button primary small sidebar-new" data-action="add-category" type="button">＋ Add Category</button></div></div><div class="sidebar-body">${categoryNames().length ? `<input id="search" class="search" type="search" placeholder="Search categories" value="${escapeHtml(searchTerm)}" aria-label="Search categories, opportunities or people">` : ""}${categoryTree(true) || empty("No categories yet", "Create a category to start organizing opportunities.", "add-category", "Create category", "✦")}</div></aside><section class="workspace-content">${content}</section></div>`;
}

function render() {
  setRoute(true);
  if (validViews.has(view)) localStorage.setItem(VIEW_KEY, view);
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === view));
  const count = dueThreads().filter(item => item.nextDate <= today()).length;
  const pill = document.getElementById("dueCount");
  pill.textContent = count;
  pill.classList.toggle("hidden", count === 0);
  const nextSteps = nextStepEntries();
  const nextStepPill = document.getElementById("nextStepCount");
  nextStepPill.textContent = nextSteps.length;
  nextStepPill.classList.toggle("hidden", nextSteps.length === 0);
  if (view === "settings") renderSettings();
  else if (view === "nextsteps") renderNextSteps();
  else if (view === "followups") renderFollowups();
  else if (view === "tasks") renderTasks();
  else if (view === "people") renderPeople();
  else if (selectedThread && thread(selectedThread)) renderThread();
  else if (selectedOpportunity && opportunity(selectedOpportunity)) renderOpportunity();
  else renderOpportunities();
}

function renderOpportunities() {
  selectedOpportunity = null; selectedThread = null;
  const active = data.opportunities.filter(item => item.status === "active").length;
  const due = dueThreads().filter(item => item.nextDate <= today()).length;
  main.innerHTML = header("Your workspace", "Opportunities", "Browse categories, opportunities, and the people moving them forward.", `<button class="button primary" data-action="add-category" type="button">＋ New Category</button>`) +
    `<div class="summary-strip"><div class="stat"><strong>${data.opportunities.length}</strong><span>Total opportunities</span></div><div class="stat"><strong>${active}</strong><span>Active</span></div><div class="stat"><strong>${due}</strong><span>Due follow-ups</span></div></div>` +
    (categoryNames().length ? `<div class="toolbar"><input id="search" class="search" type="search" placeholder="Search categories, opportunities or people" value="${escapeHtml(searchTerm)}" aria-label="Search categories, opportunities or people"></div>` : "") +
    (categoryTree() || empty(categoryNames().length ? "No matching categories" : "Start with a category", categoryNames().length ? "Try a different search term." : "Create a category, then add opportunities inside it.", categoryNames().length ? "" : "add-category", "Create category", "✦"));
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
  main.innerHTML = workspaceShell(`<div class="thread-detail-layout ${editPanelOpen ? "editor-open" : ""}"><section class="chat-window"><header class="chat-header"><button class="back" data-action="back-opportunity" type="button">← ${escapeHtml(opp?.title || "Opportunity")}</button><div class="chat-title-row"><div class="contact-avatar">${escapeHtml(spocAvatar(item))}</div><div><p class="eyebrow">${escapeHtml(spocName(item))}</p><h1>${escapeHtml(item.title)}</h1><p>${escapeHtml(item.purpose || "Record how this thread could move the opportunity ahead.")}</p></div></div><div class="detail-actions"><span class="badge outcome-badge outcome-${escapeHtml(threadOutcome(item))}">${escapeHtml(threadOutcomeLabel(item))}</span><span class="badge ${item.status}">${escapeHtml(item.status || "open")}</span>${item.nextDate && item.status === "open" ? nextBadge(item.nextDate) : ""}<button class="button secondary small ${editPanelOpen ? "active-editor" : ""}" data-action="edit-thread" type="button">Edit</button><button class="button secondary small" data-action="delete-thread" type="button">Delete</button></div></header><div class="chat-stream">${item.description ? `<article class="chat-bubble note-bubble"><span>Thread description</span><p>${escapeHtml(item.description)}</p></article>` : ""}${links.length || images.length ? `<article class="chat-bubble note-bubble"><span>Links and images</span><div class="asset-grid">${links.map(link => `<a class="asset-link" href="${escapeHtml(safeHref(link.url))}" target="_blank" rel="noreferrer"><span>↗</span><strong>${escapeHtml(link.label || link.url)}</strong><small>${escapeHtml(link.url)}</small></a>`).join("")}${images.map(image => `<figure class="asset-image"><img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name || "Thread image")}"><figcaption>${escapeHtml(image.name || "Image")}</figcaption></figure>`).join("")}</div></article>` : ""}${entries.length ? entries.slice().reverse().map(renderEntry).join("") : `<div class="chat-empty">${empty("No updates yet", "Choose an update type, write a note, or attach a file below.", "", "", "✎")}</div>`}</div>${renderComposer()}</section>${editPanelOpen ? renderThreadEditor(item) : ""}</div>`);
}

function renderFollowups() {
  const items = dueThreads();
  const overdue = items.filter(item => item.nextDate < today());
  const todayItems = items.filter(item => item.nextDate === today());
  const upcoming = items.filter(item => item.nextDate > today());
  function group(label, rows) { return rows.length ? `<div class="section-label">${label} · ${rows.length}</div><div class="card-list">${rows.map(item => { const person = contact(item.contactId); const opp = opportunity(item.opportunityId); return `<article class="card"><div class="card-line"><h2>${escapeHtml(item.title)}</h2>${nextBadge(item.nextDate)}</div><p>${escapeHtml(spocName(item))} · ${escapeHtml(opp?.title || "Unknown opportunity")}</p><div class="meta-row"><button class="button secondary small" data-action="open-followup" data-id="${item.id}" type="button">Open thread</button><button class="button primary small" data-action="complete-followup" data-id="${item.id}" type="button">Mark done</button></div></article>`; }).join("")}</div>` : ""; }
  main.innerHTML = header("Stay in motion", "Follow-ups", "Next actions across all your opportunities.") + (items.length ? group("Overdue",overdue)+group("Today",todayItems)+group("Upcoming",upcoming) : empty("Nothing to follow up", "Set a next follow-up date inside a thread to see it here.", "", "", "✓"));
}

function renderNextSteps() {
  selectedOpportunity = null; selectedThread = null;
  const items = nextStepEntries();
  main.innerHTML = header("Notification stream", "Next steps", "A cumulative stream of next steps added across all opportunity threads.") +
    (items.length ? `<div class="card-list next-step-list">${items.map(({ entry, thread:item }) => { const opp = opportunity(item.opportunityId); return `<article class="card next-step-card"><div class="card-line"><div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(opp?.title || "Unknown opportunity")} · ${escapeHtml(spocName(item))}</p></div><span class="badge active">${escapeHtml(prettyDate(entry.createdAt))}</span></div><p class="long-text">${escapeHtml(entry.text || "No note added.")}</p>${renderEntryAttachments(entry)}<div class="meta-row"><button class="button secondary small" data-action="open-next-step-thread" data-id="${item.id}" type="button">Open thread</button></div></article>`; }).join("")}</div>` : empty("No next steps yet", "Add updates with type Next step inside any thread and they will appear here.", "", "", "↯"));
}

function renderPeople() {
  const items = [...data.contacts].sort((a,b) => a.name.localeCompare(b.name));
  const filteredItems = items.filter(matchesPeopleFilters);
  const linkedPeople = items.filter(person => linkedThreadsForPerson(person.id).length).length;
  const withDetails = items.filter(hasPersonContactInfo).length;
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / peoplePageSize));
  peoplePage = Math.min(Math.max(1, peoplePage), totalPages);
  const start = (peoplePage - 1) * peoplePageSize;
  const pageItems = filteredItems.slice(start, start + peoplePageSize);
  const filterPanel = `<aside class="task-filter-panel people-filter-panel"><p class="eyebrow">Filters</p><label class="field">Search<input id="peopleSearchFilter" type="search" value="${escapeHtml(peopleFilters.search)}" placeholder="Name, role, company, link"></label><label class="field">Linked threads<select id="peopleLinkFilter"><option value="all"${peopleFilters.link === "all" ? " selected" : ""}>All</option><option value="linked"${peopleFilters.link === "linked" ? " selected" : ""}>Linked</option><option value="unlinked"${peopleFilters.link === "unlinked" ? " selected" : ""}>Unlinked</option></select></label><label class="field">Contact details<select id="peopleContactFilter"><option value="all"${peopleFilters.contact === "all" ? " selected" : ""}>All</option><option value="with"${peopleFilters.contact === "with" ? " selected" : ""}>With details</option><option value="missing"${peopleFilters.contact === "missing" ? " selected" : ""}>Missing details</option></select></label><button class="button secondary small" data-action="reset-people-filters" type="button">Reset filters</button></aside>`;
  const pager = filteredItems.length ? `<div class="task-toolbar"><label class="page-size-control">People cards per page <select id="peoplePageSize" aria-label="People cards per page">${taskPageSizeOptions().map(size => `<option value="${size}"${size === peoplePageSize ? " selected" : ""}>${size}</option>`).join("")}</select></label><div class="pagination"><button class="button secondary small" data-action="people-prev-page" type="button"${peoplePage <= 1 ? " disabled" : ""}>Previous</button><span>Page ${peoplePage} of ${totalPages}</span><button class="button secondary small" data-action="people-next-page" type="button"${peoplePage >= totalPages ? " disabled" : ""}>Next</button></div></div>` : "";
  main.innerHTML = header("Your network", "People", "Each person can be linked to several opportunities.", `<button class="button primary" data-action="add-person" type="button">＋ New Person</button>`) +
    `<div class="summary-strip"><div class="stat"><strong>${items.length}</strong><span>Total people</span></div><div class="stat"><strong>${linkedPeople}</strong><span>Linked people</span></div><div class="stat"><strong>${withDetails}</strong><span>With contact details</span></div></div>` +
    (items.length ? `<div class="task-view-layout people-view-layout">${filterPanel}<section class="task-results">${pager}${filteredItems.length ? `<div class="card-list task-list people-list">${pageItems.map(person => { const linked = linkedThreadsForPerson(person.id); const socials = contactLinks(person.socialLinks); const contactChips = `${person.email ? `<a class="contact-chip" href="${escapeHtml(safeHref(person.email.includes("@") && !person.email.includes(":") ? `mailto:${person.email}` : person.email))}" target="_blank" rel="noreferrer">${escapeHtml(person.email)}</a>` : ""}${person.phone ? `<a class="contact-chip" href="${escapeHtml(safeHref(`tel:${person.phone}`))}">${escapeHtml(person.phone)}</a>` : ""}${socials.map(link => `<a class="contact-chip" href="${escapeHtml(safeHref(link.url))}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`).join("")}`; return `<article class="card task-card person-card"><div class="person-card-top"><div class="person-card-avatar">${escapeHtml(initials(person.name))}</div><div class="person-card-copy"><h2>${escapeHtml(person.name)}</h2><p>${escapeHtml([person.role, person.organization].filter(Boolean).join(" · ") || "No organization")}</p></div><span class="badge ${linked.length ? "active" : "closed"}">${linked.length} ${linked.length === 1 ? "thread" : "threads"}</span></div><div class="person-contact-list">${contactChips || `<span class="muted-chip">No contact details yet</span>`}</div><div class="mapped-thread"><span>Linked threads</span><strong>${linked.length ? escapeHtml(linked.slice(0,3).map(threadOptionLabel).join(" · ")) : "No linked threads"}</strong>${linked[0] ? `<button class="button secondary small" data-action="open-person-thread" data-id="${escapeHtml(linked[0].id)}" type="button">Open first thread</button>` : ""}</div><div class="card-icon-actions"><button class="icon-action" data-action="edit-person" data-id="${person.id}" type="button" aria-label="Edit person" title="Edit person">✎</button><button class="icon-action danger" data-action="delete-person" data-id="${person.id}" type="button" aria-label="Delete person" title="Delete person">⌫</button></div></article>`; }).join("")}</div>${pager}` : empty("No matching people", "Adjust the filters on the left to see more people.", "", "", "◎")}</section></div>` : empty("Your network starts here", "Add a person now, or create one while adding a thread.", "add-person", "Add person", "◎"));
}

function renderTasks() {
  selectedOpportunity = null; selectedThread = null;
  const items = [...taskList()].sort((a,b) => (a.done === b.done ? String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")) : a.done ? 1 : -1));
  const filteredItems = items.filter(matchesTaskFilters);
  const needs = items.filter(item => item.kind !== "want").length;
  const wants = items.filter(item => item.kind === "want").length;
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / taskPageSize));
  taskPage = Math.min(Math.max(1, taskPage), totalPages);
  const start = (taskPage - 1) * taskPageSize;
  const pageItems = filteredItems.slice(start, start + taskPageSize);
  const filterPanel = `<aside class="task-filter-panel"><p class="eyebrow">Filters</p><label class="field">Type<select id="taskKindFilter"><option value="all"${taskFilters.kind === "all" ? " selected" : ""}>All</option><option value="need"${taskFilters.kind === "need" ? " selected" : ""}>Needs</option><option value="want"${taskFilters.kind === "want" ? " selected" : ""}>Wants</option></select></label><label class="field">Problem Index<select id="taskSeverityFilter"><option value="all"${taskFilters.severity === "all" ? " selected" : ""}>All</option><option value="critical"${taskFilters.severity === "critical" ? " selected" : ""}>Critical</option><option value="high"${taskFilters.severity === "high" ? " selected" : ""}>High</option><option value="moderate"${taskFilters.severity === "moderate" ? " selected" : ""}>Moderate</option><option value="low"${taskFilters.severity === "low" ? " selected" : ""}>Low</option></select></label><label class="field">Status<select id="taskStatusFilter"><option value="all"${taskFilters.status === "all" ? " selected" : ""}>All</option><option value="open"${taskFilters.status === "open" ? " selected" : ""}>Open</option><option value="done"${taskFilters.status === "done" ? " selected" : ""}>Done</option></select></label><button class="button secondary small" data-action="reset-task-filters" type="button">Reset filters</button></aside>`;
  const pager = filteredItems.length ? `<div class="task-toolbar"><label class="page-size-control">Problem cards per page <select id="taskPageSize" aria-label="Problem cards per page">${taskPageSizeOptions().map(size => `<option value="${size}"${size === taskPageSize ? " selected" : ""}>${size}</option>`).join("")}</select></label><div class="pagination"><button class="button secondary small" data-action="task-prev-page" type="button"${taskPage <= 1 ? " disabled" : ""}>Previous</button><span>Page ${taskPage} of ${totalPages}</span><button class="button secondary small" data-action="task-next-page" type="button"${taskPage >= totalPages ? " disabled" : ""}>Next</button></div></div>` : "";
  main.innerHTML = header("Problem card list", "Problem Cards", "Track unmet needs, unmet wants, and the opportunity threads that can resolve them.", `<button class="button primary" data-action="add-task" type="button">＋ New Problem Card</button>`) +
    `<div class="summary-strip"><div class="stat"><strong>${items.length}</strong><span>Total cards</span></div><div class="stat"><strong>${needs}</strong><span>Needs</span></div><div class="stat"><strong>${wants}</strong><span>Wants</span></div></div>` +
    (items.length ? `<div class="task-view-layout">${filterPanel}<section class="task-results">${pager}${filteredItems.length ? `<div class="card-list task-list">${pageItems.map(item => { const luck = luckValue(item); const percent = ((luck + 5) / 10) * 100; const problem = problemIndex(item); const mappedThread = thread(item.threadId); return `<article class="card task-card ${item.done ? "task-done" : ""}"><div class="task-card-top"><div class="task-card-icon">${escapeHtml(taskIcon(item))}</div><div class="task-card-badges"><span class="problem-score ${escapeHtml(problemIndexClass(problem))}"><small>Problem Index</small><strong>${escapeHtml(problem)}/45</strong></span><span class="badge ${item.kind === "want" ? "paused" : "active"}">${escapeHtml(taskKindLabel(item.kind))}</span></div></div><div><h2>${escapeHtml(item.title)}</h2>${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}</div><div class="mapped-thread"><span>Mapped thread</span><strong>${escapeHtml(taskThreadLabel(item))}</strong>${mappedThread ? `<button class="button secondary small" data-action="open-task-thread" data-id="${escapeHtml(mappedThread.id)}" type="button">Open thread</button>` : ""}</div><div class="task-priority-row"><span class="task-priority importance-${escapeHtml(taskPriorityValue(item.importance))}">Importance: ${escapeHtml(taskPriorityLabel(item.importance))}</span><span class="task-priority urgency-${escapeHtml(taskPriorityValue(item.urgency))}">Urgency: ${escapeHtml(taskPriorityLabel(item.urgency))}</span></div><div class="problem-index ${escapeHtml(problemIndexClass(problem))}"><span>Problem Index</span><strong>${escapeHtml(problem)}/45</strong><em>${escapeHtml(problemIndexLabel(problem))}</em><small>G ${escapeHtml(taskGapValue(item))} × I ${escapeHtml(taskPriorityScore(item.importance))} × U ${escapeHtml(taskPriorityScore(item.urgency))}</small></div><div class="luck-row"><div><strong>${escapeHtml(luckLabel(luck))}</strong><span>${luck > 0 ? "+" : ""}${luck}</span></div><div class="luck-meter" aria-label="Luck meter"><span class="luck-zero"></span><span class="luck-fill ${luck < 0 ? "negative" : "positive"}" style="${luck < 0 ? `left:${percent}%;width:${50 - percent}%` : `left:50%;width:${percent - 50}%`}"></span></div></div><div class="card-icon-actions"><button class="icon-action" data-action="toggle-task-done" data-id="${item.id}" type="button" aria-label="${item.done ? "Reopen" : "Mark done"}" title="${item.done ? "Reopen" : "Mark done"}">${item.done ? "↺" : "✓"}</button><button class="icon-action" data-action="edit-task" data-id="${item.id}" type="button" aria-label="Edit" title="Edit">✎</button><button class="icon-action danger" data-action="delete-task" data-id="${item.id}" type="button" aria-label="Delete" title="Delete">⌫</button></div></article>`; }).join("")}</div>${pager}` : empty("No matching problem cards", "Adjust the filters on the left to see more cards.", "", "", "◇")}</section></div>` : empty("No problem cards yet", "Add an unmet need or want, then map it to the opportunity thread that could resolve it.", "add-task", "Add problem card", "✓"));
}

function renderSettings() {
  main.innerHTML = `<button class="back" data-action="back-opportunities" type="button">← Opportunities</button>` + header("App controls", "Settings", "Backup, restore, and privacy controls for your local CRM.") +
    `<div class="note-box">A backup contains every opportunity, contact, thread, update and follow-up. Save the file somewhere outside Chrome so you can restore it later.</div><div class="settings-list"><article class="card"><h2>Problem card reference</h2><p>Use this as the mental model for why a problem card matters.</p><div class="problem-flow" aria-label="Needs and wants become problems when unmet"><div><strong>Need</strong><span>Something required</span></div><div><strong>Want</strong><span>Something desired</span></div><b>Unmet</b><div class="problem-node"><strong>Problem</strong><span>Gap × Importance × Urgency</span></div><div><strong>Opportunity Thread</strong><span>The mapped path to resolve it</span></div></div></article><article class="card"><h2>Download complete backup</h2><p>Save your entire CRM as one JSON file.</p><button class="button primary" data-action="backup" type="button">Download backup</button></article><article class="card"><h2>Restore from backup</h2><p>Choose a backup made by Opportunity Hunter. Restore replaces the CRM currently on this device.</p><button class="button secondary" data-action="restore" type="button">Choose backup file</button></article></div><div class="divider"></div><p class="field-hint">This extension has no account, server connection, or cloud sync. Keep a copy of your backup in a safe place.</p>`;
}

function field(label, name, value = "", opts = {}) { const required = opts.required ? " required" : ""; const hint = opts.hint ? `<span class="field-hint">${opts.hint}</span>` : ""; const rangeAttrs = `${opts.min !== undefined ? ` min="${escapeHtml(opts.min)}"` : ""}${opts.max !== undefined ? ` max="${escapeHtml(opts.max)}"` : ""}`; const control = opts.type === "textarea" ? `<textarea name="${name}"${required} placeholder="${escapeHtml(opts.placeholder || "")}">${escapeHtml(value)}</textarea>` : opts.type === "select" ? `<select name="${name}"${required}>${opts.options.map(([v,l]) => `<option value="${escapeHtml(v)}"${v === value ? " selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select>` : `<input name="${name}" type="${opts.type || "text"}" value="${escapeHtml(value)}"${required} placeholder="${escapeHtml(opts.placeholder || "")}"${rangeAttrs} ${opts.maxlength ? `maxlength="${opts.maxlength}"` : ""}>`; return `<label class="field">${label}${control}${hint}</label>`; }

function openDialog(mode, id = null) {
  dialogMode = mode; dialogId = id;
  pastedImages = [];
  const opp = mode.includes("opportunity") && id ? opportunity(id) : null;
  const person = mode.includes("person") && id ? contact(id) : null;
  const item = mode.includes("thread") && id ? thread(id) : null;
  const task = mode.includes("task") && id ? taskList().find(item => item.id === id) : null;
  const titles = { "add-category": ["New category", "Add a category"], "add-opportunity": ["New opportunity", "What could happen?"], "edit-opportunity": ["Opportunity", "Edit opportunity"], "add-person": ["New contact", "Add a person"], "edit-person": ["Contact", "Edit person"], "add-thread": ["New path", "Add a thread"], "edit-thread": ["Thread", "Edit thread"], "add-entry": ["Thread update", "Capture what happened"], "add-task": ["New problem card", "Add a problem card"], "edit-task": ["Problem card", "Edit problem card"] };
  document.getElementById("dialogEyebrow").textContent = titles[mode][0];
  document.getElementById("dialogTitle").textContent = titles[mode][1];
  let html = "";
  if (mode === "add-category") html = field("Category name", "categoryName", "", { required:true, maxlength:80, placeholder:"e.g. Habits" });
  if (mode.includes("opportunity")) { const categories = categoryNames().filter(name => name !== "Uncategorized").sort((a,b) => a.localeCompare(b)); const categoryValue = opp?.category || opportunityCategoryPreset || ""; const hasCategory = categories.some(name => name.toLowerCase() === categoryValue.toLowerCase()); const useNewCategory = !!categoryValue && !hasCategory; html = field("Opportunity name", "title", opp?.title, { required:true, maxlength:120, placeholder:"e.g. Partner with Northstar" }) + field("What is the opportunity?", "summary", opp?.summary, { type:"textarea", placeholder:"A short description of the possibility" }) + `<label class="field">Category<select name="categorySelect" id="categorySelect"><option value="">Uncategorized</option>${categories.map(name => `<option value="${escapeHtml(name)}"${!useNewCategory && name.toLowerCase() === categoryValue.toLowerCase() ? " selected" : ""}>${escapeHtml(name)}</option>`).join("")}<option value="__new__"${useNewCategory || !categories.length ? " selected" : ""}>＋ Add new category</option></select><span class="field-hint">Choose an existing category or add a new one below.</span></label><label id="newCategoryField" class="field ${useNewCategory || !categories.length ? "" : "hidden"}">New category<input name="newCategory" type="text" value="${escapeHtml(useNewCategory ? categoryValue : "")}" maxlength="80" placeholder="e.g. Habits"><span class="field-hint">This category will be created when you save this opportunity.</span></label>` + field("Status", "status", opp?.status || "active", { type:"select", options:[["active","Active"],["paused","Paused"],["closed","Closed"]] }); }
  if (mode.includes("person")) html = field("Name", "name", person?.name, { required:true, maxlength:120 }) + field("Organization", "organization", person?.organization, { maxlength:120 }) + field("Role", "role", person?.role, { maxlength:120 }) + field("Email or other contact detail", "email", person?.email, { maxlength:200 }) + field("Phone number", "phone", person?.phone, { type:"tel", maxlength:40, placeholder:"+1 555 123 4567" }) + field("Social media links", "socialLinks", person?.socialLinks, { type:"textarea", placeholder:"LinkedIn | https://linkedin.com/in/name\nInstagram | https://instagram.com/name", hint:"Add one link per line. Use Label | link if you want a custom name." });
  if (mode.includes("task")) { const kind = task?.kind === "want" ? "want" : "need"; const icon = taskIcon(task); const threadOptions = [["","No thread mapped"], ...data.threads.map(item => [item.id, threadOptionLabel(item)])]; html = field("Problem card", "title", task?.title, { required:true, maxlength:160, placeholder:"e.g. Renew certification" }) + `<fieldset class="field toggle-field"><legend>Need or want</legend><div class="kind-toggle"><label><input name="kind" type="radio" value="need"${kind === "need" ? " checked" : ""}><span>Need</span></label><label><input name="kind" type="radio" value="want"${kind === "want" ? " checked" : ""}><span>Want</span></label></div></fieldset>` + field("Map to opportunity thread", "threadId", task?.threadId || "", { type:"select", options:threadOptions }) + `<fieldset class="field icon-picker-field"><legend>Card icon</legend><div class="task-icon-picker">${taskIconOptions.map(option => `<label><input name="icon" type="radio" value="${escapeHtml(option)}"${option === icon ? " checked" : ""}><span>${escapeHtml(option)}</span></label>`).join("")}</div></fieldset><label class="field gap-field">Gap<input name="gap" type="range" min="1" max="5" value="${escapeHtml(taskGapValue(task))}" list="gapTicks"><datalist id="gapTicks">${gapScale.map(([number]) => `<option value="${escapeHtml(number)}"></option>`).join("")}</datalist>${gapScaleMarkup()}<span class="field-hint">Gap between actual and desired state. 1 is small. 5 is wide.</span></label>` + field("Importance", "importance", taskPriorityValue(task?.importance), { type:"select", options:taskPriorityOptions }) + field("Urgency", "urgency", taskPriorityValue(task?.urgency), { type:"select", options:taskPriorityOptions }) + `<label class="field luck-field">Luck meter<input name="luck" type="range" min="-5" max="5" value="${escapeHtml(luckValue(task))}" list="luckTicks"><datalist id="luckTicks">${luckScale.map(([number]) => `<option value="${escapeHtml(number.replace("+",""))}"></option>`).join("")}</datalist>${luckScaleMarkup()}<span class="field-hint">Choose from catastrophe at -5 to serendipitous at +5.</span></label>` + field("Notes", "notes", task?.notes, { type:"textarea", placeholder:"Why this problem matters, what could go right, or what could go wrong." }); }
  if (mode.includes("thread")) { const options = [["","No SPOC yet"], ...data.contacts.map(p => [p.id, `${p.name}${p.organization ? ` · ${p.organization}` : ""}`]), ["__new__","＋ Add new person"]]; html = field("Thread name", "title", item?.title, { required:true, maxlength:120, placeholder:"e.g. Introduction to decision maker" }) + field("Person / SPOC (optional)", "contactId", item?.contactId || "", { type:"select", options }) + `<div id="newPersonField" class="hidden">${field("New person's name", "newPersonName", "", { maxlength:120, placeholder:"Full name" })}</div>` + field("Opportunity outcome", "outcomeStatus", threadOutcome(item), { type:"select", options:threadOutcomeOptions }) + field("How could this thread move the opportunity forward?", "purpose", item?.purpose, { type:"textarea", placeholder:"Possible approach, contribution, or next step" }) + field("Thread description", "description", item?.description, { type:"textarea", placeholder:"Context, background, constraints, or anything useful to remember." }) + field("Links", "links", threadLinks(item).map(link => `${link.label && link.label !== link.url ? `${link.label} | ` : ""}${link.url}`).join("\n"), { type:"textarea", placeholder:"One per line. Use Label | https://example.com if you want a custom label.", hint:"Links are stored locally with the thread and included in backups." }) + `<label class="field">Images<input name="images" type="file" accept="image/*" multiple><span class="field-hint">${threadImages(item).length ? `${threadImages(item).length} saved image${threadImages(item).length === 1 ? "" : "s"}. New selections are added to the thread.` : "Optional. Images are saved inside your local CRM backup."}</span></label><label class="field">Paste images<div id="pasteTarget" class="paste-target" tabindex="0"><div id="pastedImagePreview" class="paste-preview"><span>Paste copied images here.</span></div></div><span class="field-hint">Click the box and press Paste. Pasted images are saved with uploaded images.</span></label>` + field("Next follow-up date", "nextDate", item?.nextDate, { type:"date", hint:"Optional. It will appear in Follow-ups." }) + field("Workflow", "status", item?.status || "open", { type:"select", options:[["open","Open"],["done","Done"]] }); }
  if (mode === "add-entry") html = field("Update type", "type", "conversation", { type:"select", options:updateTypeOptions }) + field("What happened?", "text", "", { type:"textarea", required:true, placeholder:"Capture the useful detail, agreement, or next action." });
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
  if (dialogMode === "add-category" && !trimmed("categoryName")) { toast("Enter the category name."); return; }
  if (dialogMode.includes("thread") && values.contactId === "__new__" && !trimmed("newPersonName")) { toast("Enter the new person's name."); return; }
  if (dialogMode.includes("opportunity") && values.categorySelect === "__new__" && !trimmed("newCategory")) { toast("Enter the new category name."); return; }
  let addedImages = [];
  try { if (dialogMode.includes("thread")) addedImages = [...await readImages(formData.getAll("images")), ...pastedImages]; }
  catch (error) { toast(error.message); return; }
  const mode = dialogMode, id = dialogId, stamp = now();
  const saved = await change(next => {
    if (mode === "add-category") { next.categories = Array.isArray(next.categories) ? next.categories : []; const category = normalizedCategory(trimmed("categoryName")); if (category && !categoryNames(next).some(name => name.toLowerCase() === category.toLowerCase())) next.categories.push(category); expandedFolders.add(category || "Uncategorized"); view = "opportunities"; }
    if (mode === "add-opportunity") { const category = categoryFromValues(values, trimmed); const opp = { id:uid(), title:trimmed("title"), summary:trimmed("summary"), category, status:values.status, createdAt:stamp, updatedAt:stamp }; next.opportunities.push(opp); expandedFolders.add(category || "Uncategorized"); opportunityCategoryPreset = ""; selectedOpportunity = opp.id; selectedThread = null; view = "opportunities"; }
    if (mode === "edit-opportunity") { const opp = next.opportunities.find(x => x.id === id); const category = categoryFromValues(values, trimmed); Object.assign(opp, { title:trimmed("title"), summary:trimmed("summary"), category, status:values.status, updatedAt:stamp }); expandedFolders.add(category || "Uncategorized"); }
    if (mode === "add-person") next.contacts.push({ id:uid(), name:trimmed("name"), organization:trimmed("organization"), role:trimmed("role"), email:trimmed("email"), phone:trimmed("phone"), socialLinks:trimmed("socialLinks"), createdAt:stamp });
    if (mode === "edit-person") { const person = next.contacts.find(x => x.id === id); Object.assign(person, { name:trimmed("name"), organization:trimmed("organization"), role:trimmed("role"), email:trimmed("email"), phone:trimmed("phone"), socialLinks:trimmed("socialLinks") }); }
    if (mode === "add-task") { next.tasks = Array.isArray(next.tasks) ? next.tasks : []; next.tasks.push({ id:uid(), title:trimmed("title"), notes:trimmed("notes"), kind:values.kind === "want" ? "want" : "need", threadId:values.threadId || null, icon:taskIcon({ icon:values.icon }), gap:taskGapValue({ gap:values.gap }), importance:taskPriorityValue(values.importance), urgency:taskPriorityValue(values.urgency), luck:luckValue({ luck:values.luck }), done:false, createdAt:stamp, updatedAt:stamp }); view = "tasks"; }
    if (mode === "edit-task") { const task = next.tasks.find(x => x.id === id); Object.assign(task, { title:trimmed("title"), notes:trimmed("notes"), kind:values.kind === "want" ? "want" : "need", threadId:values.threadId || null, icon:taskIcon({ icon:values.icon }), gap:taskGapValue({ gap:values.gap }), importance:taskPriorityValue(values.importance), urgency:taskPriorityValue(values.urgency), luck:luckValue({ luck:values.luck }), updatedAt:stamp }); }
    if (mode === "add-thread" || mode === "edit-thread") { let personId = values.contactId || null; if (personId === "__new__") { personId = uid(); next.contacts.push({ id:personId, name:trimmed("newPersonName"), organization:"", role:"", email:"", phone:"", socialLinks:"", createdAt:stamp }); } const existing = mode === "edit-thread" ? next.threads.find(x => x.id === id) : null; const update = { title:trimmed("title"), contactId:personId, outcomeStatus:values.outcomeStatus || "exploring", purpose:trimmed("purpose"), description:trimmed("description"), links:parseLinks(values.links), images:[...threadImages(existing || {}), ...addedImages], nextDate:values.status === "done" ? "" : values.nextDate, status:values.status, updatedAt:stamp }; if (mode === "add-thread") { const newThread = { id:uid(), opportunityId:selectedOpportunity, ...update, createdAt:stamp }; next.threads.push(newThread); selectedThread = newThread.id; } else Object.assign(existing, update); const opp = next.opportunities.find(x => x.id === selectedOpportunity); if (opp) opp.updatedAt = stamp; }
    if (mode === "add-entry") { next.entries.push({ id:uid(), threadId:selectedThread, type:values.type, text:trimmed("text"), createdAt:stamp }); const item = next.threads.find(x => x.id === selectedThread); item.updatedAt = stamp; const opp = next.opportunities.find(x => x.id === item.opportunityId); if (opp) opp.updatedAt = stamp; }
  }, "Saved locally");
  if (saved) dialog.close();
}

async function removeOpportunity() { if (!confirm("Delete this opportunity and all its threads and updates? This cannot be undone unless you have a backup.")) return; const id = selectedOpportunity; await change(next => { const ids = new Set(next.threads.filter(t => t.opportunityId === id).map(t => t.id)); next.opportunities = next.opportunities.filter(x => x.id !== id); next.threads = next.threads.filter(x => x.opportunityId !== id); next.entries = next.entries.filter(x => !ids.has(x.threadId)); selectedOpportunity = null; selectedThread = null; }, "Opportunity deleted"); }
async function removeThread() { if (!confirm("Delete this thread and its updates?")) return; const id = selectedThread; await change(next => { next.threads = next.threads.filter(x => x.id !== id); next.entries = next.entries.filter(x => x.threadId !== id); selectedThread = null; }, "Thread deleted"); }
async function removeEntry(id) { if (!confirm("Delete this update?")) return; await change(next => { next.entries = next.entries.filter(x => x.id !== id); }, "Update deleted"); }
async function removeTask(id) { if (!confirm("Delete this task?")) return; await change(next => { next.tasks = (Array.isArray(next.tasks) ? next.tasks : []).filter(item => item.id !== id); }, "Task deleted"); }
async function removePerson(id) {
  const person = contact(id);
  if (!person) return;
  const linkedCount = linkedThreadsForPerson(id).length;
  const message = linkedCount ? `Delete ${person.name} and unlink them from ${linkedCount} thread${linkedCount === 1 ? "" : "s"}?` : `Delete ${person.name}?`;
  if (!confirm(message)) return;
  await change(next => {
    next.contacts = next.contacts.filter(item => item.id !== id);
    next.threads.forEach(item => { if (item.contactId === id) { item.contactId = null; item.updatedAt = now(); } });
  }, "Person deleted");
}
async function toggleTaskDone(id) { await change(next => { next.tasks = Array.isArray(next.tasks) ? next.tasks : []; const item = next.tasks.find(task => task.id === id); item.done = !item.done; item.updatedAt = now(); }, "Task updated"); }
async function toggleTaskKind(id) { await change(next => { next.tasks = Array.isArray(next.tasks) ? next.tasks : []; const item = next.tasks.find(task => task.id === id); item.kind = item.kind === "want" ? "need" : "want"; item.updatedAt = now(); }, "Task updated"); }
async function addQuickEntry(formElement) {
  const formData = new FormData(formElement);
  const text = String(formData.get("text") || "").trim();
  let attachments = [];
  try { attachments = await readAttachments(formData.getAll("attachments")); }
  catch (error) { toast(error.message); return; }
  if (!text && !attachments.length) { toast("Type an update or add an attachment first."); return; }
  const type = String(formData.get("type") || "conversation");
  const threadId = selectedThread;
  const stamp = now();
  const saved = await change(next => {
    next.entries.push({ id:uid(), threadId, type, text, attachments, createdAt:stamp });
    const item = next.threads.find(x => x.id === threadId);
    item.updatedAt = stamp;
    const opp = next.opportunities.find(x => x.id === item.opportunityId);
    if (opp) opp.updatedAt = stamp;
  }, "Update added");
  if (saved) {
    const box = document.querySelector(".chat-composer textarea");
    box?.focus();
  }
}
async function saveThreadPanel(formElement) {
  const formData = new FormData(formElement);
  const values = Object.fromEntries(formData.entries());
  const trimmed = key => String(values[key] || "").trim();
  const id = selectedThread;
  const stamp = now();
  const saved = await change(next => {
    const existing = next.threads.find(item => item.id === id);
    if (!existing) throw new Error("Thread not found.");
    Object.assign(existing, {
      title:trimmed("title"),
      contactId:values.contactId || null,
      outcomeStatus:values.outcomeStatus || "exploring",
      purpose:trimmed("purpose"),
      description:trimmed("description"),
      links:parseLinks(values.links),
      nextDate:values.status === "done" ? "" : values.nextDate,
      status:values.status,
      updatedAt:stamp
    });
    const opp = next.opportunities.find(item => item.id === existing.opportunityId);
    if (opp) opp.updatedAt = stamp;
  }, "Thread updated");
  if (saved) editPanelOpen = false;
}
function updateAttachmentPreview(formElement) {
  const preview = formElement.querySelector(".attachment-preview");
  if (!preview) return;
  const files = [...formElement.querySelectorAll('input[name="attachments"]')].flatMap(input => [...input.files]);
  preview.innerHTML = files.length ? files.map(file => `<span class="attachment-chip">${escapeHtml(file.name)} <small>${escapeHtml(fileSize(file.size))}</small></span>`).join("") : "";
}
function currentEntry() { return data.entries.find(entry => entry.id === contextEntryId); }
function hideMessageContextMenu() {
  contextEntryId = null;
  document.querySelector(".message-context-menu")?.remove();
}
function showMessageContextMenu(event, entryId) {
  hideMessageContextMenu();
  contextEntryId = entryId;
  const entry = currentEntry();
  if (!entry) return;
  const hasText = !!String(entry.text || "").trim();
  const hasMedia = entryAttachments(entry).length > 0;
  const menu = document.createElement("div");
  menu.className = "message-context-menu";
  menu.innerHTML = `<button data-action="context-copy-text" type="button"${hasText ? "" : " disabled"}><span>≡</span>Copy text</button><button data-action="context-copy-link" type="button"><span>🔗</span>Copy message link</button><button data-action="context-copy-media" type="button"${hasMedia ? "" : " disabled"}><span>▧</span>Copy media</button><button data-action="context-save-as" type="button"${hasMedia ? "" : " disabled"}><span>⇩</span>Save as</button><hr><button class="danger-zone" data-action="context-delete" type="button"><span>×</span>Delete</button>`;
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.min(event.clientX, window.innerWidth - rect.width - 10);
  const top = Math.min(event.clientY, window.innerHeight - rect.height - 10);
  menu.style.left = `${Math.max(10, left)}px`;
  menu.style.top = `${Math.max(10, top)}px`;
}
async function copyText(value, success) {
  try { await navigator.clipboard.writeText(value); toast(success); }
  catch { toast("Could not copy to clipboard."); }
}
function downloadAttachment(file) {
  const link = document.createElement("a");
  link.href = file.dataUrl;
  link.download = file.name || "attachment";
  document.body.append(link);
  link.click();
  link.remove();
}
async function handleContextAction(action) {
  const entry = currentEntry();
  if (!entry) return;
  const attachments = entryAttachments(entry);
  if (action === "context-copy-text") await copyText(entry.text || "", "Text copied");
  if (action === "context-copy-link") await copyText(`${location.origin}${location.pathname}${location.search}${routeThread(entry.threadId)}&message=${encodeURIComponent(entry.id)}`, "Message link copied");
  if (action === "context-copy-media") {
    const first = attachments[0];
    if (!first) toast("No media on this message.");
    else await copyText(first.dataUrl, "Media data copied");
  }
  if (action === "context-save-as") {
    if (!attachments.length) toast("No attachments to save.");
    else attachments.forEach(downloadAttachment);
  }
  if (action === "context-delete") await removeEntry(entry.id);
  hideMessageContextMenu();
}

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
  if (!Array.isArray(candidate.categories)) candidate.categories = [];
  if (!Array.isArray(candidate.tasks)) candidate.tasks = [];
  for (const name of ["opportunities","contacts","threads","entries","tasks"]) if (!Array.isArray(candidate[name])) throw new Error(`Backup is missing ${name}.`);
  const ids = new Set();
  for (const name of ["opportunities","contacts","threads","entries","tasks"]) for (const item of candidate[name]) { if (!item || typeof item.id !== "string" || ids.has(item.id)) throw new Error("Backup contains an invalid or duplicate record ID."); ids.add(item.id); }
  const oppIds = new Set(candidate.opportunities.map(x => x.id)), personIds = new Set(candidate.contacts.map(x => x.id)), threadIds = new Set(candidate.threads.map(x => x.id));
  for (const item of candidate.opportunities) if (typeof item.title !== "string" || (item.category !== undefined && typeof item.category !== "string")) throw new Error("Backup contains an invalid opportunity.");
  for (const item of candidate.categories) if (typeof item !== "string") throw new Error("Backup contains an invalid category.");
  for (const item of candidate.contacts) if (typeof item.name !== "string") throw new Error("Backup contains an invalid contact.");
  for (const item of candidate.threads) {
    if (!oppIds.has(item.opportunityId) || (item.contactId != null && item.contactId !== "" && !personIds.has(item.contactId)) || typeof item.title !== "string") throw new Error("Backup contains a broken thread link.");
    if (item.description !== undefined && typeof item.description !== "string") throw new Error("Backup contains an invalid thread description.");
    if (item.links !== undefined && (!Array.isArray(item.links) || item.links.some(link => !link || typeof link.url !== "string"))) throw new Error("Backup contains an invalid thread link.");
    if (item.images !== undefined && (!Array.isArray(item.images) || item.images.some(image => !image || typeof image.dataUrl !== "string" || !image.dataUrl.startsWith("data:image/")))) throw new Error("Backup contains an invalid thread image.");
  }
  for (const item of candidate.entries) {
    if (!threadIds.has(item.threadId) || typeof item.text !== "string") throw new Error("Backup contains a broken update link.");
    if (item.attachments !== undefined && (!Array.isArray(item.attachments) || item.attachments.some(file => !file || typeof file.dataUrl !== "string" || typeof file.name !== "string"))) throw new Error("Backup contains an invalid update attachment.");
  }
  for (const item of candidate.tasks) if (typeof item.title !== "string") throw new Error("Backup contains an invalid task.");
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
document.getElementById("nextStepsButton").addEventListener("click", () => { view = "nextsteps"; selectedOpportunity = null; selectedThread = null; render(); });
document.getElementById("settingsButton").addEventListener("click", () => { view = "settings"; render(); });
document.getElementById("closeDialog").addEventListener("click", () => dialog.close());
document.getElementById("cancelDialog").addEventListener("click", () => dialog.close());
form.addEventListener("submit", saveForm);
form.addEventListener("change", event => {
  if (event.target.name === "contactId") { const el = document.getElementById("newPersonField"); el.classList.toggle("hidden", event.target.value !== "__new__"); el.querySelector("input").required = event.target.value === "__new__"; }
  if (event.target.name === "categorySelect") { const el = document.getElementById("newCategoryField"); el.classList.toggle("hidden", event.target.value !== "__new__"); el.querySelector("input").required = event.target.value === "__new__"; if (event.target.value === "__new__") el.querySelector("input").focus(); }
});
form.addEventListener("paste", event => { if (!dialogMode?.includes("thread")) return; const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean); if (files.length) { event.preventDefault(); addClipboardImages(files); } });
restoreInput.addEventListener("change", () => { if (restoreInput.files[0]) restoreBackup(restoreInput.files[0]); });
main.addEventListener("input", event => {
  if (event.target.id === "search") { searchTerm = event.target.value.toLowerCase().trim(); const pos = event.target.selectionStart; render(); const input = document.getElementById("search"); input?.focus(); input?.setSelectionRange(pos,pos); }
  if (event.target.id === "peopleSearchFilter") { peopleFilters.search = event.target.value; const pos = event.target.selectionStart; peoplePage = 1; render(); const input = document.getElementById("peopleSearchFilter"); input?.focus(); input?.setSelectionRange(pos,pos); }
});
main.addEventListener("change", event => {
  if (event.target.matches('input[name="attachments"]')) updateAttachmentPreview(event.target.form);
  if (event.target.id === "taskPageSize") { taskPageSize = Number(event.target.value) || 12; taskPage = 1; localStorage.setItem("omsTaskPageSize", taskPageSize); render(); }
  if (event.target.id === "taskKindFilter") { taskFilters.kind = event.target.value; taskPage = 1; render(); }
  if (event.target.id === "taskSeverityFilter") { taskFilters.severity = event.target.value; taskPage = 1; render(); }
  if (event.target.id === "taskStatusFilter") { taskFilters.status = event.target.value; taskPage = 1; render(); }
  if (event.target.id === "peoplePageSize") { peoplePageSize = Number(event.target.value) || 12; peoplePage = 1; localStorage.setItem("omsPeoplePageSize", peoplePageSize); render(); }
  if (event.target.id === "peopleLinkFilter") { peopleFilters.link = event.target.value; peoplePage = 1; render(); }
  if (event.target.id === "peopleContactFilter") { peopleFilters.contact = event.target.value; peoplePage = 1; render(); }
});
main.addEventListener("contextmenu", event => { const bubble = event.target.closest(".chat-bubble[data-entry-id]"); if (!bubble) return; event.preventDefault(); showMessageContextMenu(event, bubble.dataset.entryId); });
document.addEventListener("keydown", event => { if (event.key === "Escape") hideMessageContextMenu(); });
document.addEventListener("click", async event => {
  const actionTarget = event.target.closest(".message-context-menu [data-action]");
  if (actionTarget) { await handleContextAction(actionTarget.dataset.action); return; }
  if (!event.target.closest(".message-context-menu")) hideMessageContextMenu();
});
main.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === " ") && event.target.matches('[role="button"][data-action]')) { event.preventDefault(); event.target.click(); } });
main.addEventListener("submit", async event => {
  if (!event.target.matches('[data-action="quick-entry"],[data-action="save-thread-panel"]')) return;
  event.preventDefault();
  if (event.target.matches('[data-action="quick-entry"]')) await addQuickEntry(event.target);
  if (event.target.matches('[data-action="save-thread-panel"]')) await saveThreadPanel(event.target);
});
main.addEventListener("click", async event => {
  const target = event.target.closest("[data-action]"); if (!target) return;
  const action = target.dataset.action, id = target.dataset.id;
  if (action.startsWith("context-")) { await handleContextAction(action); return; }
  hideMessageContextMenu();
  if (action === "add-opportunity-to-category") { opportunityCategoryPreset = target.dataset.category || ""; openDialog("add-opportunity"); return; }
  if (["add-category","add-opportunity","edit-opportunity","add-person","edit-person","add-thread","add-entry","add-task","edit-task"].includes(action)) { if (action === "add-opportunity") opportunityCategoryPreset = ""; openDialog(action, action === "edit-opportunity" ? selectedOpportunity : id); return; }
  if (action === "add-thread-to-opportunity") { editPanelOpen = false; selectedOpportunity = id; selectedThread = null; openDialog("add-thread"); return; }
  if (action === "edit-thread") { editPanelOpen = !editPanelOpen; render(); return; }
  if (action === "close-thread-editor") { editPanelOpen = false; render(); return; }
  if (action === "toggle-sidebar") { sidebarCollapsed = !sidebarCollapsed; localStorage.setItem("omsSidebarCollapsed", sidebarCollapsed); render(); return; }
  if (action === "reset-task-filters") { taskFilters = { kind:"all", severity:"all", status:"open" }; taskPage = 1; render(); return; }
  if (action === "reset-people-filters") { peopleFilters = { search:"", link:"all", contact:"all" }; peoplePage = 1; render(); return; }
  if (action === "open-task-thread") { const item = thread(id); if (!item) return; editPanelOpen = false; selectedOpportunity = item.opportunityId; selectedThread = item.id; view = "opportunities"; render(); return; }
  if (action === "open-person-thread") { const item = thread(id); if (!item) return; editPanelOpen = false; selectedOpportunity = item.opportunityId; selectedThread = item.id; view = "opportunities"; render(); return; }
  if (action === "toggle-attachment-menu") { target.closest(".attachment-picker")?.classList.toggle("open"); return; }
  if (action === "choose-attachment") { const picker = target.closest(".attachment-picker"); picker?.classList.remove("open"); picker?.querySelector(`[data-attachment-input="${target.dataset.kind}"]`)?.click(); return; }
  if (action === "open-opportunity") { editPanelOpen = false; selectedOpportunity = id; selectedThread = null; render(); }
  if (action === "toggle-category") { const category = target.dataset.category; if (expandedFolders.has(category)) expandedFolders.delete(category); else expandedFolders.add(category); renderOpportunities(); }
  if (action === "open-thread-from-tree") { const item = thread(id); editPanelOpen = false; selectedOpportunity = item.opportunityId; selectedThread = id; render(); }
  if (action === "open-thread") { editPanelOpen = false; selectedThread = id; render(); }
  if (action === "open-followup") { const item = thread(id); editPanelOpen = false; selectedOpportunity = item.opportunityId; selectedThread = id; view = "opportunities"; render(); }
  if (action === "open-next-step-thread") { const item = thread(id); editPanelOpen = false; selectedOpportunity = item.opportunityId; selectedThread = id; view = "opportunities"; render(); }
  if (action === "back-opportunities") { editPanelOpen = false; view = "opportunities"; selectedOpportunity = null; selectedThread = null; render(); }
  if (action === "back-opportunity") { editPanelOpen = false; selectedThread = null; render(); }
  if (action === "delete-opportunity") await removeOpportunity();
  if (action === "delete-thread") await removeThread();
  if (action === "delete-entry") await removeEntry(id);
  if (action === "delete-task") await removeTask(id);
  if (action === "delete-person") await removePerson(id);
  if (action === "toggle-task-done") await toggleTaskDone(id);
  if (action === "toggle-task-kind") await toggleTaskKind(id);
  if (action === "task-prev-page") { taskPage = Math.max(1, taskPage - 1); render(); }
  if (action === "task-next-page") { taskPage += 1; render(); }
  if (action === "people-prev-page") { peoplePage = Math.max(1, peoplePage - 1); render(); }
  if (action === "people-next-page") { peoplePage += 1; render(); }
  if (action === "complete-followup") await change(next => { const item = next.threads.find(x => x.id === id); item.nextDate = ""; item.updatedAt = now(); }, "Follow-up completed");
  if (action === "backup") downloadBackup();
  if (action === "restore") restoreInput.click();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]?.newValue) return;
  try { data = validateBackup({ format:FORMAT, schemaVersion:1, data:changes[STORAGE_KEY].newValue }); applyRouteFromUrl(); render(); }
  catch (error) { console.error("Ignoring invalid storage update", error); }
});
window.addEventListener("hashchange", () => {
  selectedOpportunity = null;
  selectedThread = null;
  applyRouteFromUrl();
  render();
});

(async () => {
  try { const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]; if (stored) data = validateBackup({ format:FORMAT, schemaVersion:1, data:stored }); applyRouteFromUrl(); render(); }
  catch (error) { console.error(error); main.innerHTML = empty("Could not load CRM", "The local data could not be read. Please check Chrome storage before making changes.", "", "", "!"); }
})();
