import type { SafePortfolioData } from "./portfolio-anonymize";
import { sanitizeRichText, stripRichText } from "./rich-text";
import { normalizePortfolioLink } from "./portfolio-links";
import { isPortfolioTemplate, type PortfolioTemplateId } from "./portfolio-templates";
import { portfolioTemplateCss } from "./portfolio-template-styles";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function field(item: Record<string, unknown>, key: string): string {
  return typeof item[key] === "string" ? (item[key] as string).trim() : "";
}

function entryBody(item: Record<string, unknown>): string {
  const subItems = Array.isArray(item.subItems) ? item.subItems : [];
  const extra = subItems.filter((sub) => sub && typeof sub === "object").map((sub) => {
    const record = sub as Record<string, unknown>;
    return `<p>${escapeHtml(field(record, "label"))}${field(record, "label") ? " · " : ""}${escapeHtml(field(record, "value"))}</p>`;
  }).join("");
  const descriptions = Array.isArray(item.descriptionItems)
    ? item.descriptionItems.filter((text): text is string => typeof text === "string" && !!text.trim()) : [];
  const list = item.descriptionStyle === "ordered" ? "ol" : "ul";
  return extra + (descriptions.length
    ? `<${list}>${descriptions.map((text) => `<li>${sanitizeRichText(text)}</li>`).join("")}</${list}>`
    : field(item, "description") ? `<p>${sanitizeRichText(field(item, "description"))}</p>` : "");
}

