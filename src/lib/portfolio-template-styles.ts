import type { PortfolioTemplateId } from "./portfolio-templates";

export function portfolioTemplateCss(template: PortfolioTemplateId): string {
  switch (template) {
    case "focus": return `
[data-template="focus"] .hero { min-height: min(720px, 78svh); text-align: center; }
[data-template="focus"] .hero-inner { padding-top: 64px; padding-bottom: 112px; }
[data-template="focus"] .hero-role, [data-template="focus"] .hero-meta, [data-template="focus"] .hero-actions { justify-content: center; }
[data-template="focus"] .hero-role::before { display: none; }
[data-template="focus"] .hero-name { margin: auto; font-size: 96px; }
[data-template="focus"] .hero-subtitle { max-width: 580px; margin-left: auto; margin-right: auto; }
[data-template="focus"] .scroll-cue { left: 50%; transform: translateX(-50%); }
[data-template="focus"] .resume-section { max-width: 980px; grid-template-columns: minmax(0, 1fr); gap: 30px; padding-top: 60px; padding-bottom: 60px; }
[data-template="focus"] .section-heading { display: flex; align-items: center; gap: 15px; }
[data-template="focus"] .section-heading::before { margin: 0; width: 22px; height: 2px; }
[data-template="focus"] .contact { text-align: center; }
[data-template="focus"] .contact h2 { margin: auto; }
@media (max-width: 760px) {
  [data-template="focus"] .hero { min-height: min(610px, 78svh); }
  [data-template="focus"] .hero-name { font-size: 58px; }
  [data-template="focus"] .resume-section { padding: 44px 24px; }
}
@media (max-width: 380px) { [data-template="focus"] .hero-name { font-size: 48px; } }
`.trim();
    case "chronicle": return `
[data-template="chronicle"] body { counter-reset: chapter; }
[data-template="chronicle"] .header-inner, [data-template="chronicle"] .hero-inner, [data-template="chronicle"] .resume-section, [data-template="chronicle"] .contact, [data-template="chronicle"] .site-footer { max-width: 1080px; }
[data-template="chronicle"] .hero { min-height: min(550px, 68svh); }
[data-template="chronicle"] .hero-name { font-family: "Songti SC", "SimSun", Georgia, serif; font-weight: 700; font-size: 76px; }
[data-template="chronicle"] .hero-inner { padding-top: 54px; padding-bottom: 96px; }
[data-template="chronicle"] .hero-subtitle { font-size: 18px; max-width: 620px; }
[data-template="chronicle"] .scroll-cue { left: max(36px, calc((100vw - 1008px) / 2)); }
[data-template="chronicle"] #resume-scene { opacity: .4; }
[data-template="chronicle"] .resume-section { grid-template-columns: 170px minmax(0, 1fr); gap: 36px; padding-top: 48px; padding-bottom: 48px; counter-increment: chapter; }
[data-template="chronicle"] .section-heading::before { content: counter(chapter, decimal-leading-zero); width: auto; height: auto; background: none; color: var(--signal); font-size: 14px; font-variant-numeric: tabular-nums; margin-bottom: 10px; }
[data-template="chronicle"] .section-heading h2 { font-size: 22px; }
[data-template="chronicle"] .timeline::before, [data-template="chronicle"] .timeline::after, [data-template="chronicle"] .resume-entry::before { display: none; }
[data-template="chronicle"] .resume-entry { padding: 0 0 26px; margin-bottom: 24px; border-bottom: 1px solid var(--line); }
[data-template="chronicle"] .resume-entry:last-child { padding-bottom: 0; margin-bottom: 0; border-bottom: 0; }
[data-template="chronicle"] .entry-top h3 { font-size: 19px; }
[data-template="chronicle"] .about-text { font-size: 18px; }
[data-template="chronicle"] .skill { padding: 6px 0; border: 0; border-radius: 0; }
[data-template="chronicle"] .skills-list { gap: 8px 26px; }
[data-template="chronicle"] .contact h2 { font-size: 38px; }
@media (max-width: 760px) {
  [data-template="chronicle"] .hero-name { font-size: 54px; }
  [data-template="chronicle"] .scroll-cue { left: 24px; }
  [data-template="chronicle"] .resume-section { grid-template-columns: minmax(0, 1fr); gap: 22px; padding: 38px 24px; }
  [data-template="chronicle"] .section-heading { display: flex; align-items: baseline; gap: 12px; }
  [data-template="chronicle"] .section-heading::before { margin: 0; }
  [data-template="chronicle"] .contact h2 { font-size: 32px; }
}
@media (max-width: 380px) { [data-template="chronicle"] .hero-name { font-size: 46px; } }
`.trim();
    case "sidebar": return `
[data-template="sidebar"] { scroll-padding-top: 36px; }
[data-template="sidebar"] .site-header { position: fixed; inset: 0 auto 0 0; width: 220px; border-bottom: 0; border-right: 1px solid var(--line); }
[data-template="sidebar"] .header-inner { height: 100%; padding: 36px 24px; flex-direction: column; align-items: stretch; justify-content: flex-start; gap: 64px; }
[data-template="sidebar"] .site-logo { align-items: flex-start; }
[data-template="sidebar"] .logo-mark { margin-top: 7px; }
[data-template="sidebar"] .nav-links { flex: 1; flex-direction: column; align-items: stretch; gap: 0; }
[data-template="sidebar"] .nav-links a { padding: 14px 0; border-bottom: 1px solid var(--line); }
[data-template="sidebar"] .theme-toggle { margin-top: auto; }
[data-template="sidebar"] main { margin-left: 220px; }
[data-template="sidebar"] .hero { min-height: min(640px, 76svh); }
[data-template="sidebar"] .hero-inner { padding-left: 54px; padding-right: 54px; }
[data-template="sidebar"] .hero-name { font-size: 72px; }
[data-template="sidebar"] .hero-subtitle { font-size: 19px; max-width: 540px; }
[data-template="sidebar"] .scroll-cue { left: 54px; }
[data-template="sidebar"] .resume-section { grid-template-columns: minmax(0, 1fr); gap: 28px; padding: 54px; }
[data-template="sidebar"] .section-heading { display: flex; gap: 14px; align-items: center; }
[data-template="sidebar"] .section-heading::before { width: 16px; height: 2px; margin: 0; }
[data-template="sidebar"] .about-text { font-size: 19px; }
[data-template="sidebar"] .contact { padding: 64px 54px; }
[data-template="sidebar"] .contact h2 { font-size: 40px; }
[data-template="sidebar"] .site-footer { margin-left: 220px; }
@media (max-width: 960px) {
  [data-template="sidebar"] { scroll-padding-top: 90px; }
  [data-template="sidebar"] .site-header { position: sticky; inset: auto; top: 0; width: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  [data-template="sidebar"] .header-inner { height: auto; padding: 14px 24px; flex-direction: row; align-items: center; justify-content: space-between; gap: 16px; }
  [data-template="sidebar"] .nav-links { flex: none; flex-direction: row; align-items: center; gap: 16px; }
  [data-template="sidebar"] .nav-links a { padding: 0; border-bottom: 0; }
  [data-template="sidebar"] .theme-toggle { margin-top: 0; }
  [data-template="sidebar"] main, [data-template="sidebar"] .site-footer { margin-left: 0; }
}
@media (max-width: 760px) {
  [data-template="sidebar"] .hero-inner { padding-left: 24px; padding-right: 24px; }
  [data-template="sidebar"] .hero-name { font-size: 58px; }
  [data-template="sidebar"] .scroll-cue { left: 24px; }
  [data-template="sidebar"] .resume-section { padding: 44px 24px; }
  [data-template="sidebar"] .contact { padding: 60px 24px; }
  [data-template="sidebar"] .contact h2 { font-size: 34px; }
}
@media (max-width: 380px) { [data-template="sidebar"] .hero-name { font-size: 48px; } }
@media print {
  [data-template="sidebar"] main, [data-template="sidebar"] .site-footer { margin-left: 0; }
}
`.trim();
    default: return "";
  }
}
