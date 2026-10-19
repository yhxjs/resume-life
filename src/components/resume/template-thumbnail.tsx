"use client";

import type { ResumeStyle } from "@/lib/templates";

/**
 * 模板微缩排版骨架：
 * 根据模板的实际布局、字体对齐、标题装饰类型、强调色等真实参数，
 * 渲染逼真的微缩版简历排版线框，直观传达模板视觉骨架。
 *
 * 从 template-picker.tsx 拆出来单独成文件：它是纯展示组件，不含任何状态与
 * 事件，却占了选择器近三分之一的体量，混在一起时真正需要读的逻辑（筛选、
 * 选中态、弹窗焦点）要翻过两百多行 JSX 才找得到。
 */
export function TemplateThumbnail({
  style,
  accentColor,
}: {
  style: ResumeStyle;
  accentColor: string;
}) {
  const isTwocol = style.layout === "twocol";
  const isLeftAside = style.asidePosition === "left";
  const isCenter = style.titleAlign === "center" || style.headerLayout === "center-avatar";
  const isLeftAvatar = style.headerLayout === "left-avatar";
  const isBanner = style.headerStyle === "banner";
  const isCard = style.headerStyle === "card";
  const deco = style.sectionDeco;
  const headerBg = style.headerBg || accentColor;
  const asideBg = style.asideBg;

  const asideContent = (
    <div
      className="flex w-[34%] flex-col gap-2 rounded p-1.5"
      style={{
        backgroundColor: asideBg || "rgba(245, 245, 245, 0.9)",
      }}
    >
      {/* 头像/基本信息骨架 */}
      {!isBanner && !isCard && (
        <div className="space-y-1">
          <div
            className="h-2 w-10 rounded-sm"
            style={{ backgroundColor: accentColor }}
          />
          <div className="h-1 w-full rounded-sm bg-neutral-300 dark:bg-neutral-700" />
          <div className="h-1 w-4/5 rounded-sm bg-neutral-300 dark:bg-neutral-700" />
        </div>
      )}
      {/* 侧栏小节 */}
      <div className="mt-1 space-y-1">
        <div
          className="h-1.5 w-8 rounded-sm"
          style={{ backgroundColor: accentColor }}
        />
        {style.skillStyle === "pill" ? (
          <div className="flex flex-wrap gap-0.5">
            <span
              className="h-1.5 w-4 rounded-full"
              style={{ backgroundColor: `${accentColor}33` }}
            />
            <span
              className="h-1.5 w-5 rounded-full"
              style={{ backgroundColor: `${accentColor}33` }}
            />
            <span
              className="h-1.5 w-3.5 rounded-full"
              style={{ backgroundColor: `${accentColor}33` }}
            />
          </div>
        ) : (
          <div className="space-y-0.5">
            <div className="h-1 w-full rounded-sm bg-neutral-300 dark:bg-neutral-700" />
            <div className="h-1 w-3/4 rounded-sm bg-neutral-300 dark:bg-neutral-700" />
          </div>
        )}
      </div>
    </div>
  );

  const mainContent = (
    <div className="flex flex-1 flex-col gap-2">
      {!isBanner && !isCard && (
        <div className="space-y-1 border-b border-line/60 pb-1">
          <div className="h-2.5 w-16 rounded-sm bg-neutral-800 dark:bg-neutral-200" />
          <div className="h-1 w-24 rounded-sm bg-neutral-400 dark:bg-neutral-600" />
        </div>
      )}
      {/* 主栏经历条目 */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          {deco === "leftbar" && (
            <span
              className="h-2 w-0.5 rounded-full"
              style={{ backgroundColor: accentColor }}
            />
          )}
          <div
            className="h-1.5 w-12 rounded-sm"
            style={{ backgroundColor: accentColor }}
          />
        </div>
        {style.entryCols === 2 ? (
          <div className="grid grid-cols-2 gap-1 pl-0.5">
            <div className="space-y-0.5">
              <div className="h-1 w-full rounded-sm bg-neutral-300 dark:bg-neutral-700" />
              <div className="h-1 w-4/5 rounded-sm bg-neutral-200 dark:bg-neutral-800" />
            </div>
            <div className="space-y-0.5">
              <div className="h-1 w-full rounded-sm bg-neutral-300 dark:bg-neutral-700" />
              <div className="h-1 w-4/5 rounded-sm bg-neutral-200 dark:bg-neutral-800" />
            </div>
          </div>
        ) : (
          <div className="space-y-0.5 pl-0.5">
            <div className="h-1 w-full rounded-sm bg-neutral-300 dark:bg-neutral-700" />
            <div className="h-1 w-5/6 rounded-sm bg-neutral-200 dark:bg-neutral-800" />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="relative aspect-[1/1.25] w-full select-none overflow-hidden rounded-lg border border-line/70 bg-white p-3 shadow-inner dark:bg-neutral-900 flex flex-col">
      {/* 顶部色块通栏横幅 Banner */}
      {isBanner && (
        <div
          className="-mx-3 -mt-3 mb-2 flex flex-col justify-center px-3 py-2"
          style={{ backgroundColor: headerBg }}
        >
          <div
            className={`flex flex-col gap-1 ${
              isCenter ? "items-center" : isLeftAvatar ? "items-start pl-4" : "items-start"
            }`}
          >
            <div className="h-2 w-14 rounded-xs bg-white" />
            <div className="h-1 w-24 rounded-xs bg-white/70" />
          </div>
        </div>
      )}

      {/* 悬浮圆角色块卡片 Card */}
      {isCard && (
        <div
          className="mb-2 flex flex-col justify-center rounded px-2.5 py-1.5"
          style={{ backgroundColor: headerBg }}
        >
          <div
            className={`flex flex-col gap-1 ${
              isCenter ? "items-center" : isLeftAvatar ? "items-start pl-4" : "items-start"
            }`}
          >
            <div className="h-2 w-14 rounded-xs bg-white" />
            <div className="h-1 w-20 rounded-xs bg-white/70" />
          </div>
        </div>
      )}

      {isTwocol ? (
        <div className="flex h-full gap-2">
          {isLeftAside ? (
            <>
              {asideContent}
              {mainContent}
            </>
          ) : (
            <>
              {mainContent}
              {asideContent}
            </>
          )}
        </div>
      ) : (
        /* 单栏排版 */
        <div className="flex h-full flex-col gap-2">
          {/* 页眉（非 Banner / Card 模式） */}
          {!isBanner && !isCard && (
            <div
              className={`flex flex-col gap-1 pb-1.5 ${
                isCenter ? "items-center text-center" : isLeftAvatar ? "items-start pl-3" : "items-start"
              } ${style.titleRule !== "none" ? "border-b" : ""}`}
              style={{
                borderColor:
                  style.titleRule === "accent" ? accentColor : "rgba(120,120,120,0.3)",
              }}
            >
              <div className="h-3 w-16 rounded-sm bg-neutral-900 dark:bg-neutral-100" />
              <div className="h-1 w-28 rounded-sm bg-neutral-400 dark:bg-neutral-600" />
            </div>
          )}

          {/* 小节 1 */}
          <div className="space-y-1">
            <div
              className={`flex items-center gap-1 ${
                isCenter ? "justify-center" : "justify-start"
              }`}
            >
              {deco === "leftbar" && (
                <span
                  className="h-2 w-0.5 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
              )}
              {deco === "band" ? (
                <div
                  className="rounded-xs px-1.5 py-0.5"
                  style={{ backgroundColor: style.sectionDecoColor || accentColor }}
                >
                  <div className="h-1.5 w-10 rounded-xs bg-white" />
                </div>
              ) : (
                <div
                  className="h-1.5 w-12 rounded-sm"
                  style={{
                    backgroundColor: accentColor,
                    borderBottom:
                      deco === "underline"
                        ? `1px solid ${style.sectionDecoColor || accentColor}`
                        : undefined,
                  }}
                />
              )}
            </div>
            {style.entryCols === 2 ? (
              <div className="grid grid-cols-2 gap-1.5">
                <div className="space-y-0.5">
                  <div className="h-1 w-12 rounded-sm bg-neutral-700 dark:bg-neutral-300" />
                  <div className="h-1 w-full rounded-sm bg-neutral-300 dark:bg-neutral-700" />
                </div>
                <div className="space-y-0.5">
                  <div className="h-1 w-12 rounded-sm bg-neutral-700 dark:bg-neutral-300" />
                  <div className="h-1 w-full rounded-sm bg-neutral-300 dark:bg-neutral-700" />
                </div>
              </div>
            ) : (
              <div className="space-y-0.5">
                <div className="flex justify-between">
                  <div className="h-1 w-14 rounded-sm bg-neutral-700 dark:bg-neutral-300" />
                  <div className="h-1 w-8 rounded-sm bg-neutral-300 dark:bg-neutral-700" />
                </div>
                <div className="h-1 w-full rounded-sm bg-neutral-300 dark:bg-neutral-700" />
                <div className="h-1 w-4/5 rounded-sm bg-neutral-200 dark:bg-neutral-800" />
              </div>
            )}
          </div>

          {/* 小节 2：技能标签或经历 */}
          <div className="mt-0.5 space-y-1">
            <div
              className={`flex items-center gap-1 ${
                isCenter ? "justify-center" : "justify-start"
              }`}
            >
              {deco === "leftbar" && (
                <span
                  className="h-2 w-0.5 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
              )}
              {deco === "band" ? (
                <div
                  className="rounded-xs px-1.5 py-0.5"
                  style={{ backgroundColor: style.sectionDecoColor || accentColor }}
                >
                  <div className="h-1.5 w-8 rounded-xs bg-white" />
                </div>
              ) : (
                <div
                  className="h-1.5 w-10 rounded-sm"
                  style={{
                    backgroundColor: accentColor,
                    borderBottom:
                      deco === "underline"
                        ? `1px solid ${style.sectionDecoColor || accentColor}`
                        : undefined,
                  }}
                />
              )}
            </div>
            {style.skillStyle === "pill" ? (
              <div className="flex flex-wrap gap-1">
                <span
                  className="h-2 w-6 rounded-full"
                  style={{ backgroundColor: `${accentColor}26` }}
                />
                <span
                  className="h-2 w-8 rounded-full"
                  style={{ backgroundColor: `${accentColor}26` }}
                />
                <span
                  className="h-2 w-5 rounded-full"
                  style={{ backgroundColor: `${accentColor}26` }}
                />
                <span
                  className="h-2 w-7 rounded-full"
                  style={{ backgroundColor: `${accentColor}26` }}
                />
              </div>
            ) : (
              <div className="space-y-0.5">
                <div className="h-1 w-full rounded-sm bg-neutral-300 dark:bg-neutral-700" />
                <div className="h-1 w-2/3 rounded-sm bg-neutral-200 dark:bg-neutral-800" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
