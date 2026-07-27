/* Angel Cloud docs — client-side viewer.
 * Renders the repo's own markdown; adds GitHub-compatible heading anchors and
 * rewrites in-doc / cross-doc links so deep links keep working under hash
 * routing. Agents never run this — they fetch the raw .md / .txt directly. */
'use strict';

const DOCS = {
  'user-manual':        { file: 'user-manual.md',        title: 'User manual' },
  'faq':                { file: 'faq.md',                 title: 'FAQ' },
  'operator-journey':   { file: 'operator-journey.md',    title: 'Operator journey' },
  'domain-architecture':{ file: 'domain-architecture.md', title: 'Domain architecture' },
  'skill':              { file: 'SKILL.md',               title: 'Agent journey (SKILL.md)' },
};
// Source filenames that may appear in cross-links → their route slug.
const FILE_TO_SLUG = {
  'user-manual.md': 'user-manual',
  'faq.md': 'faq',
  'domain-architecture.md': 'domain-architecture',
  'google-read-proof-manual-journey.md': 'operator-journey',
  'operator-journey.md': 'operator-journey',
  'skill.md': 'skill',
};

const home = document.getElementById('home');
const docEl = document.getElementById('doc');
const errEl = document.getElementById('doc-error');

// GitHub-style heading slug: lowercase, drop punctuation (keep spaces/hyphens),
// spaces → hyphens. Deliberately does NOT collapse repeated hyphens, matching
// GitHub (e.g. "Outcome — 2026" → "outcome--2026").
function slugify(text, seen) {
  let s = text.trim().toLowerCase()
    .replace(/[^\w\- ]+/g, '')  // strip punctuation, keep word chars, hyphen, space
    .replace(/ /g, '-');
  let base = s, n = 0;
  while (seen.has(s)) { n += 1; s = `${base}-${n}`; }
  seen.add(s);
  return s;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');   // "user-manual/the-model"
  if (!raw) return { slug: null, anchor: null };
  const [slug, ...rest] = raw.split('/');
  return { slug, anchor: rest.join('/') || null };
}

function setActiveNav(slug) {
  document.querySelectorAll('#sidebar a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    a.classList.toggle('active', href === `#/${slug}`);
  });
}

function rewriteLinks(root, slug) {
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href) return;
    if (href.startsWith('#')) {                       // in-doc anchor
      a.setAttribute('href', `#/${slug}/${href.slice(1)}`);
      return;
    }
    if (/^https?:\/\//i.test(href)) {                 // absolute URL
      // A doc link written absolutely (e.g. https://docs.angelmcp.ai/faq.md#x)
      // keeps its full form in the raw .md/.txt for agents, but the SPA routes
      // it by basename so the anchor still works — any host, on- or off-canonical.
      try {
        const u = new URL(href);
        const target = FILE_TO_SLUG[(u.pathname.split('/').pop() || '').toLowerCase()];
        if (target) {
          a.setAttribute('href', `#/${target}${u.hash ? '/' + u.hash.slice(1) : ''}`);
          return;
        }
      } catch (e) { /* fall through to external */ }
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
      return;
    }
    const m = href.match(/^([^#]+)(?:#(.*))?$/);       // relative cross-doc .md link
    if (m) {
      const target = FILE_TO_SLUG[m[1].toLowerCase()];
      if (target) a.setAttribute('href', `#/${target}${m[2] ? '/' + m[2] : ''}`);
    }
  });
}

function decorateHeadings(root, slug) {
  const seen = new Set();
  root.querySelectorAll('h1, h2, h3, h4').forEach((h) => {
    h.id = slugify(h.textContent, seen);
    const a = document.createElement('a');
    a.className = 'hanchor';
    a.href = `#/${slug}/${h.id}`;
    a.textContent = '#';
    a.setAttribute('aria-label', 'Link to this section');
    h.appendChild(a);
  });
}

async function renderMermaid(root) {
  const blocks = root.querySelectorAll('code.language-mermaid');
  if (!blocks.length) return;
  // Wait for the mermaid CDN module, but never block forever: if it fails to
  // load, give up after a short timeout so rendering/scroll still proceeds
  // (the diagram source stays visible as a code block).
  const ready = await new Promise((res) => {
    if (window.__mermaid) return res(true);
    const t = setTimeout(() => res(false), 3000);
    window.addEventListener('mermaid-ready', () => { clearTimeout(t); res(true); }, { once: true });
  });
  if (!ready || !window.__mermaid) return;
  blocks.forEach((code) => {
    const pre = code.closest('pre');
    const holder = document.createElement('pre');
    holder.className = 'mermaid';
    holder.textContent = code.textContent;
    pre.replaceWith(holder);
  });
  try {
    window.__mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
    await window.__mermaid.run({ nodes: root.querySelectorAll('pre.mermaid') });
  } catch (e) { /* leave source visible on failure */ }
}

function scrollToAnchor(anchor) {
  if (!anchor) { window.scrollTo(0, 0); return; }
  const el = document.getElementById(anchor);
  if (el) el.scrollIntoView({ block: 'start' });
}

const cache = new Map();
let navSeq = 0;   // bumped on every route(); a load whose seq is stale must not paint
async function loadDoc(slug, anchor, seq) {
  const meta = DOCS[slug];
  if (!meta) { showError(`Unknown doc: ${slug}`); return; }
  home.hidden = true; errEl.hidden = true; docEl.hidden = false;
  document.title = `${meta.title} — Angel Cloud docs`;
  setActiveNav(slug);

  let md = cache.get(slug);
  if (md == null) {
    try {
      const res = await fetch(meta.file, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${res.status}`);
      md = await res.text();
      cache.set(slug, md);
    } catch (e) {
      if (seq === navSeq) showError(`Could not load ${meta.file} (${e.message}).`);
      return;
    }
  }
  if (seq !== navSeq) return;   // a newer navigation won while we were fetching
  // Strip YAML frontmatter for the human view (the raw /SKILL.md keeps it for agents).
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  docEl.innerHTML = window.marked.parse(body, { gfm: true, breaks: false });
  decorateHeadings(docEl, slug);
  rewriteLinks(docEl, slug);
  await renderMermaid(docEl);
  if (seq !== navSeq) return;   // a newer navigation won during mermaid render
  scrollToAnchor(anchor);
}

function showError(msg) {
  home.hidden = true; docEl.hidden = true; errEl.hidden = false;
  errEl.textContent = msg;
}

function route() {
  const seq = ++navSeq;
  const { slug, anchor } = parseHash();
  if (!slug) {
    home.hidden = false; docEl.hidden = true; errEl.hidden = true;
    document.title = 'Angel Cloud docs';
    setActiveNav(null);
    window.scrollTo(0, 0);
    return;
  }
  loadDoc(slug, anchor, seq);
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
route();

/* Theme toggle: auto → light → dark → auto */
const root = document.documentElement;
document.getElementById('theme-toggle').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const cur = root.getAttribute('data-theme') || 'auto';
  root.setAttribute('data-theme', order[(order.indexOf(cur) + 1) % order.length]);
});