export function generatePortfolioCss(accentColor = "#b8ef67", siteTemplate: PortfolioTemplateId = "flow"): string {
  const accent = /^#[0-9a-f]{6}$/i.test(accentColor) ? accentColor : "#b8ef67";
  const channels = [1, 3, 5].map((index) => parseInt(accent.slice(index, index + 2), 16) / 255)
    .map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  const luminance = channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
  const accentInk = luminance > .179 ? "#111315" : "#ffffff";
  return `
:root {
  --bg: #f7f8fa; --surface: #eef0f3; --ink: #191b20; --muted: #565d68;
  --line: #d9dde3; --accent: ${accent}; --accent-ink: ${accentInk};
  --signal: #286a64; --scene: #267d72;
}
[data-theme="dark"] {
  --bg: #111315; --surface: #1b1e22; --ink: #f3f5f7; --muted: #b2bac4;
  --line: #343a41; --signal: #b7ef81; --scene: #72d9cf;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 100px; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.75 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; letter-spacing: 0; }
body, button, a { -webkit-tap-highlight-color: transparent; }
::selection { background: var(--accent); color: #111315; }
a { color: inherit; text-decoration: none; }
button { font: inherit; cursor: pointer; }
button, a { touch-action: manipulation; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--signal); outline-offset: 5px; }
h1, h2, h3, p { margin: 0; }
h1, h2, h3 { text-wrap: balance; }
h1, h2, h3, p, a, span { overflow-wrap: anywhere; }
.site-header { position: sticky; top: 0; z-index: 10; background: var(--bg); border-bottom: 1px solid var(--line); }
.header-inner { max-width: 1240px; margin: auto; padding: 18px 36px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.site-logo { min-width: 0; font-weight: 650; display: flex; align-items: center; gap: 10px; }
.logo-mark { width: 15px; height: 15px; flex: none; background: var(--accent); transform: rotate(-12deg); }
.nav-links { display: flex; align-items: center; gap: 25px; font-size: 13px; }
.nav-links a { color: var(--muted); transition: color .2s; }
.nav-links a:hover, .nav-links a[aria-current="location"] { color: var(--ink); }
.theme-toggle { width: 36px; height: 36px; border: 1px solid var(--line); border-radius: 50%; color: var(--ink); background: transparent; }
.scroll-progress { position: absolute; bottom: -1px; left: 0; height: 2px; width: 100%; background: var(--accent); transform: scaleX(0); transform-origin: left; }
.hero { position: relative; isolation: isolate; overflow: hidden; min-height: min(680px, 72svh); display: flex; align-items: center; border-bottom: 1px solid var(--line); }
#resume-scene { position: absolute; inset: 0; z-index: -1; width: 100%; height: 100%; pointer-events: none; opacity: .6; }
.hero-inner { width: 100%; max-width: 1240px; padding: 76px 36px 104px; margin: auto; }
.hero-role { display: flex; gap: 14px; align-items: center; color: var(--muted); font-size: 15px; margin-bottom: 26px; }
.hero-role::before { content: ""; height: 1px; width: 40px; background: var(--signal); }
.hero-name { max-width: 14ch; font-size: 88px; font-weight: 650; line-height: 1.12; }
.hero-name .name-char { display: inline-block; animation: name-in .9s cubic-bezier(.16,1,.3,1) both; animation-delay: calc(var(--i) * 65ms); }
.hero-name .name-end { color: var(--signal); }
.hero-subtitle { max-width: 650px; margin-top: 26px; color: var(--muted); font-size: 20px; line-height: 1.7; }
.hero-meta { display: flex; flex-wrap: wrap; gap: 10px 22px; margin-top: 22px; color: var(--muted); font-size: 13px; }
.hero-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-top: 34px; }
.button { display: inline-flex; align-items: center; justify-content: center; gap: 20px; min-height: 48px; border-radius: 6px; padding: 11px 22px; border: 1px solid var(--line); font-size: 14px; font-weight: 600; transition: transform .2s, background .2s; }
.button.primary { border-color: transparent; background: var(--accent); color: var(--accent-ink); }
.button:hover { background: var(--surface); }
.button.primary:hover { background: color-mix(in srgb, var(--accent) 85%, white); }
.button .arrow { transition: transform .2s; }
.button:hover .arrow { transform: translate(3px,-3px); }
.scroll-cue { position: absolute; bottom: 24px; left: max(36px, calc((100vw - 1168px) / 2)); display: flex; gap: 12px; align-items: center; color: var(--muted); font-size: 12px; }
.scroll-cue span { display: inline-block; animation: scroll-nudge 2s ease-in-out infinite; }
.resume-section { max-width: 1240px; margin: auto; padding: 76px 36px; display: grid; grid-template-columns: 210px minmax(0,1fr); gap: 52px; border-bottom: 1px solid var(--line); }
.section-heading h2 { font-size: 25px; line-height: 1.4; font-weight: 600; }
.section-heading::before { content: ""; display: block; width: 28px; height: 3px; background: var(--signal); margin-bottom: 19px; }
.section-body { min-width: 0; }
.about-text { max-width: 65ch; font-size: 21px; line-height: 1.9; }
.timeline { position: relative; }
.timeline::before { content: ""; position: absolute; top: 8px; bottom: 10px; left: 0; width: 1px; background: var(--line); }
.timeline::after { content: ""; position: absolute; top: 8px; bottom: 10px; left: 0; width: 1px; background: var(--signal); transform: scaleY(var(--journey, 0)); transform-origin: top; pointer-events: none; }
.resume-entry { position: relative; padding: 0 0 38px 28px; }
.resume-entry:last-child { padding-bottom: 0; }
.resume-entry::before { content: ""; position: absolute; left: -4px; top: 10px; width: 9px; height: 9px; border: 2px solid var(--signal); background: var(--bg); border-radius: 50%; transition: background .25s, transform .25s; }
.resume-entry:hover::before { background: var(--signal); transform: scale(1.35); }
.entry-top { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 20px; align-items: baseline; }
.entry-top h3 { font-size: 21px; font-weight: 600; line-height: 1.5; }
.period { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.entry-role { color: var(--signal); font-size: 14px; margin-top: 5px; }
.entry-copy { margin-top: 14px; max-width: 68ch; color: var(--muted); font-size: 15px; }
.entry-copy p { white-space: pre-line; }
.entry-copy ul, .entry-copy ol { padding-left: 20px; margin: 8px 0 0; }
.entry-copy li { padding-left: 3px; margin-top: 7px; }
.entry-copy strong, .about-text strong { color: var(--ink); }
[data-theme="dark"] .entry-copy [style*="color"], [data-theme="dark"] .about-text [style*="color"] { color: var(--signal) !important; }
.skills-list { display: flex; flex-wrap: wrap; gap: 12px; }
.skill { position: relative; max-width: 100%; padding: 12px 18px; border: 1px solid var(--line); border-radius: 6px; font-size: 15px; transition: transform .25s, border-color .25s, background .25s; }
.skill:hover { transform: translateY(-4px) rotate(-1deg); border-color: var(--signal); background: var(--surface); }
.project-links { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 15px; color: var(--signal); font-size: 13px; }
.contact { max-width: 1240px; padding: 84px 36px; margin: auto; }
.contact h2 { max-width: 18ch; font-size: 48px; line-height: 1.25; font-weight: 600; }
.contact p { margin-top: 18px; color: var(--muted); }
.contact .hero-actions { margin-top: 28px; }
.site-footer { max-width: 1240px; margin: auto; padding: 22px 36px; border-top: 1px solid var(--line); color: var(--muted); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; font-size: 12px; }
[data-reveal].reveal-active { animation: section-in .7s cubic-bezier(.16,1,.3,1) both; }
@keyframes name-in { from { opacity: .2; transform: translateY(30px) rotate(5deg); filter: blur(6px); } to { opacity: 1; transform: none; filter: none; } }
@keyframes section-in { from { transform: translateY(24px); opacity: .45; } to { transform: none; opacity: 1; } }
@keyframes scroll-nudge { 0%,100% { transform: translateY(-3px); } 50% { transform: translateY(4px); } }
@media (max-width: 760px) {
  .header-inner { padding: 14px 22px; gap: 12px; }
  .nav-links { gap: 14px; }
  .nav-links a { display: none; }
  .hero { min-height: min(570px, 74svh); }
  .hero-inner { padding: 60px 24px 100px; }
  .hero-name { font-size: 58px; }
  .hero-subtitle { font-size: 18px; }
  .scroll-cue { left: 24px; }
  .resume-section { padding: 46px 24px; grid-template-columns: minmax(0,1fr); gap: 28px; }
  .section-heading h2 { font-size: 23px; }
  .section-heading::before { margin-bottom: 12px; }
  .about-text { font-size: 18px; }
  .contact { padding: 60px 24px; }
  .contact h2 { font-size: 36px; }
  .site-footer { padding: 22px 24px; }
}
@media (max-width: 380px) { .hero-name { font-size: 48px; } .button { padding: 10px 15px; gap: 12px; } }
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
@media print {
  :root, :root[data-theme] { --bg: white; --ink: #111315; --muted: #565d68; --signal: #286a64; --line: #d9dde3; }
  .site-header, #resume-scene, .scroll-cue, .hero-actions, .contact, .scroll-progress { display: none; }
  body { background: white; color: black; }
  .hero { min-height: 0; }
  .hero-inner, .resume-section { padding: 24px; }
  .resume-section { break-inside: avoid; }
}
`.trim() + "\n" + portfolioTemplateCss(siteTemplate);
}

