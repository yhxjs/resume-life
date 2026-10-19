"use client";

import type { Dispatch, SetStateAction } from "react";
import type { AnonymizeConfig, CustomSensitiveRule } from "@/lib/resume-anonymize";
import type { BasicContent } from "@/lib/modules";

interface AnonymizeBasicConfigEditorProps {
  config: AnonymizeConfig;
  setConfig: Dispatch<SetStateAction<AnonymizeConfig>>;
  originalBasic: Partial<BasicContent>;
}

interface AnonymizeCustomRulesEditorProps {
  config: AnonymizeConfig;
  setConfig: Dispatch<SetStateAction<AnonymizeConfig>>;
  newSource: string;
  setNewSource: (source: string) => void;
  newReplacement: string;
  setNewReplacement: (replacement: string) => void;
  onError: (error: string) => void;
}

const PRESET_REPLACEMENTS = [
  { label: "保密项目A", value: "[某保密核心项目A]" },
  { label: "头部大厂", value: "[某国内头部互联网大厂]" },
  { label: "跨境电商", value: "[某跨境电商独角兽]" },
  { label: "核心中台", value: "[某企业级核心业务中台]" },
  { label: "金融机构", value: "[某头部持牌金融机构]" },
];

export function AnonymizeBasicConfigEditor({
  config,
  setConfig,
  originalBasic,
}: AnonymizeBasicConfigEditorProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted flex items-center gap-1.5">
          <span>👤</span>
          <span>个人基本身份与联系方式 (自动识别)</span>
        </h3>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {/* 姓名 */}
        <div className="rounded-xl border border-line bg-surface/40 p-3 space-y-2">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-xs font-semibold text-ink">姓名脱敏</span>
              <span className="ml-1.5 text-[11px] font-mono text-muted">
                ({originalBasic.name || "未填写"})
              </span>
            </div>
            <input
              type="checkbox"
              checked={config.name.enabled}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  name: { ...c.name, enabled: e.target.checked },
                }))
              }
              className="rounded border-line text-primary focus:ring-primary h-4 w-4"
            />
          </label>
          {config.name.enabled && (
            <div className="flex items-center gap-2 pt-1 text-[11px] text-muted">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="name-mask-mode"
                  checked={config.name.mode === "surname_only"}
                  onChange={() =>
                    setConfig((c) => ({
                      ...c,
                      name: { ...c.name, mode: "surname_only" },
                    }))
                  }
                  className="text-primary"
                />
                <span>保留姓氏 ({originalBasic.name ? `${originalBasic.name[0]}*` : "张*"})</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="name-mask-mode"
                  checked={config.name.mode === "placeholder"}
                  onChange={() =>
                    setConfig((c) => ({
                      ...c,
                      name: { ...c.name, mode: "placeholder" },
                    }))
                  }
                  className="text-primary"
                />
                <span>固定代号</span>
              </label>
            </div>
          )}
        </div>

        {/* 手机号 */}
        <div className="rounded-xl border border-line bg-surface/40 p-3 space-y-2">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-xs font-semibold text-ink">手机号脱敏</span>
              {originalBasic.phone && (
                <span className="ml-1.5 text-[11px] font-mono text-muted truncate">
                  ({originalBasic.phone})
                </span>
              )}
            </div>
            <input
              type="checkbox"
              checked={config.phone.enabled}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  phone: { ...c.phone, enabled: e.target.checked },
                }))
              }
              className="rounded border-line text-primary focus:ring-primary h-4 w-4"
            />
          </label>
          <div className="flex items-center gap-2 pt-1 text-[11px] text-muted">
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name="phone-mask-mode"
                checked={config.phone.mode === "prefix_only"}
                onChange={() =>
                  setConfig((c) => ({
                    ...c,
                    phone: { ...c.phone, mode: "prefix_only" },
                  }))
                }
                className="text-primary"
              />
              <span>只保留前三位 (138********)</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name="phone-mask-mode"
                checked={config.phone.mode === "mask_middle"}
                onChange={() =>
                  setConfig((c) => ({
                    ...c,
                    phone: { ...c.phone, mode: "mask_middle" },
                  }))
                }
                className="text-primary"
              />
              <span>保留前3后4 (138****0000)</span>
            </label>
          </div>
        </div>

        {/* 电子邮箱 */}
        <div className="rounded-xl border border-line bg-surface/40 p-3 space-y-2">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-xs font-semibold text-ink">电子邮箱脱敏</span>
              {originalBasic.email && (
                <span className="ml-1.5 text-[11px] font-mono text-muted truncate">
                  ({originalBasic.email})
                </span>
              )}
            </div>
            <input
              type="checkbox"
              checked={config.email.enabled}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  email: { ...c.email, enabled: e.target.checked },
                }))
              }
              className="rounded border-line text-primary focus:ring-primary h-4 w-4"
            />
          </label>
          <p className="text-[11px] text-muted">仅保留首字母与域名 (z***@...)</p>
        </div>

        {/* 现居地 */}
        <div className="rounded-xl border border-line bg-surface/40 p-3 space-y-2">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-xs font-semibold text-ink">现居地址模糊</span>
              {originalBasic.location && (
                <span className="ml-1.5 text-[11px] font-mono text-muted truncate">
                  ({originalBasic.location})
                </span>
              )}
            </div>
            <input
              type="checkbox"
              checked={config.location.enabled}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  location: { ...c.location, enabled: e.target.checked },
                }))
              }
              className="rounded border-line text-primary focus:ring-primary h-4 w-4"
            />
          </label>
          <p className="text-[11px] text-muted">仅保留城市名称，抹去精确门牌区县</p>
        </div>

        {/* 社交链接与个人主页 */}
        <div className="rounded-xl border border-line bg-surface/40 p-3 space-y-2">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-xs font-semibold text-ink">隐藏外链/社交主页</span>
            <input
              type="checkbox"
              checked={config.links.enabled}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  links: { ...c.links, enabled: e.target.checked },
                }))
              }
              className="rounded border-line text-primary focus:ring-primary h-4 w-4"
            />
          </label>
          <p className="text-[11px] text-muted">防止通过 GitHub/博客链接反向人肉追查</p>
        </div>

        {/* 头像 */}
        <div className="rounded-xl border border-line bg-surface/40 p-3 space-y-2">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-xs font-semibold text-ink">移除个人头像照片</span>
            <input
              type="checkbox"
              checked={config.avatar.enabled}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  avatar: { ...c.avatar, enabled: e.target.checked },
                }))
              }
              className="rounded border-line text-primary focus:ring-primary h-4 w-4"
            />
          </label>
          <p className="text-[11px] text-muted">隐藏人脸特征，避免被熟人认出</p>
        </div>
      </div>
    </section>
  );
}

