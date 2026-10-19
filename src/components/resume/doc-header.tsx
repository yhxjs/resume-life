import type { CSSProperties } from "react";
import type { ResumeStyle } from "@/lib/templates";
import type { Prepared } from "./doc-data";

const DARK_RULE = "#262626"; // titleRule="dark" 的深灰分隔线（A4 纸面固定浅色，允许字面色）

function DocAvatar({
  avatar,
  size = 72,
  shape = "rounded",
  offsetX = 0,
  offsetY = 0,
  onAvatarPointerDown,
}: {
  avatar: string;
  size?: number;
  shape?: "circle" | "rounded" | "square";
  offsetX?: number;
  offsetY?: number;
  onAvatarPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const isCircle = shape === "circle";
  const avatarWidth = size;
  const avatarHeight = isCircle ? size : Math.round((size * 4) / 3);
  const borderRadius = isCircle ? "50%" : shape === "rounded" ? "6px" : "2px";
  const isInteractive = Boolean(onAvatarPointerDown);

  // 严格防护：向右偏移不能大于 0（头像默认贴右内边距，向右拖会出界；只能向左或在原位）
  const safeX = Math.min(offsetX, 0);
  const safeY = Math.min(Math.max(offsetY, -30), 30);

  return (
    <div
      data-resume-avatar="true"
      onPointerDown={onAvatarPointerDown}
      style={{
        width: avatarWidth,
        height: avatarHeight,
        borderRadius,
        transform: `translate(${safeX}px, ${safeY}px)`,
        cursor: isInteractive ? "grab" : "default",
        userSelect: "none",
        touchAction: isInteractive ? "none" : "auto",
        flexShrink: 0,
        overflow: "hidden",
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.12)",
      }}
      title={isInteractive ? "按住可拖动头像微调位置" : undefined}
      className={isInteractive ? "group relative hover:ring-2 hover:ring-blue-500/70" : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={avatar}
        alt="个人头像"
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

function DocContactLine({
  d,
  s,
  center,
  color,
  margin = 0,
}: {
  d: Prepared;
  s: ResumeStyle;
  center?: boolean;
  color?: string;
  margin?: CSSProperties["margin"];
}) {
  const parts = d.contactParts && d.contactParts.length > 0
    ? d.contactParts
    : (d.contact ? [d.contact] : []);
  const hasLinks = d.links.length > 0;
  if (parts.length === 0 && !hasLinks) return null;

  if (s.contactLayout === "grid2") {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          columnGap: 16,
          rowGap: 4,
          fontSize: s.contactSize,
          color: color || s.muted,
          lineHeight: 1.4,
          margin,
          textAlign: "left",
        }}
      >
        {parts.map((part, idx) => (
          <div key={idx} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{part}</span>
          </div>
        ))}
        {d.links.map((link, idx) => (
          <div key={`link-${idx}`} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{link}</span>
          </div>
        ))}
      </div>
    );
  }

  const sep = s.contactSeparator !== undefined ? s.contactSeparator : "·";
  const gap = s.contactGap !== undefined ? s.contactGap : 8;

  return (
    <div
      style={{
        fontSize: s.contactSize,
        color: color || s.muted,
        lineHeight: 1.4,
        margin,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: center ? "center" : "flex-start",
        rowGap: 4,
        columnGap: !sep ? gap : 0,
      }}
    >
      {parts.map((part, idx) => (
        <span key={idx} style={{ display: "inline-flex", alignItems: "center" }}>
          <span>{part}</span>
          {idx < parts.length - 1 && sep && (
            <span
              style={{
                marginLeft: `${gap / 2}px`,
                marginRight: `${gap / 2}px`,
                userSelect: "none",
              }}
            >
              {sep}
            </span>
          )}
        </span>
      ))}
      {hasLinks && (
        <>
          {parts.length > 0 && (
            <span style={{ margin: "0 8px", opacity: 0.6, userSelect: "none" }}>｜</span>
          )}
          {d.links.map((link, idx) => (
            <span key={idx} style={{ display: "inline-flex", alignItems: "center" }}>
              <span>{link}</span>
              {idx < d.links.length - 1 && (
                <span style={{ margin: "0 6px", opacity: 0.6, userSelect: "none" }}>/</span>
              )}
            </span>
          ))}
        </>
      )}
    </div>
  );
}