export function generatePortfolioJs(themeMode: SafePortfolioData["themeMode"] = "auto", siteTemplate: PortfolioTemplateId = "flow"): string {
  const preferred = themeMode === "light" || themeMode === "dark" ? themeMode : "auto";
  const scene = isPortfolioTemplate(siteTemplate) ? siteTemplate : "flow";
  return `
(function() {
  var configured = '${preferred}';
  var scene = '${scene}';
  function setTheme(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);
    if (persist) { try { localStorage.setItem('portfolio-theme', theme); } catch (error) {} }
    var button = document.getElementById('theme-toggle');
    if (button) { button.textContent = theme === 'dark' ? '☀' : '☾'; button.setAttribute('aria-label', theme === 'dark' ? '切换为浅色' : '切换为深色'); }
  }
  var saved;
  try { saved = localStorage.getItem('portfolio-theme'); } catch (error) {}
  setTheme(saved === 'light' || saved === 'dark' ? saved : configured === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : configured, true);
  function init() {
    var themeButton = document.getElementById('theme-toggle');
    if (themeButton) themeButton.addEventListener('click', function() { setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true); });
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    // srcdoc 的相对锚点继承父页面地址，直接滚动目标以避免离开当前简历。
    document.querySelectorAll('a[href^="#"]').forEach(function(link) {
      link.addEventListener('click', function(event) {
        var target = document.getElementById(link.getAttribute('href').slice(1));
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'start' });
      });
    });
    var progress = document.querySelector('.scroll-progress');
    function updateProgress() {
      var height = document.documentElement.scrollHeight - window.innerHeight;
      if (progress) progress.style.transform = 'scaleX(' + (height > 0 ? window.scrollY / height : 0) + ')';
      document.querySelectorAll('.timeline').forEach(function(timeline) {
        var rect = timeline.getBoundingClientRect();
        timeline.style.setProperty('--journey', Math.max(0, Math.min(1, (window.innerHeight * .8 - rect.top) / Math.max(rect.height, 1))));
      });
    }
    window.addEventListener('scroll', updateProgress, { passive: true });
    updateProgress();
    if (typeof IntersectionObserver !== 'undefined') {
      var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            if (!reduced.matches) entry.target.classList.add('reveal-active');
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12 });
      document.querySelectorAll('[data-reveal]').forEach(function(element) { observer.observe(element); });
    }
    document.querySelectorAll('[data-mag]').forEach(function(button) {
      button.addEventListener('mousemove', function(event) {
        if (reduced.matches || !window.matchMedia('(pointer: fine)').matches) return;
        var rect = button.getBoundingClientRect();
        button.style.transform = 'translate(' + ((event.clientX - rect.left - rect.width / 2) * .12) + 'px,' + ((event.clientY - rect.top - rect.height / 2) * .12) + 'px)';
      });
      button.addEventListener('mouseleave', function() { button.style.transform = ''; });
    });
    var canvas = document.getElementById('resume-scene');
    if (!canvas || !canvas.getContext) return;
    var context = canvas.getContext('2d');
    if (!context) return;
    var width = 0, height = 0, frame = 0, raf = 0, visible = true, pointer = 0;
    function resize() {
      width = canvas.clientWidth; height = canvas.clientHeight;
      var ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * ratio; canvas.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    function draw() {
      context.clearRect(0, 0, width, height);
      context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--scene').trim();
      context.lineWidth = .9;
      if (scene === 'focus') {
        for (var ring = 0; ring < 14; ring++) {
          context.beginPath(); context.globalAlpha = .24;
          context.ellipse(width * .5, height * 1.28, width * .28 + ring * 30, height * .42 + ring * 17, Math.sin(frame / 260) * .04, Math.PI, Math.PI * 2);
          context.stroke();
        }
      } else if (scene === 'chronicle') {
        for (var track = 0; track < 12; track++) {
          var offset = (frame * .35 + track * 91) % (width + 240) - 120;
          var trackY = height * .76 + track * 14;
          context.beginPath(); context.globalAlpha = .25;
          context.moveTo(offset, trackY); context.lineTo(offset + 160, trackY);
          context.moveTo(offset + 160, trackY - 3); context.lineTo(offset + 160, trackY + 3);
          context.stroke();
        }
      } else if (scene === 'sidebar') {
        for (var column = 0; column < 22; column++) {
          context.beginPath(); context.globalAlpha = .2;
          for (var lineY = 0; lineY <= height + 20; lineY += 20) {
            var lineX = width * .7 + column * 18 + Math.sin(lineY / 170 + frame / 220 + column * .08 + pointer) * 42;
            if (lineY === 0) context.moveTo(lineX, lineY); else context.lineTo(lineX, lineY);
          }
          context.stroke();
        }
      } else for (var row = 0; row < 28; row++) {
        context.beginPath();
        context.globalAlpha = .18 + row / 100;
        for (var x = 0; x <= width + 20; x += 20) {
          var wave = Math.sin(x / 210 + frame / 180 + row * .1) * (28 + row * 1.1);
          var y = height * .65 + row * 13 + wave + Math.sin(x / 480 + pointer) * 35;
          if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.stroke();
      }
      context.globalAlpha = 1;
    }
    function animate() {
      raf = 0; draw();
      if (visible && !document.hidden && !reduced.matches) { frame++; raf = requestAnimationFrame(animate); }
    }
    function resume() { if (raf) cancelAnimationFrame(raf); raf = 0; animate(); }
    resize(); resume();
    window.addEventListener('resize', function() { resize(); if (!raf) draw(); }, { passive: true });
    document.addEventListener('visibilitychange', resume);
    if (reduced.addEventListener) reduced.addEventListener('change', resume);
    if (themeButton) themeButton.addEventListener('click', function() { if (!raf) draw(); });
    canvas.parentElement.addEventListener('pointermove', function(event) { if (!reduced.matches) pointer = event.clientX / Math.max(width, 1); });
    if (typeof IntersectionObserver !== 'undefined') {
      var sceneObserver = new IntersectionObserver(function(entries) { visible = entries[0].isIntersecting; resume(); });
      sceneObserver.observe(canvas);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
`.trim();
}

