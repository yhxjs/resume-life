import type { CSSProperties } from "react";
import type { ResumeStyle } from "@/lib/templates";
import { RichText } from "@/components/resume/rich-text";
import { DocHeader } from "./doc-header";
import type { Prepared, PreparedEntry, PreparedSection } from "./doc-data";

export { prepare } from "./doc-data";
export type { Prepared, PreparedEntry, PreparedSection, PreparedSubItem } from "./doc-data";

const ASIDE_BORDER = "#e2e2e2"; // 双栏侧栏分隔线（浅灰固定）

function SectionTitle({ text, s, center }: { text: string; s: ResumeStyle; center?: boolean }) {
  const base: CSSProperties = {
    fontSize: s.sectionSize,
    fontWeight: s.sectionWeight,
    letterSpacing: s.sectionTracking,
    color: s.sectionColor,
    marginTop: s.sectionGapBefore,
    marginBottom: s.sectionGapAfter,
    lineHeight: 1.4,
    breakAfter: "avoid",
    pageBreakAfter: "avoid",
  };
  if (s.sectionDeco === "underline") {
    return (
      <h2 style={{ ...base, borderBottom: `1px solid ${s.sectionDecoColor}`, paddingBottom: 4, textAlign: center ? "center" : undefined }}>
        {text}
      </h2>
    );
  }
  if (s.sectionDeco === "leftbar") {
    return <h2 style={{ ...base, borderLeft: `4px solid ${s.sectionDecoColor}`, paddingLeft: 8 }}>{text}</h2>;
  }
  if (s.sectionDeco === "band") {
    return (
      <div style={{ textAlign: center ? "center" : undefined }}>
        <h2
          style={{
            ...base,
            display: "inline-block",
            background: s.sectionDecoColor,
            color: "#ffffff",
            padding: "2px 10px",
            borderRadius: 2,
            marginTop: s.sectionGapBefore,
            marginBottom: s.sectionGapAfter,
          }}
        >
          {text}
        </h2>
      </div>
    );
  }
  return <h2 style={base}>{text}</h2>;
}