export function AnonymizeCustomRulesEditor({
  config,
  setConfig,
  newSource,
  setNewSource,
  newReplacement,
  setNewReplacement,
  onError,
}: AnonymizeCustomRulesEditorProps) {
  function handleAddRule(sourceStr = newSource, replacementStr = newReplacement) {
    const src = sourceStr.trim();
    const rep = replacementStr.trim();
    if (!src || !rep) return;
    if (config.customRules.some((r) => r.source.toLowerCase() === src.toLowerCase())) {
      onError(`敏感词「${src}」已在规则列表中`);
      return;
    }

    const newRule: CustomSensitiveRule = {
      id: String(Date.now() + Math.random()),
      source: src,
      replacement: rep,
    };

    setConfig((prev) => ({
      ...prev,
      customRules: [...prev.customRules, newRule],
    }));
    setNewSource("");
    setNewReplacement("");
    onError("");
  }

  function handleRemoveRule(id: string) {
    setConfig((prev) => ({
      ...prev,
      customRules: prev.customRules.filter((r) => r.id !== id),
    }));
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted flex items-center gap-1.5">
          <span>➕</span>
          <span>补充其他保密代号或敏感词 ({config.customRules.length})</span>
        </h3>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted text-[11px]">快捷占位：</span>
        {PRESET_REPLACEMENTS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => setNewReplacement(p.value)}
            className="rounded border border-line bg-card px-2 py-0.5 text-[11px] font-medium text-ink hover:border-primary/50 transition-colors"
          >
            + {p.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 rounded-xl border border-line bg-surface/30 p-2.5">
        <input
          type="text"
          placeholder="输入其他敏感词(如 内部代号/秘密系统名)"
          value={newSource}
          onChange={(e) => setNewSource(e.target.value)}
          className="flex-1 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs outline-none focus:border-primary"
        />
        <span className="hidden sm:inline text-muted text-xs">→</span>
        <input
          type="text"
          placeholder="替换占位符(如 [某保密微服务平台])"
          value={newReplacement}
          onChange={(e) => setNewReplacement(e.target.value)}
          className="flex-1 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={() => handleAddRule()}
          disabled={!newSource.trim() || !newReplacement.trim()}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-40 transition-colors shrink-0"
        >
          添加规则
        </button>
      </div>

      {config.customRules.length > 0 && (
        <div className="space-y-1.5 max-h-36 overflow-y-auto">
          {config.customRules.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-line/70 bg-card px-3 py-1.5 text-xs"
            >
              <div className="flex items-center gap-2 truncate">
                <span className="font-mono text-danger font-medium">{r.source}</span>
                <span className="text-muted">→</span>
                <span className="font-medium text-primary">{r.replacement}</span>
              </div>
              <button
                type="button"
                onClick={() => handleRemoveRule(r.id)}
                className="text-muted hover:text-danger p-1 text-xs shrink-0"
                title="删除此规则"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