export function generatePortfolioHtml(data: SafePortfolioData): string {
  const { candidateName, candidateTitle, siteTitle, siteSubtitle, resumeSnapshot } = data;
  const siteTemplate = isPortfolioTemplate(data.siteTemplate) ? data.siteTemplate : "flow";
  const modules = [...resumeSnapshot.modules].sort((a, b) => a.sort - b.sort);
  const basic = (modules.find((module) => module.type === "basic")?.content ?? {}) as Record<string, unknown>;
  const summary = modules.find((module) => module.type === "summary");
  const summaryText = summary ? field((summary.content ?? {}) as Record<string, unknown>, "text") : "";
  const contentSections = modules.filter((module) => module.type !== "basic").flatMap((module, index) => {
    let content = "";
    if (module.type === "summary") {
      const summary = (module.content ?? {}) as Record<string, unknown>;
      const text = field(summary, "text");
      const items = Array.isArray(summary.descriptionItems)
        ? summary.descriptionItems.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
      if (items.length) {
        const tag = summary.descriptionStyle === "ordered" ? "ol" : "ul";
        content = `<${tag}>${items.map((item) => `<li>${sanitizeRichText(item)}</li>`).join("")}</${tag}>`;
      } else if (text) content = `<div class="about-text">${sanitizeRichText(text)}</div>`;
    } else if (module.type === "skills") {
      const items = (module.content as { items?: unknown[] } | null)?.items;
      if (Array.isArray(items)) content = items.filter((skill): skill is string => typeof skill === "string" && !!skill.trim())
        .map((skill) => `<span class="skill">${escapeHtml(skill)}</span>`).join("");
      if (content) content = `<div class="skills-list">${content}</div>`;
    } else if (Array.isArray(module.content)) {
      const entries = module.content.filter((item) => item && typeof item === "object");
      content = entries.map((item) => {
        const record = item as Record<string, unknown>;
        const title = field(record, module.type === "work" ? "company" : module.type === "education" ? "school" : module.type === "projects" ? "name" : "title");
        const role = module.type === "education" ? [field(record, "degree"), field(record, "field")].filter(Boolean).join(" · ")
          : field(record, module.type === "work" ? "title" : module.type === "projects" ? "role" : "subTitle");
        const period = [field(record, "start"), field(record, "end")].filter(Boolean).join(" ~ ");
        const body = entryBody(record);
        if (!title && !role && !period && !body) return "";
        return `<article class="resume-entry" data-reveal><div class="entry-top"><h3>${escapeHtml(title)}</h3>${period ? `<span class="period">${escapeHtml(period)}</span>` : ""}</div>${role ? `<p class="entry-role">${escapeHtml(role)}</p>` : ""}${body ? `<div class="entry-copy">${body}</div>` : ""}</article>`;
      }).join("");
      if (content) content = `<div class="timeline">${content}</div>`;
    }
    if (!content) return [];
    return [{ id: `resume-${index}`, label: module.label, html: `<section class="resume-section" id="resume-${index}"><div class="section-heading" data-reveal><h2>${escapeHtml(module.label)}</h2></div><div class="section-body">${content}</div></section>` }];
  });
  const extraProjects = data.projects.map((project) => {
    const summary = project.safeSummary;
    const links = ([ [project.customLinks.demoUrl, "在线作品"], [project.customLinks.repoUrl, "作品仓库"], [project.customLinks.docUrl, "作品文档"] ] as const)
      .map(([value, label]) => { const url = normalizePortfolioLink(value ?? ""); return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${label} ↗</a>` : ""; }).join("");
    return `<article class="resume-entry" data-reveal><div class="entry-top"><h3>${escapeHtml(project.name)}</h3></div><div class="entry-copy"><p>${escapeHtml(summary.brief || summary.overview)}</p>${summary.achievements?.length ? `<ul>${summary.achievements.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>` : ""}</div>${links ? `<div class="project-links">${links}</div>` : ""}</article>`;
  }).join("");
  const heroText = siteSubtitle || (summaryText ? stripRichText(summaryText).slice(0, 160) : candidateTitle);
  const contact = [field(basic, "location"), field(basic, "phone"), field(basic, "email")].filter(Boolean);
  const nameChars = candidateName.length <= 80
    ? Array.from(candidateName).map((char, index) => `<span class="name-char" style="--i:${index}">${char === " " ? "&nbsp;" : escapeHtml(char)}</span>`).join("")
    : escapeHtml(candidateName);
  return `<!DOCTYPE html>
<html lang="zh-CN" data-template="${siteTemplate}"${data.themeMode === "light" || data.themeMode === "dark" ? ` data-theme="${data.themeMode}"` : ""}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(siteTitle)}</title>
  <link rel="stylesheet" href="assets/style.css" />
</head>
<body>
  <header class="site-header"><div class="header-inner"><a class="site-logo" href="#top"><span class="logo-mark" aria-hidden="true"></span>${escapeHtml(candidateName)}</a><nav class="nav-links" aria-label="简历导航">${contentSections.slice(0, 4).map((section) => `<a href="#${section.id}">${escapeHtml(section.label)}</a>`).join("")}<button class="theme-toggle" id="theme-toggle" type="button" aria-label="切换主题">◐</button></nav></div><div class="scroll-progress" aria-hidden="true"></div></header>
  <main>
    <section class="hero" id="top"><canvas id="resume-scene" aria-hidden="true"></canvas><div class="hero-inner"><p class="hero-role">${escapeHtml(candidateTitle)}</p><h1 class="hero-name" aria-label="${escapeHtml(candidateName)}"><span aria-hidden="true">${nameChars}<span class="name-end">.</span></span></h1><p class="hero-subtitle">${escapeHtml(heroText)}</p>${contact.length ? `<div class="hero-meta">${contact.map((text) => `<span>${escapeHtml(text)}</span>`).join("")}</div>` : ""}<div class="hero-actions"><a class="button primary" href="resume.html" target="_blank" rel="noreferrer" data-mag>查看完整简历 <span class="arrow" aria-hidden="true">↗</span></a>${contentSections.length ? `<a class="button" href="#${contentSections[0]!.id}">了解我的经历 <span class="arrow" aria-hidden="true">↓</span></a>` : ""}</div></div>${contentSections.length ? `<a class="scroll-cue" href="#${contentSections[0]!.id}">继续了解 <span aria-hidden="true">↓</span></a>` : ""}</section>
    ${contentSections.map((section) => section.html).join("\n    ")}
    ${extraProjects ? `<section class="resume-section" id="additional-work"><div class="section-heading" data-reveal><h2>更多作品</h2></div><div class="section-body timeline">${extraProjects}</div></section>` : ""}
    <section class="contact" id="contact" data-reveal><h2>期待下一次，<br />一起创造的机会。</h2>${contact.length ? `<p>${contact.map(escapeHtml).join(" · ")}</p>` : ""}<div class="hero-actions"><a class="button primary" href="resume.html" target="_blank" rel="noreferrer" data-mag>查看完整简历 <span class="arrow" aria-hidden="true">↗</span></a><a class="button" href="#top">回到顶部 ↑</a></div></section>
  </main>
  <footer class="site-footer"><span>© ${new Date().getFullYear()} ${escapeHtml(candidateName)}</span><span>${escapeHtml(siteTitle)}</span></footer>
  <script src="assets/app.js"></script>
</body>
</html>`;
}

export function generatePortfolioPreviewHtml(data: SafePortfolioData): string {
  return generatePortfolioHtml(data)
    .replace('<link rel="stylesheet" href="assets/style.css" />', () => `<style>${generatePortfolioCss(data.accentColor, data.siteTemplate)}</style>`)
    .replace('<script src="assets/app.js"></script>', () => `<script>${generatePortfolioJs(data.themeMode, data.siteTemplate)}</script>`);
}