function EntryRow({
  item,
  s,
  index,
  isGridItem,
}: {
  item: PreparedEntry;
  s: ResumeStyle;
  index?: number;
  isGridItem?: boolean;
}) {
  const hasDescItems = item.descriptionItems && item.descriptionItems.length > 0;
  return (
    <div
      data-resume-entry={index}
      style={{
        marginBottom: isGridItem ? 0 : s.entryGap,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, breakAfter: "avoid", pageBreakAfter: "avoid" }}>
        <span style={{ fontSize: s.entryTitleSize, fontWeight: s.entryTitleWeight, color: s.ink }}>
          {item.title}
          {item.sub && (
            <span
              style={{
                fontSize: Math.max(10, s.entryTitleSize - 1),
                fontWeight: 400,
                marginLeft: 8,
                color: s.entrySubAccent ? s.accent : s.muted,
              }}
            >
              {item.sub}
            </span>
          )}
        </span>
        {item.period && (
          <span style={{ flexShrink: 0, fontSize: s.contactSize, color: s.muted }}>{item.period}</span>
        )}
      </div>

      {item.subItems && item.subItems.length > 0 && (
        <div style={{ marginTop: 2, display: "flex", flexDirection: "column", gap: 2 }}>
          {item.subItems.map((sub, idx) => (
            <div
              key={idx}
              style={{
                fontSize: Math.max(10, s.baseSize - 0.5),
                color: s.text,
                lineHeight: 1.4,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {sub.label && (
                <span style={{ fontWeight: 600, color: s.ink }}>{sub.label}：</span>
              )}
              <span>{sub.value}</span>
            </div>
          ))}
        </div>
      )}

      {hasDescItems ? (
        item.descriptionStyle === "ordered" ? (
          <ol
            style={{
              margin: "3px 0 0 0",
              padding: 0,
              listStyle: "none",
              color: s.text,
              fontSize: s.baseSize,
              lineHeight: s.lineHeight,
            }}
          >
            {item.descriptionItems!.map((desc, idx) => (
              <li
                key={idx}
                style={{
                  marginTop: idx === 0 ? 1 : (s.descItemGap ?? 2),
                  display: "flex",
                  alignItems: "baseline",
                  breakInside: "avoid",
                  pageBreakInside: "avoid",
                }}
              >
                <span
                  style={{
                    flexShrink: 0,
                    width: "1.1em",
                    textAlign: "left",
                  }}
                >
                  {idx + 1}.
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <RichText content={desc} />
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <ul
            style={{
              margin: "3px 0 0 0",
              padding: 0,
              listStyle: "none",
              color: s.text,
              fontSize: s.baseSize,
              lineHeight: s.lineHeight,
            }}
          >
            {item.descriptionItems!.map((desc, idx) => (
              <li
                key={idx}
                style={{
                  marginTop: idx === 0 ? 1 : (s.descItemGap ?? 2),
                  display: "flex",
                  alignItems: "baseline",
                  breakInside: "avoid",
                  pageBreakInside: "avoid",
                }}
              >
                <span
                  style={{
                    flexShrink: 0,
                    width: "1.1em",
                    textAlign: "left",
                  }}
                >
                  •
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <RichText content={desc} />
                </span>
              </li>
            ))}
          </ul>
        )
      ) : item.body ? (
        <p style={{ margin: "2px 0 0 0", whiteSpace: "pre-wrap", color: s.text }}>
          <RichText content={item.body} />
        </p>
      ) : null}
    </div>
  );
}

function SkillsBlock({ items, s }: { items: string[]; s: ResumeStyle }) {
  const cols = s.skillCols && s.skillCols > 1 ? s.skillCols : 1;
  if (s.skillStyle === "pill") {
    if (cols > 1) {
      return (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gap: 6,
          }}
        >
          {items.map((item, idx) => (
            <span
              key={item}
              data-resume-entry={idx}
              style={{
                fontSize: s.baseSize - 0.5,
                backgroundColor: `${s.accent}1f`,
                color: s.accent,
                padding: "2px 8px",
                borderRadius: 4,
                textAlign: "center",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item}
            </span>
          ))}
        </div>
      );
    }
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {items.map((item, idx) => (
          <span
            key={item}
            data-resume-entry={idx}
            style={{
              fontSize: s.baseSize - 0.5,
              backgroundColor: `${s.accent}1f`,
              color: s.accent,
              padding: "2px 8px",
              borderRadius: 4,
            }}
          >
            {item}
          </span>
        ))}
      </div>
    );
  }
  if (s.skillStyle === "list") {
    return (
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: "none",
          color: s.text,
          fontSize: s.baseSize,
          lineHeight: s.lineHeight,
          ...(cols > 1
            ? {
                display: "grid",
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                columnGap: 16,
                rowGap: s.descItemGap ?? 2,
              }
            : {}),
        }}
      >
        {items.map((item, idx) => (
          <li
            key={item}
            data-resume-entry={idx}
            style={{
              marginTop: cols > 1 ? 0 : (idx === 0 ? 1 : (s.descItemGap ?? 2)),
              display: "flex",
              alignItems: "baseline",
              breakInside: "avoid",
              pageBreakInside: "avoid",
            }}
          >
            <span
              style={{
                flexShrink: 0,
                width: "1.1em",
                textAlign: "left",
              }}
            >
              •
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <RichText content={item} />
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return <p style={{ margin: 0, color: s.text }}>{items.join(" ｜ ")}</p>;
}

function Section({ section, s, center }: { section: PreparedSection; s: ResumeStyle; center?: boolean }) {
  const isEntryGrid = section.kind === "entries" && s.entryCols === 2;
  return (
    <div data-resume-module={section.moduleKey}>
      <SectionTitle text={section.label} s={s} center={center} />
      {section.kind === "entries" && (
        isEntryGrid ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              columnGap: 16,
              rowGap: s.entryGap,
            }}
          >
            {section.items.map((it, i) => (
              <EntryRow key={i} item={it} s={s} index={i} isGridItem={true} />
            ))}
          </div>
        ) : (
          section.items.map((it, i) => <EntryRow key={i} item={it} s={s} index={i} />)
        )
      )}
      {section.kind === "skills" && <SkillsBlock items={section.items} s={s} />}
      {section.kind === "text" && (
        section.descriptionItems && section.descriptionItems.length > 0 ? (
          section.descriptionStyle === "ordered" ? (
            <ol
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                color: s.text,
                fontSize: s.baseSize,
                lineHeight: s.lineHeight,
              }}
            >
              {section.descriptionItems.map((desc, idx) => (
                <li
                  key={idx}
                  data-resume-entry={idx}
                  style={{
                    marginTop: idx === 0 ? 1 : (s.descItemGap ?? 2),
                    display: "flex",
                    alignItems: "baseline",
                    breakInside: "avoid",
                    pageBreakInside: "avoid",
                  }}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      width: "1.1em",
                      textAlign: "left",
                    }}
                  >
                    {idx + 1}.
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <RichText content={desc} />
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <ul
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                color: s.text,
                fontSize: s.baseSize,
                lineHeight: s.lineHeight,
              }}
            >
              {section.descriptionItems.map((desc, idx) => (
                <li
                  key={idx}
                  data-resume-entry={idx}
                  style={{
                    marginTop: idx === 0 ? 1 : (s.descItemGap ?? 2),
                    display: "flex",
                    alignItems: "baseline",
                    breakInside: "avoid",
                    pageBreakInside: "avoid",
                  }}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      width: "1.1em",
                      textAlign: "left",
                    }}
                  >
                    •
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <RichText content={desc} />
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p data-resume-entry={0} style={{ margin: 0, whiteSpace: "pre-wrap", color: s.text }}>
            <RichText content={section.text} />
          </p>
        )
      )}
      {section.kind === "contact" && (
        <p data-resume-entry={0} style={{ margin: 0, whiteSpace: "pre-wrap", color: s.text }}>
          {section.lines.join(" ｜ ")}
        </p>
      )}
    </div>
  );
}

function SingleBody({
  d,
  s,
  onAvatarPointerDown,
}: {
  d: Prepared;
  s: ResumeStyle;
  onAvatarPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const center = s.titleAlign === "center";
  return (
    <div>
      <div data-resume-module={d.basicModuleKey || "basic"}>
        <DocHeader d={d} s={s} onAvatarPointerDown={onAvatarPointerDown} />
      </div>
      {d.sections.map((sec, i) => (
        <Section key={i} section={sec} s={s} center={center} />
      ))}
    </div>
  );
}

function splitTwoColSections(sections: PreparedSection[], asideModules?: string[]) {
  if (asideModules && asideModules.length > 0) {
    const asideSet = new Set(asideModules);
    const aside = sections.filter((sec) => asideSet.has(sec.moduleKey) || asideSet.has(sec.kind));
    const main = sections.filter((sec) => !asideSet.has(sec.moduleKey) && !asideSet.has(sec.kind));
    return { main, aside };
  }
  return {
    main: sections.filter((sec) => sec.kind === "entries"),
    aside: sections.filter((sec) => sec.kind !== "entries"),
  };
}

function TwoColBody({
  d,
  s,
  onAvatarPointerDown,
}: {
  d: Prepared;
  s: ResumeStyle;
  onAvatarPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const { main, aside } = splitTwoColSections(d.sections, s.asideModules);
  const isLeftAside = s.asidePosition === "left";
  const columns = isLeftAside
    ? `${s.asideWidth}mm 1fr`
    : `1fr ${s.asideWidth}mm`;
  const gap = s.asideGap ?? 20;

  const effectiveBorder =
    !s.asideBorder || s.asideBorder === "auto"
      ? (isLeftAside ? "right" : "left")
      : s.asideBorder;
  const borderColor = s.asideBorderColor || ASIDE_BORDER;
  const borderLeft =
    effectiveBorder === "left" || effectiveBorder === "both"
      ? `1px solid ${borderColor}`
      : undefined;
  const borderRight =
    effectiveBorder === "right" || effectiveBorder === "both"
      ? `1px solid ${borderColor}`
      : undefined;

  const asidePadding = s.asidePadding ?? 16;
  const asideStyle: CSSProperties = {
    backgroundColor: s.asideBg || undefined,
    borderLeft,
    borderRight,
    borderRadius: s.asideBg ? 4 : undefined,
    ...(s.asideBg
      ? { padding: `${asidePadding}px` }
      : {
          paddingLeft: borderLeft ? `${asidePadding}px` : undefined,
          paddingRight: borderRight ? `${asidePadding}px` : undefined,
        }),
  };

  const asideNode = (
    <aside style={asideStyle}>
      {aside.map((sec, i) => (
        <Section key={i} section={sec} s={s} />
      ))}
    </aside>
  );

  const mainNode = (
    <div>
      {main.map((sec, i) => (
        <Section key={i} section={sec} s={s} />
      ))}
    </div>
  );

  return (
    <div>
      <div data-resume-module={d.basicModuleKey || "basic"}>
        <DocHeader d={d} s={s} onAvatarPointerDown={onAvatarPointerDown} />
      </div>
      <div
        style={{
          marginTop: 8,
          display: "grid",
          gridTemplateColumns: columns,
          gap,
        }}
      >
        {isLeftAside ? (
          <>
            {asideNode}
            {mainNode}
          </>
        ) : (
          <>
            {mainNode}
            {asideNode}
          </>
        )}
      </div>
    </div>
  );
}

/** A4 纸上的完整简历文档：页面边距、基准字号、行高、正文色由样式参数控制 */
export function ResumeDoc({
  prepared,
  style: s,
  onAvatarPointerDown,
}: {
  prepared: Prepared;
  style: ResumeStyle;
  onAvatarPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={s.font === "serif" ? "font-serif" : undefined}
      style={{
        padding: `${s.pageMargin}mm`,
        fontSize: s.baseSize,
        lineHeight: s.lineHeight,
        color: s.text,
      }}
    >
      {s.layout === "twocol" ? (
        <TwoColBody d={prepared} s={s} onAvatarPointerDown={onAvatarPointerDown} />
      ) : (
        <SingleBody d={prepared} s={s} onAvatarPointerDown={onAvatarPointerDown} />
      )}
    </div>
  );
}
