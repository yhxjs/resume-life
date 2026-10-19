import type { ResumeStyle } from "@/lib/templates";
import { inputCls } from "@/lib/ui";
import { ColorField, Field, Group, NumField, Seg } from "./style-controls";

type StyleFieldGroupsProps = {
  /** 当前生效的完整样式值 */
  style: ResumeStyle;
  /** 更新某个样式字段 */
  onSet: <K extends keyof ResumeStyle>(key: K, value: ResumeStyle[K]) => void;
  /** 数值/颜色输入结束后的一致性提交（样式工厂里用于归一化草稿） */
  onCommit: () => void;
  /** 可选：当前可配置的模块列表，用于双栏模式下的侧栏分流 */
  availableModules?: { key: string; label: string }[];
};

const DEFAULT_MODULE_OPTIONS = [
  { key: "education", label: "教育经历" },
  { key: "work", label: "工作经历" },
  { key: "projects", label: "项目经历" },
  { key: "skills", label: "专业技能" },
  { key: "summary", label: "自我评价" },
  { key: "custom", label: "自定义" },
];

/** 完整样式字段分组（页面布局/配色正文/页眉/小节标题/条目技能），
 *  样式工厂检查器与简历详情页悬浮工具栏共用同一套控件 */
export function StyleFieldGroups({ style, onSet, onCommit, availableModules }: StyleFieldGroupsProps) {
  const modulesList = availableModules && availableModules.length > 0 ? availableModules : DEFAULT_MODULE_OPTIONS;

  return (
    <>
      <Group title="页面与布局">
        <Field label="布局">
          <Seg
            value={style.layout}
            options={[
              { value: "single", label: "单栏" },
              { value: "twocol", label: "双栏" },
            ]}
            onChange={(value) => onSet("layout", value)}
          />
        </Field>
        {style.layout === "twocol" && (
          <>
            <Field label="侧栏位置">
              <Seg
                value={style.asidePosition ?? "right"}
                options={[
                  { value: "left", label: "居左" },
                  { value: "right", label: "居右" },
                ]}
                onChange={(value) => onSet("asidePosition", value)}
              />
            </Field>
            <NumField
              label="侧栏宽度"
              value={style.asideWidth}
              min={30}
              max={100}
              unit="mm"
              onChange={(value) => onSet("asideWidth", value)}
              onCommit={onCommit}
            />
            <Field label="侧栏分隔线">
              <Seg
                value={style.asideBorder ?? "auto"}
                options={[
                  { value: "auto", label: "自动" },
                  { value: "none", label: "无" },
                  { value: "left", label: "左线" },
                  { value: "right", label: "右线" },
                  { value: "both", label: "双侧" },
                ]}
                onChange={(value) => onSet("asideBorder", value)}
              />
            </Field>
            {style.asideBorder !== "none" && (
              <ColorField
                label="侧栏线颜色"
                value={style.asideBorderColor || "#e2e2e2"}
                onChange={(value) => onSet("asideBorderColor", value)}
                onCommit={onCommit}
              />
            )}
            <ColorField
              label="侧栏背景色"
              value={style.asideBg || "#f8fafc"}
              onChange={(value) => onSet("asideBg", value)}
              onCommit={onCommit}
            />
            <NumField
              label="主侧栏间距"
              value={style.asideGap ?? 20}
              min={8}
              max={40}
              unit="px"
              onChange={(value) => onSet("asideGap", value)}
              onCommit={onCommit}
            />
            <Field label="侧栏放置模块">
              <div className="flex flex-wrap gap-1.5 pt-1">
                {modulesList.map((mod) => {
                  const asideList = style.asideModules !== undefined
                    ? style.asideModules
                    : ["skills", "summary"];
                  const isAside = asideList.includes(mod.key);
                  return (
                    <button
                      key={mod.key}
                      type="button"
                      onClick={() => {
                        const next = isAside
                          ? asideList.filter((k) => k !== mod.key)
                          : [...asideList, mod.key];
                        onSet("asideModules", next);
                        onCommit();
                      }}
                      className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                        isAside
                          ? "bg-primary text-on-primary shadow-xs"
                          : "border border-line bg-surface text-muted hover:text-ink"
                      }`}
                    >
                      {mod.label}
                    </button>
                  );
                })}
              </div>
            </Field>
          </>
        )}
        <NumField
          label="页面边距"
          value={style.pageMargin}
          min={6}
          max={25}
          unit="mm"
          onChange={(value) => onSet("pageMargin", value)}
          onCommit={onCommit}
        />
        <Field label="字体">
          <Seg
            value={style.font}
            options={[
              { value: "serif", label: "宋体" },
              { value: "sans", label: "黑体" },
            ]}
            onChange={(value) => onSet("font", value)}
          />
        </Field>
      </Group>

      <Group title="配色与正文">
        <ColorField label="强调色" value={style.accent} onChange={(value) => onSet("accent", value)} onCommit={onCommit} />
        <ColorField label="主标题色" value={style.ink} onChange={(value) => onSet("ink", value)} onCommit={onCommit} />
        <ColorField label="正文色" value={style.text} onChange={(value) => onSet("text", value)} onCommit={onCommit} />
        <ColorField label="次要信息色" value={style.muted} onChange={(value) => onSet("muted", value)} onCommit={onCommit} />
        <NumField
          label="正文字号"
          value={style.baseSize}
          min={9}
          max={14}
          step={0.5}
          unit="px"
          onChange={(value) => onSet("baseSize", value)}
          onCommit={onCommit}
        />
        <NumField
          label="行高"
          value={style.lineHeight}
          min={1.2}
          max={2}
          step={0.05}
          unit="倍"
          onChange={(value) => onSet("lineHeight", value)}
          onCommit={onCommit}
        />
      </Group>

      <Group title="页眉与顶部色块">
        <Field label="页眉形式">
          <Seg
            value={style.headerStyle ?? "default"}
            options={[
              { value: "default", label: "普通文本" },
              { value: "banner", label: "通栏色块" },
              { value: "card", label: "圆角色块" },
            ]}
            onChange={(value) => onSet("headerStyle", value)}
          />
        </Field>
        {style.headerStyle && style.headerStyle !== "default" ? (
          <ColorField
            label="色块背景色"
            value={style.headerBg || style.accent}
            onChange={(value) => onSet("headerBg", value)}
            onCommit={onCommit}
          />
        ) : (
          <>
            <Field label="分隔线">
              <Seg
                value={style.titleRule}
                options={[
                  { value: "none", label: "无" },
                  { value: "accent", label: "强调色" },
                  { value: "dark", label: "深灰" },
                ]}
                onChange={(value) => onSet("titleRule", value)}
              />
            </Field>
            {style.titleRule !== "none" && (
              <NumField
                label="分隔线粗细"
                value={style.titleRuleThickness}
                min={1}
                max={6}
                unit="px"
                onChange={(value) => onSet("titleRuleThickness", value)}
                onCommit={onCommit}
              />
            )}
          </>
        )}
        <NumField
          label="姓名字号"
          value={style.nameSize}
          min={16}
          max={40}
          unit="px"
          onChange={(value) => onSet("nameSize", value)}
          onCommit={onCommit}
        />
        <NumField
          label="姓名字重"
          value={style.nameWeight}
          min={400}
          max={900}
          step={100}
          unit=""
          onChange={(value) => onSet("nameWeight", value)}
          onCommit={onCommit}
        />
        <Field label="姓名对齐">
          <Seg
            value={style.titleAlign}
            options={[
              { value: "center", label: "居中" },
              { value: "left", label: "左对齐" },
            ]}
            onChange={(value) => onSet("titleAlign", value)}
          />
        </Field>
        <NumField
          label="姓名字距"
          value={style.nameTracking}
          min={0}
          max={8}
          step={0.5}
          unit="px"
          onChange={(value) => onSet("nameTracking", value)}
          onCommit={onCommit}
        />
        <NumField
          label="联系方式字号"
          value={style.contactSize}
          min={9}
          max={14}
          step={0.5}
          unit="px"
          onChange={(value) => onSet("contactSize", value)}
          onCommit={onCommit}
        />
        <Field label="联系方式间隔符">
          <div className="flex items-center gap-1.5">
            <div className="inline-flex rounded-lg border border-line bg-card p-0.5">
              {[
                { value: "·", label: "·" },
                { value: "|", label: "|" },
                { value: "/", label: "/" },
                { value: "•", label: "•" },
                { value: "", label: "无" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onSet("contactSeparator", opt.value);
                    onCommit();
                  }}
                  className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                    (style.contactSeparator ?? "·") === opt.value
                      ? "bg-primary text-on-primary"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <input
              type="text"
              className={`${inputCls} w-14 px-1.5 py-0.5 text-center text-xs`}
              value={style.contactSeparator ?? "·"}
              placeholder="自定义"
              onChange={(e) => onSet("contactSeparator", e.target.value)}
              onBlur={onCommit}
              title="自定义分隔符（支持留空）"
              aria-label="联系方式自定义分隔符"
            />
          </div>
        </Field>
        <NumField
          label="联系方式间距"
          value={style.contactGap ?? 8}
          min={0}
          max={32}
          step={1}
          unit="px"
          onChange={(value) => onSet("contactGap", value)}
          onCommit={onCommit}
        />
        <Field label="头像位置">
          <Seg
            value={style.headerLayout ?? "right-avatar"}
            options={[
              { value: "right-avatar", label: "靠右" },
              { value: "left-avatar", label: "靠左" },
              { value: "center-avatar", label: "流式居中" },
            ]}
            onChange={(value) => onSet("headerLayout", value)}
          />
        </Field>
        <Field label="联系方式排版">
          <Seg
            value={style.contactLayout ?? "inline"}
            options={[
              { value: "inline", label: "单行流式" },
              { value: "grid2", label: "双列对齐" },
            ]}
            onChange={(value) => onSet("contactLayout", value)}
          />
        </Field>
      </Group>

      <Group title="小节标题">
        <NumField
          label="字号"
          value={style.sectionSize}
          min={10}
          max={18}
          step={0.5}
          unit="px"
          onChange={(value) => onSet("sectionSize", value)}
          onCommit={onCommit}
        />
        <NumField
          label="字重"
          value={style.sectionWeight}
          min={400}
          max={900}
          step={100}
          unit=""
          onChange={(value) => onSet("sectionWeight", value)}
          onCommit={onCommit}
        />
        <ColorField
          label="文字颜色"
          value={style.sectionColor}
          onChange={(value) => onSet("sectionColor", value)}
          onCommit={onCommit}
        />
        <Field label="装饰">
          <Seg
            value={style.sectionDeco}
            options={[
              { value: "none", label: "无" },
              { value: "underline", label: "下划线" },
              { value: "leftbar", label: "左色条" },
              { value: "band", label: "色块" },
            ]}
            onChange={(value) => onSet("sectionDeco", value)}
          />
        </Field>
        {style.sectionDeco !== "none" && (
          <ColorField
            label="装饰颜色"
            value={style.sectionDecoColor}
            onChange={(value) => onSet("sectionDecoColor", value)}
            onCommit={onCommit}
          />
        )}
        <NumField
          label="字距"
          value={style.sectionTracking}
          min={0}
          max={8}
          step={0.5}
          unit="px"
          onChange={(value) => onSet("sectionTracking", value)}
          onCommit={onCommit}
        />
        <NumField
          label="上间距"
          value={style.sectionGapBefore}
          min={4}
          max={28}
          unit="px"
          onChange={(value) => onSet("sectionGapBefore", value)}
          onCommit={onCommit}
        />
        <NumField
          label="下间距"
          value={style.sectionGapAfter}
          min={2}
          max={16}
          unit="px"
          onChange={(value) => onSet("sectionGapAfter", value)}
          onCommit={onCommit}
        />
      </Group>

      <Group title="条目与技能">
        <NumField
          label="条目标题字号"
          value={style.entryTitleSize}
          min={11}
          max={16}
          step={0.5}
          unit="px"
          onChange={(value) => onSet("entryTitleSize", value)}
          onCommit={onCommit}
        />
        <NumField
          label="条目标题字重"
          value={style.entryTitleWeight}
          min={400}
          max={900}
          step={100}
          unit=""
          onChange={(value) => onSet("entryTitleWeight", value)}
          onCommit={onCommit}
        />
        <Field label="副标题强调">
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={style.entrySubAccent}
              onChange={(event) => onSet("entrySubAccent", event.target.checked)}
              className="accent-primary"
            />
            副标题（职位/学位）用强调色
          </label>
        </Field>
        <NumField
          label="条目间距"
          value={style.entryGap}
          min={4}
          max={20}
          unit="px"
          onChange={(value) => onSet("entryGap", value)}
          onCommit={onCommit}
        />
        <NumField
          label="列表条目间距"
          value={style.descItemGap ?? 2}
          min={0}
          max={16}
          step={0.5}
          unit="px"
          onChange={(value) => onSet("descItemGap", value)}
          onCommit={onCommit}
        />
        <Field label="技能样式">
          <Seg
            value={style.skillStyle}
            options={[
              { value: "pill", label: "标签" },
              { value: "line", label: "一行" },
              { value: "list", label: "列表" },
            ]}
            onChange={(value) => onSet("skillStyle", value)}
          />
        </Field>
        <Field label="技能展示列数">
          <Seg
            value={String(style.skillCols ?? 1) as "1" | "2" | "3"}
            options={[
              { value: "1", label: "自适应" },
              { value: "2", label: "双列" },
              { value: "3", label: "三列" },
            ]}
            onChange={(value) => onSet("skillCols", Number(value) as 1 | 2 | 3)}
          />
        </Field>
        <Field label="经历排版列数">
          <Seg
            value={String(style.entryCols ?? 1) as "1" | "2"}
            options={[
              { value: "1", label: "单列" },
              { value: "2", label: "双列网格" },
            ]}
            onChange={(value) => onSet("entryCols", Number(value) as 1 | 2)}
          />
        </Field>
      </Group>
    </>
  );
}