export function DocHeader({
  d,
  s,
  onAvatarPointerDown,
}: {
  d: Prepared;
  s: ResumeStyle;
  onAvatarPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const center = s.titleAlign === "center";
  const isBanner = s.headerStyle === "banner";
  const isCard = s.headerStyle === "card";
  const hasAvatar = Boolean(d.avatar);
  const layout = s.headerLayout ?? "right-avatar";

  const avatarNode = hasAvatar ? (
    <DocAvatar
      avatar={d.avatar!}
      size={d.avatarSize}
      shape={d.avatarShape}
      offsetX={d.avatarX}
      offsetY={d.avatarY}
      onAvatarPointerDown={onAvatarPointerDown}
    />
  ) : null;

  if (isBanner) {
    const bg = s.headerBg || s.accent;
    const isCenterLayout = layout === "center-avatar" || (layout === "right-avatar" && center);
    return (
      <div
        style={{
          margin: `-${s.pageMargin}mm -${s.pageMargin}mm 14px -${s.pageMargin}mm`,
          backgroundColor: bg,
          padding: `${s.pageMargin * 0.85}mm ${s.pageMargin}mm`,
          display: "flex",
          flexDirection: layout === "center-avatar" ? "column" : "row",
          alignItems: "center",
          justifyContent: layout === "center-avatar" ? "center" : "space-between",
          gap: 16,
          overflow: "hidden",
          breakInside: "avoid",
          pageBreakInside: "avoid",
        }}
      >
        {layout === "left-avatar" && avatarNode}
        {layout === "center-avatar" && avatarNode && <div>{avatarNode}</div>}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: isCenterLayout ? "center" : "flex-start",
            textAlign: isCenterLayout ? "center" : "left",
            gap: 6,
            flex: layout === "center-avatar" ? undefined : 1,
          }}
        >
          <h1
            style={{
              fontSize: s.nameSize,
              fontWeight: s.nameWeight,
              letterSpacing: s.nameTracking,
              color: "#ffffff",
              lineHeight: 1.2,
              margin: 0,
            }}
          >
            {d.name}
          </h1>
          <DocContactLine d={d} s={s} center={isCenterLayout} color="#ffffff" margin={0} />
        </div>
        {layout === "right-avatar" && avatarNode}
      </div>
    );
  }

  if (isCard) {
    const bg = s.headerBg || s.accent;
    const isCenterLayout = layout === "center-avatar" || (layout === "right-avatar" && center);
    return (
      <div
        style={{
          marginBottom: 16,
          backgroundColor: bg,
          borderRadius: 8,
          padding: "14px 18px",
          display: "flex",
          flexDirection: layout === "center-avatar" ? "column" : "row",
          alignItems: "center",
          justifyContent: layout === "center-avatar" ? "center" : "space-between",
          gap: 16,
          overflow: "hidden",
          breakInside: "avoid",
          pageBreakInside: "avoid",
        }}
      >
        {layout === "left-avatar" && avatarNode}
        {layout === "center-avatar" && avatarNode && <div>{avatarNode}</div>}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: isCenterLayout ? "center" : "flex-start",
            textAlign: isCenterLayout ? "center" : "left",
            gap: 6,
            flex: layout === "center-avatar" ? undefined : 1,
          }}
        >
          <h1
            style={{
              fontSize: s.nameSize,
              fontWeight: s.nameWeight,
              letterSpacing: s.nameTracking,
              color: "#ffffff",
              lineHeight: 1.2,
              margin: 0,
            }}
          >
            {d.name}
          </h1>
          <DocContactLine d={d} s={s} center={isCenterLayout} color="#ffffff" margin={0} />
        </div>
        {layout === "right-avatar" && avatarNode}
      </div>
    );
  }

  const ruleColor =
    s.titleRule === "accent" ? s.accent : s.titleRule === "dark" ? DARK_RULE : undefined;
  const nameStyle: CSSProperties = {
    fontSize: s.nameSize,
    fontWeight: s.nameWeight,
    letterSpacing: s.nameTracking,
    color: s.ink,
    lineHeight: 1.25,
    margin: 0,
  };

  // 头像文档流居中（彻底解除绝对定位重叠隐患）
  if (layout === "center-avatar") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 6,
          textAlign: "center",
          borderBottom: ruleColor ? `${s.titleRuleThickness}px solid ${ruleColor}` : undefined,
          paddingBottom: ruleColor ? 8 : undefined,
          breakInside: "avoid",
          pageBreakInside: "avoid",
        }}
      >
        {avatarNode && <div style={{ marginBottom: 4 }}>{avatarNode}</div>}
        <h1 style={nameStyle}>{d.name}</h1>
        <DocContactLine d={d} s={s} center={true} color={s.muted} margin="4px 0 0 0" />
      </div>
    );
  }

  // 头像居左
  if (layout === "left-avatar") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 16,
          borderBottom: ruleColor ? `${s.titleRuleThickness}px solid ${ruleColor}` : undefined,
          paddingBottom: ruleColor ? 8 : undefined,
          breakInside: "avoid",
          pageBreakInside: "avoid",
        }}
      >
        {avatarNode}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={nameStyle}>{d.name}</h1>
          <DocContactLine d={d} s={s} center={false} color={s.muted} margin="4px 0 0 0" />
        </div>
      </div>
    );
  }

  if (center) {
    return (
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 4,
          textAlign: "center",
          borderBottom: ruleColor ? `${s.titleRuleThickness}px solid ${ruleColor}` : undefined,
          paddingBottom: ruleColor ? 8 : undefined,
          breakInside: "avoid",
          pageBreakInside: "avoid",
        }}
      >
        <h1 style={nameStyle}>{d.name}</h1>
        <DocContactLine d={d} s={s} center={true} color={s.muted} margin="4px 0 0 0" />
        {avatarNode && (
          <div style={{ position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)" }}>
            {avatarNode}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        borderBottom: ruleColor ? `${s.titleRuleThickness}px solid ${ruleColor}` : undefined,
        paddingBottom: ruleColor ? 8 : undefined,
        breakInside: "avoid",
        pageBreakInside: "avoid",
      }}
    >
      <div>
        <h1 style={nameStyle}>{d.name}</h1>
        <DocContactLine d={d} s={s} center={false} color={s.muted} margin="4px 0 0 0" />
      </div>
      {avatarNode}
    </div>
  );
}

