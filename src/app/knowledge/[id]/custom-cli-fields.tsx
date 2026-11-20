"use client";

import { useEffect, useState } from "react";
import { btnGhost, inputCls, labelCls } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { parseCustomCliArgs, parseCustomCliConfig } from "@/lib/repo-scanner/cli-config";
import { loadCustomCliProfiles, saveCustomCliProfiles, MAX_CUSTOM_CLI_PROFILES, type CustomCliProfile } from "@/lib/custom-cli-storage";

export interface CustomCliDraft {
  selectedId: string;
  name: string;
  command: string;
  argsText: string;
}

export function CustomCliFields({ value, onChange, disabled }: {
  value: CustomCliDraft; onChange: (value: CustomCliDraft) => void; disabled: boolean;
}) {
  const { selectedId, name } = value;
  const [profiles, setProfiles] = useState<CustomCliProfile[]>([]);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 浏览器存储挂载后回填，SSR 首帧保持一致
    setProfiles(loadCustomCliProfiles());
  }, []);

  function selectProfile(id: string) {
    const profile = profiles.find(item => item.id === id);
    setMessage("");
    onChange(profile
      ? { selectedId: profile.id, name: profile.name, command: profile.command, argsText: JSON.stringify(profile.args, null, 2) }
      : { selectedId: "", name: "", command: "", argsText: "[]" });
  }

  function save() {
    try {
      if (!name.trim()) throw new Error("请填写客户端名称后保存");
      const config = parseCustomCliConfig({ command: value.command, args: parseCustomCliArgs(value.argsText) });
      // 在写入时重新读取，保留其他弹窗已保存的客户端。
      const latest = loadCustomCliProfiles();
      const id = selectedId || crypto.randomUUID();
      const profile = { id, name: name.trim(), ...config };
      const next = latest.some(item => item.id === id) ? latest.map(item => item.id === id ? profile : item) : [...latest, profile];
      saveCustomCliProfiles(next);
      setProfiles(next);
      onChange({ ...value, selectedId: id, name: profile.name });
      setFailed(false);
      setMessage("客户端已保存到当前浏览器");
    } catch (error) { setFailed(true); setMessage(errorMessage(error)); }
  }

  function remove() {
    try {
      const next = loadCustomCliProfiles().filter(item => item.id !== selectedId);
      saveCustomCliProfiles(next);
      setProfiles(next);
      onChange({ ...value, selectedId: "", name: "" });
      setFailed(false);
      setMessage("已移除保存的客户端，当前命令仍可使用");
    } catch (error) { setFailed(true); setMessage(`移除失败：${errorMessage(error)}`); }
  }

  return <fieldset disabled={disabled} className="space-y-3 rounded-xl border border-line bg-surface-2 p-3 disabled:opacity-60">
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor="custom-cli-profile" className={labelCls}>已保存的客户端</label>
        <select id="custom-cli-profile" className={inputCls} value={selectedId} onChange={event => selectProfile(event.target.value)}>
          <option value="">新建客户端配置</option>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="custom-cli-name" className={labelCls}>客户端名称（保存时填写）</label>
        <input id="custom-cli-name" className={inputCls} maxLength={80} placeholder="例如：团队 SDK 客户端" value={name} onChange={event => onChange({ ...value, name: event.target.value })} />
      </div>
    </div>
    <div>
      <label htmlFor="custom-cli-command" className={labelCls}>可执行程序 <span className="text-accent">*</span></label>
      <input id="custom-cli-command" className={`${inputCls} font-mono`} value={value.command} maxLength={2048}
        placeholder="命令名称或绝对路径，例如 node、python、D:\tools\client.exe"
        onChange={event => onChange({ ...value, command: event.target.value })} />
    </div>
    <div>
      <label htmlFor="custom-cli-args" className={labelCls}>命令参数（JSON 数组）</label>
      <textarea id="custom-cli-args" className={`${inputCls} font-mono text-xs`} rows={3} value={value.argsText} maxLength={32_768}
        placeholder={'["D:/tools/sdk-client.mjs", "--mode", "text"]'}
        onChange={event => onChange({ ...value, argsText: event.target.value })} />
      <p className="mt-1 text-[11px] text-muted">每个参数单独一项，无参数填 []。程序从标准输入读取完整提示词，向标准输出写入模型回复；SDK 脚本请使用绝对路径。</p>
    </div>
    <p className="text-[11px] text-muted">支持接入其他 CLI 或 SDK 包装脚本。请配置客户端的非交互纯文本模式并关闭工具调用；程序在临时目录运行。认证沿用客户端登录或环境变量。</p>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={btnGhost} onClick={save} disabled={!selectedId && profiles.length >= MAX_CUSTOM_CLI_PROFILES}>
        {selectedId ? "更新客户端配置" : "保存客户端配置"}
      </button>
      {selectedId && <button type="button" className={btnGhost} onClick={remove}>移除已保存客户端</button>}
      <span className="text-[11px] text-muted">可保存并切换最多 {MAX_CUSTOM_CLI_PROFILES} 个客户端；也可直接扫描。</span>
    </div>
    {message && <p role={failed ? "alert" : "status"} className={`text-xs ${failed ? "text-accent" : "text-muted"}`}>{message}</p>}
  </fieldset>;
}
